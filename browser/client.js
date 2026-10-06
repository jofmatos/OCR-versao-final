import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import { createWorker, OEM, PSM } from "tesseract.js";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PaddleClient } from "./paddle-client.js";
import { MacVision } from "./mac-vision.js";
import { NeuralClient } from "./neural-client.js";
import { devicePolicy, compatibleEngine } from "./device-policy.js";

const asset = (path) => new URL(`../${path}`, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = asset("vendor/pdf/pdf.worker.min.mjs");
const LANGUAGES = [
  { code: "por", label: "Português" },
  { code: "eng", label: "Inglês" },
  { code: "spa", label: "Espanhol" },
];
const TTL = 24 * 60 * 60 * 1000;
const clone = (value) => structuredClone(value);
const modelStatus = (text) => {
  const node = document.getElementById("modelStatus");
  if (node) node.textContent = text;
};
const modelStateChanged = () => window.dispatchEvent(new Event("lume-model-state"));
const neuralName = document.getElementById("neuralPanel")?.dataset.modelLabel || "OCR de documentos";

function failure(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("lume-documents-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure("O navegador não permitiu salvar a sessão local. Confira o espaço e as permissões de armazenamento."));
  });
}

async function storage(operation, value) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("documents", operation === "get" ? "readonly" : "readwrite");
      const store = transaction.objectStore("documents");
      const request = operation === "get" ? store.get(value) : operation === "delete" ? store.delete(value) : store.put(value);
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(failure("Não foi possível salvar no navegador. Libere espaço no dispositivo e tente novamente."));
      transaction.onabort = () => reject(failure("A gravação da sessão local foi interrompida."));
    });
  } finally { database.close(); }
}

async function removeExpired() {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("documents", "readwrite");
      const request = transaction.objectStore("documents").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (Date.now() - cursor.value.updated_at > TTL) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = resolve;
      transaction.onerror = reject;
    });
  } finally { database.close(); }
}

async function loadPdf(file) {
  let loading;
  try {
    loading = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,
      enableXfa: false,
      cMapUrl: asset("vendor/pdf/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: asset("vendor/pdf/standard_fonts/"),
      wasmUrl: asset("vendor/pdf/wasm/"),
    });
    return await loading.promise;
  } catch (error) {
    if (loading) await loading.destroy().catch(() => {});
    if (error.name === "PasswordException") throw failure("Este PDF está protegido por senha. Remova a senha antes de abrir.");
    throw failure("Não foi possível abrir o PDF. Verifique se o arquivo está íntegro.");
  }
}

function pageSelection(value, count) {
  if (!value.trim()) return Array.from({ length: count }, (_, index) => index + 1);
  const selected = new Set();
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw failure("Informe as páginas como 1-3, 5.");
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > count) {
      throw failure(`Escolha páginas entre 1 e ${count}.`);
    }
    for (let number = first; number <= last; number++) selected.add(number);
  }
  return [...selected].sort((a, b) => a - b);
}

async function renderPage(pdf, number, { preview = false, quality = "high" } = {}) {
  const page = await pdf.getPage(number);
  const natural = page.getViewport({ scale: 1 });
  const { pixelLimit } = devicePolicy(navigator, window.isSecureContext);
  const scale = preview ? Math.min(2, 1400 / Math.max(natural.width, natural.height)) :
    Math.min((quality === "high" ? 350 : 250) / 72, Math.sqrt(pixelLimit / (natural.width * natural.height)), 14000 / Math.max(natural.width, natural.height));
  if (!(scale > 0) || !Number.isFinite(scale)) throw failure("Esta página não tem dimensões válidas.");
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { willReadFrequently: !preview });
  await page.render({ canvasContext: context, viewport, background: "rgb(255,255,255)" }).promise;
  if (!preview) {
    // Grayscale and robust contrast, retaining a small tail of pixels to avoid
    // amplifying isolated scan noise. All pixels stay in this browser.
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < image.data.length; i += 4) {
      const gray = Math.round(image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114);
      image.data[i] = gray;
      histogram[gray]++;
    }
    const cutoff = canvas.width * canvas.height * 0.003;
    let lower = 0, upper = 255, total = 0;
    while (lower < 255 && total + histogram[lower] < cutoff) total += histogram[lower++];
    total = 0;
    while (upper > lower && total + histogram[upper] < cutoff) total += histogram[upper--];
    for (let i = 0; i < image.data.length; i += 4) {
      const gray = upper > lower ? Math.max(0, Math.min(255, (image.data[i] - lower) * 255 / (upper - lower))) : image.data[i];
      image.data[i] = image.data[i + 1] = image.data[i + 2] = gray;
    }
    context.putImageData(image, 0, 0);
  }
  return canvas;
}

async function nativeText(page) {
  const content = await page.getTextContent();
  const lines = [];
  let line = [], previousY = null, previousHeight = 0;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform[5];
    if (previousY !== null && Math.abs(y - previousY) > Math.max(2, previousHeight * 0.45) && line.length) {
      lines.push(line.join(" "));
      line = [];
    }
    if (item.str.trim()) line.push(item.str.trim());
    previousY = y;
    previousHeight = item.height || 12;
    if (item.hasEOL && line.length) { lines.push(line.join(" ")); line = []; }
  }
  if (line.length) lines.push(line.join(" "));
  return lines.join("\n").trim();
}

class BrowserClient {
  record = null;
  pdf = null;
  worker = null;
  workerLanguage = null;
  workerPromise = null;
  paddle = null;
  paddlePromise = null;
  vision = null;
  visionPromise = null;
  neural = null;
  neuralPromise = null;
  preferredEngine = (() => { try { return localStorage.getItem("lume-ocr-engine") || "tesseract"; } catch { return "tesseract"; } })();
  get device() { return devicePolicy(navigator, window.isSecureContext); }
  get engineAvailability() { return { neural: this.device.neuralReason, vision: this.device.visionReason }; }
  engine = compatibleEngine(this.preferredEngine, this.device);
  previews = new Map();
  generation = 0;

  async recordFor(id) {
    if (this.record?.id === id) return this.record;
    const record = await storage("get", id);
    if (!record || Date.now() - record.updated_at > TTL) {
      if (record) await storage("delete", id);
      throw failure("Documento não encontrado ou expirado. Abra o PDF novamente.", 404);
    }
    if (record.doc.status === "processing") {
      record.doc.status = "error";
      record.doc.error = "A página foi fechada durante a extração. Inicie a conversão novamente.";
    }
    this.record = record;
    this.pdf = await loadPdf(record.file);
    return record;
  }

  async persist(record) { await storage("put", record); }

  async ensureWorker(language) {
    const codes = language.split("+");
    if (codes.some((code) => !LANGUAGES.some((item) => item.code === code))) throw failure("Selecione um idioma de OCR disponível.");
    if (this.worker && this.workerLanguage === language) return this.worker;
    if (this.workerPromise) {
      await this.workerPromise;
      return this.workerLanguage === language ? this.worker : this.ensureWorker(language);
    }
    if (this.worker) await this.worker.terminate();
    this.worker = null;
    this.workerLanguage = null;
    this.workerPromise = (async () => {
      modelStatus("Preparando OCR neste dispositivo… O primeiro uso baixa os modelos.");
      const worker = await createWorker(language, OEM.LSTM_ONLY, {
        workerPath: asset("vendor/tesseract/worker.min.js"),
        corePath: asset("vendor/tesseract/core"),
        langPath: asset("models"),
        gzip: true,
        workerBlobURL: false,
        cachePath: "lume-tessdata-best-int-1.0.0-v1",
        cacheMethod: "write",
        logger: (message) => {
          const labels = {
            "loading tesseract core": "Carregando o motor de OCR",
            "initializing tesseract": "Iniciando o OCR local",
            "loading language traineddata": "Preparando os modelos do idioma",
            "initializing api": "Preparando o reconhecimento",
            "recognizing text": "Reconhecendo texto no seu computador",
          };
          const label = labels[message.status] || "Preparando OCR";
          const percent = Math.round((message.progress || 0) * 100);
          modelStatus(`${label} · ${percent}%`);
          if (this.record?.doc.status === "processing") this.record.doc.progress.message = `${label} · ${percent}%`;
        },
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: "1" });
      this.worker = worker;
      this.workerLanguage = language;
      modelStatus("OCR pronto neste dispositivo. Modelos guardados no navegador.");
      return worker;
    })();
    modelStateChanged();
    try { return await this.workerPromise; }
    catch { throw failure("Não foi possível preparar o OCR local. Confira a conexão e o espaço do navegador e tente novamente."); }
    finally { this.workerPromise = null; modelStateChanged(); }
  }

  async install(language = "por+eng") { return this.ensureWorker(language); }

  async ensurePaddle() {
    if (this.paddlePromise) return this.paddlePromise;
    if (this.paddle?.alive) return this.paddle;
    this.paddle = null;
    modelStatus("Preparando OCR avançado… Carregando o motor neste navegador.");
    const paddle = new PaddleClient((message) => {
      modelStatus(message);
      if (this.record?.doc.status === "processing") this.record.doc.progress.message = message;
    });
    this.paddlePromise = (async () => {
      try {
        await paddle.request("init");
        this.paddle = paddle;
        modelStatus("PaddleOCR pronto neste dispositivo. Modelos salvos para uso offline.");
        return paddle;
      } catch (error) {
        paddle.terminate();
        throw failure(`Não foi possível instalar o PaddleOCR. Confira a conexão e o espaço do navegador. ${error.message}`);
      } finally { this.paddlePromise = null; modelStateChanged(); }
    })();
    modelStateChanged();
    return this.paddlePromise;
  }

  async installAdvanced() {
    await this.ensurePaddle();
    this.engine = "paddle";
    try { localStorage.setItem("lume-ocr-engine", "paddle"); } catch { /* Model remains ready in this session. */ }
  }

  async ensureVision(recheck = false) {
    if (this.device.visionReason) throw failure(this.device.visionReason);
    if (this.visionPromise) return this.visionPromise;
    if (this.vision && !recheck) return this.vision;
    this.vision?.terminate(); this.vision = null;
    const vision = new MacVision();
    modelStatus("Conectando ao Apple Vision neste Mac…");
    this.visionPromise = (async () => {
      try {
        await vision.connect(); this.vision = vision;
        modelStatus("Apple Vision conectado. O OCR será feito no seu Mac.");
        return vision;
      } finally { this.visionPromise = null; modelStateChanged(); }
    })();
    modelStateChanged();
    return this.visionPromise;
  }

  async ensureNeural() {
    if (this.device.neuralReason) throw failure(this.device.neuralReason);
    if (this.neuralPromise) return this.neuralPromise;
    if (this.neural?.alive) return this.neural;
    modelStatus(`Preparando ${neuralName}… Verificando o navegador.`);
    if (!window.isSecureContext || !navigator.gpu) throw failure(`${neuralName} precisa de WebGPU. Use uma versão atual do Chrome com aceleração gráfica, ou selecione outro motor.`);
    const neural = new NeuralClient((event) => {
      modelStatus(event.message);
      if (this.record?.doc.status === "processing") this.record.doc.progress.message = event.message;
      const bar = document.getElementById("neuralProgress");
      if (bar) { bar.hidden = Boolean(event.ready); if (event.total && Number.isFinite(event.loaded)) bar.value = Math.min(100, event.loaded / event.total * 100); else bar.removeAttribute("value"); }
    });
    this.neural = neural;
    this.neuralPromise = (async () => {
      try {
        if (this.worker) { await this.worker.terminate(); this.worker = null; this.workerLanguage = null; }
        this.paddle?.terminate(); this.paddle = null;
        await neural.request("init"); return neural;
      }
      catch (error) { neural.terminate(); if (this.neural === neural) this.neural = null; throw failure(`Não foi possível preparar o ${neuralName}. ${error.message}`); }
      finally { this.neuralPromise = null; const bar = document.getElementById("neuralProgress"); if (bar) bar.hidden = true; modelStateChanged(); }
    })();
    modelStateChanged();
    return this.neuralPromise;
  }

  async preview(id, number) {
    const record = await this.recordFor(id);
    if (number < 1 || number > record.doc.page_count) throw failure("Página não encontrada.", 404);
    if (this.previews.has(number)) return this.previews.get(number);
    const canvas = await renderPage(this.pdf, number, { preview: true });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    canvas.width = canvas.height = 0;
    if (!blob) throw failure("Não foi possível criar a prévia.");
    const url = URL.createObjectURL(blob);
    // Keep previews bounded for large documents, without discarding the current
    // image while the UI is still using it.
    if (this.previews.size >= 4) {
      const oldest = this.previews.keys().next().value;
      URL.revokeObjectURL(this.previews.get(oldest));
      this.previews.delete(oldest);
    }
    this.previews.set(number, url);
    return url;
  }

  async process(record, options, selected, epoch) {
    const stillActive = () => this.generation === epoch && this.record === record;
    try {
      for (const number of selected) {
        if (!stillActive()) return;
        const page = await this.pdf.getPage(number);
        let text = await nativeText(page), method = "native", confidence = null;
        const warnings = [];
        const compact = text.replace(/\s/g, "");
        let scanned = !compact.length || /\ufffd|\(cid:/.test(text);
        if (compact.length < 160) {
          const operations = await page.getOperatorList();
          const images = operations.fnArray.some((id) => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject].includes(id));
          scanned = images || (Boolean(compact.length) && scanned);
        }
        if (options.mode === "ocr" || scanned) {
          const advanced = options.engine === "paddle";
          const mac = options.engine === "vision";
          const neural = options.engine === "neural";
          const worker = neural ? await this.ensureNeural() : mac ? await this.ensureVision() : advanced ? await this.ensurePaddle() : await this.ensureWorker(options.language);
          if (!stillActive()) return;
          const canvas = await renderPage(this.pdf, number, { quality: options.quality });
          try {
            if (mac) modelStatus("Reconhecendo texto com Apple Vision no seu Mac…");
            const result = neural ? await worker.recognize(canvas, options.quality) : mac ? await worker.recognize(canvas, options.language) : advanced ? await worker.recognize(canvas, options.quality) :
              (await worker.recognize(canvas, { rotateAuto: true }, { text: true, blocks: false })).data;
            text = result.text.trim();
            confidence = Number.isFinite(result.confidence) ? Math.round(result.confidence * 10) / 10 : null;
            method = "ocr";
            if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
            if (confidence !== null && confidence < 65) warnings.push("Baixa confiança do OCR. Confira a transcrição com o original.");
          } finally { canvas.width = canvas.height = 0; }
        }
        if (!stillActive()) return;
        if (!text) warnings.push("Nenhum texto encontrado nesta página. Confira o original.");
        record.doc.pages.push({ number, text, method, confidence, warnings, engine: method === "ocr" ? options.engine : null });
        record.doc.progress.completed = record.doc.pages.length;
        record.doc.progress.message = "Lendo seu documento no navegador…";
        record.updated_at = Date.now();
        await this.persist(record);
        page.cleanup();
      }
      if (!stillActive()) return;
      record.doc.status = "ready";
      record.updated_at = Date.now();
      await this.persist(record);
      modelStatus(!record.doc.pages.some((page) => page.method === "ocr") ? "Texto lido diretamente do PDF, no seu computador." : options.engine === "neural" ? `Extração concluída com ${neuralName} neste aparelho. Confira o texto com o original.` : options.engine === "vision" ? "Extração concluída com Apple Vision no seu Mac." : options.engine === "paddle" ? "PaddleOCR pronto neste dispositivo. Modelos salvos para uso offline." : "OCR básico pronto neste dispositivo. Modelos guardados no navegador.");
    } catch (error) {
      if (!stillActive()) return;
      if (options.engine === "vision") { this.vision?.terminate(); this.vision = null; }
      if (options.engine === "neural") { this.neural?.terminate(); this.neural = null; }
      record.doc.status = "error";
      record.doc.error = error.message || "Não foi possível processar este PDF. Tente a qualidade padrão ou menos páginas.";
      try { await this.persist(record); } catch { /* Retain the error in memory. */ }
    }
  }

  async export(id, format) {
    const { doc } = await this.recordFor(id);
    if (doc.status !== "ready") throw failure("Conclua a extração antes de baixar.", 409);
    if (format === "txt") return new Blob([doc.pages.map((page) => page.text.trim()).join("\n\n") + "\n"], { type: "text/plain;charset=utf-8" });
    if (format !== "docx") throw failure("Formato de download inválido.");
    const children = [];
    for (let index = 0; index < doc.pages.length; index++) {
      const paragraphs = doc.pages[index].text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "").split(/\n\s*\n/);
      paragraphs.forEach((text, paragraphIndex) => children.push(new Paragraph({
        pageBreakBefore: index > 0 && paragraphIndex === 0,
        children: text.split("\n").map((line, lineIndex) => new TextRun({ text: line, break: lineIndex ? 1 : 0 })),
      })));
    }
    return Packer.toBlob(new Document({
      title: doc.name.replace(/\.pdf$/i, ""), creator: "Lume OCR",
      styles: { default: { document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { after: 160 } } } } },
      sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
    }));
  }

  async request(path, options = {}) {
    const method = options.method || "GET";
    if (path === "/api/health") {
      await removeExpired();
      return { status: "ok", runtime: "browser", ocr_available: Boolean(globalThis.WebAssembly && globalThis.Worker), languages: LANGUAGES, limits: { max_upload_mb: 50, max_pages: 200 } };
    }
    if (path === "/api/documents" && method === "POST") {
      const file = options.body.get("file");
      if (!(file instanceof Blob) || !file.size || file.size > 50 * 1024 * 1024) throw failure("Escolha um PDF válido com até 50 MB.");
      if (!new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer()).includes("%PDF-")) throw failure("Escolha um arquivo PDF válido.");
      const pdf = await loadPdf(file);
      if (pdf.numPages > 200) { await pdf.loadingTask.destroy(); throw failure("Escolha um PDF com até 200 páginas."); }
      const id = crypto.randomUUID().replaceAll("-", "");
      const record = { id, file, updated_at: Date.now(), doc: {
        id, name: file.name || "Documento.pdf", page_count: pdf.numPages, size: file.size, created_at: new Date().toISOString(),
        status: "uploaded", pages: [], error: null, progress: { completed: 0, total: pdf.numPages },
      } };
      try { await this.persist(record); }
      catch (error) { await pdf.loadingTask.destroy(); throw error; }
      this.record = record;
      this.pdf = pdf;
      return clone(record.doc);
    }
    const match = /^\/api\/documents\/([a-f0-9]{32})(?:\/(convert|text))?$/.exec(path);
    if (!match) throw failure("Operação desconhecida.", 404);
    const record = await this.recordFor(match[1]);
    if (method === "DELETE") {
      await storage("delete", record.id);
      this.generation++;
      this.record = null;
      const pdf = this.pdf;
      this.pdf = null;
      if (this.worker) { await this.worker.terminate(); this.worker = null; this.workerLanguage = null; }
      if (this.paddle) { this.paddle.terminate(); this.paddle = null; }
      if (this.vision) { this.vision.terminate(); this.vision = null; }
      if (this.neural) { this.neural.terminate(); this.neural = null; }
      if (pdf) await pdf.loadingTask.destroy().catch(() => {});
      for (const url of this.previews.values()) URL.revokeObjectURL(url);
      this.previews.clear();
      return null;
    }
    if (match[2] === "convert" && method === "POST") {
      if (record.doc.status === "processing") throw failure("Este documento já está em processamento.", 409);
      const settings = JSON.parse(options.body);
      settings.engine = this.engine;
      if (!["auto", "ocr"].includes(settings.mode) || !["high", "standard"].includes(settings.quality)) throw failure("Confira as opções de extração.");
      const selected = pageSelection(settings.pages || "", record.doc.page_count);
      record.doc.status = "processing";
      record.doc.pages = [];
      record.doc.error = null;
      record.doc.progress = { completed: 0, total: selected.length, message: "Preparando leitura local…" };
      record.updated_at = Date.now();
      await this.persist(record);
      const epoch = ++this.generation;
      void this.process(record, settings, selected, epoch);
    } else if (match[2] === "text" && method === "PATCH") {
      if (record.doc.status !== "ready") throw failure("Aguarde a extração antes de editar.", 409);
      const edits = JSON.parse(options.body).pages;
      if (!Array.isArray(edits) || edits.length > 200 || new Set(edits.map((page) => page.number)).size !== edits.length) throw failure("A edição contém páginas inválidas.");
      const updated = clone(record.doc.pages);
      for (const edit of edits) {
        const page = updated.find((item) => item.number === edit.number);
        if (!page || typeof edit.text !== "string" || edit.text.length > 500_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(edit.text)) throw failure("O texto editado é inválido ou excede o limite.");
        page.text = edit.text;
      }
      if (updated.reduce((sum, page) => sum + page.text.length, 0) > 2_000_000) throw failure("O documento excede o limite de texto editável.");
      const previous = record.doc.pages;
      record.doc.pages = updated;
      record.updated_at = Date.now();
      try { await this.persist(record); } catch (error) { record.doc.pages = previous; throw error; }
    } else if (method !== "GET") throw failure("Operação inválida.");
    return clone(record.doc);
  }
}

window.LumeBrowser = new BrowserClient();
const prepare = document.getElementById("prepareModels");
prepare?.addEventListener("click", async () => {
  prepare.disabled = true;
  modelStatus("Preparando Tesseract neste aparelho…");
  try { await window.LumeBrowser.install(document.getElementById("language")?.value || "por+eng"); modelStatus("Tesseract pronto. Os modelos ficam guardados neste navegador."); }
  catch (error) { modelStatus(error.message); }
  finally { prepare.disabled = false; }
});

const advancedButton = document.getElementById("installAdvanced");
const engineSelect = document.getElementById("ocrEngine");
const visionPanel = document.getElementById("macVisionPanel");
const visionButton = document.getElementById("connectMacVision");
const neuralPanel = document.getElementById("neuralPanel");
const neuralButton = document.getElementById("installNeural");
const cancelNeural = document.getElementById("cancelNeural");
const showEnginePanel = () => {
  if (window.LumeBrowser.engine !== "neural") { window.LumeBrowser.neural?.terminate(); window.LumeBrowser.neural = null; }
  if (visionPanel) visionPanel.hidden = window.LumeBrowser.engine !== "vision";
  if (neuralPanel) neuralPanel.hidden = window.LumeBrowser.engine !== "neural";
  for (const [id, engine] of [["tesseractPanel", "tesseract"], ["paddlePanel", "paddle"]]) {
    const panel = document.getElementById(id);
    if (panel) panel.hidden = window.LumeBrowser.engine !== engine;
  }
};
if (engineSelect) {
  for (const option of engineSelect.options) {
    const reason = window.LumeBrowser.engineAvailability[option.value];
    option.disabled = Boolean(reason);
    if (reason) option.textContent = option.value === "vision" ? "Apple Vision · somente no Mac" : `${neuralName} · indisponível neste aparelho`;
  }
  engineSelect.value = window.LumeBrowser.engine;
}
const deviceNotice = document.getElementById("deviceNotice");
if (deviceNotice) {
  deviceNotice.textContent = window.LumeBrowser.device.mobile ? "No celular, use Tesseract ou PaddleOCR. O motor de documentos está habilitado somente no computador nesta versão; Apple Vision precisa de um Mac." : window.LumeBrowser.device.neuralReason;
  deviceNotice.hidden = !deviceNotice.textContent;
}
if (window.LumeBrowser.preferredEngine !== window.LumeBrowser.engine) {
  modelStatus("A escolha anterior não está disponível neste aparelho. Tesseract selecionado; você pode escolher outro motor compatível.");
  try { localStorage.setItem("lume-ocr-engine", window.LumeBrowser.engine); } catch { /* Keep this session's choice. */ }
}
showEnginePanel();
engineSelect?.addEventListener("change", () => {
  const unavailable = window.LumeBrowser.engineAvailability[engineSelect.value];
  if (unavailable) { engineSelect.value = window.LumeBrowser.engine; modelStatus(unavailable); return; }
  window.LumeBrowser.engine = engineSelect.value;
  try { localStorage.setItem("lume-ocr-engine", engineSelect.value); } catch { /* Keep the selection in memory. */ }
  showEnginePanel();
  modelStatus(engineSelect.value === "neural" ? `${neuralName} selecionado. Clique em Instalar para preparar o modelo neste aparelho.` : engineSelect.value === "vision" ? "Apple Vision selecionado. Abra o aplicativo auxiliar no Mac e clique em Conectar." : engineSelect.value === "paddle" ? "PaddleOCR selecionado. Instale os modelos ou comece a extração para prepará-los." : "OCR básico selecionado (Tesseract).");
});
neuralButton?.addEventListener("click", async () => {
  neuralButton.disabled = true; neuralButton.textContent = `Preparando ${neuralName}…`;
  modelStatus(`Preparando ${neuralName}… Carregando o motor neste navegador.`);
  try {
    await window.LumeBrowser.ensureNeural();
    window.LumeBrowser.engine = "neural"; engineSelect.value = "neural";
    try { localStorage.setItem("lume-ocr-engine", "neural"); await navigator.storage?.persist?.(); } catch { /* The browser manages its storage. */ }
    showEnginePanel(); neuralButton.textContent = `${neuralName} preparado`;
  } catch (error) { modelStatus(`${error.message} Você pode selecionar Tesseract, PaddleOCR ou Apple Vision.`); neuralButton.textContent = `Tentar preparar ${neuralName}`; }
  finally { neuralButton.disabled = false; modelStateChanged(); }
});
cancelNeural?.addEventListener("click", () => {
  window.LumeBrowser.neural?.terminate(); window.LumeBrowser.neural = null;
  modelStatus(`${neuralName} cancelado. Os arquivos já baixados podem ser reutilizados na próxima tentativa.`);
  modelStateChanged();
});
visionButton?.addEventListener("click", async () => {
  visionButton.disabled = true;
  visionButton.textContent = "Conectando…";
  try {
    await window.LumeBrowser.ensureVision(true);
    window.LumeBrowser.engine = "vision"; engineSelect.value = "vision";
    showEnginePanel();
    try { localStorage.setItem("lume-ocr-engine", "vision"); } catch { /* Retain this session's selection. */ }
    visionButton.textContent = "Apple Vision conectado";
  } catch (error) { modelStatus(error.message); visionButton.textContent = "Tentar conectar ao Mac"; }
  finally { visionButton.disabled = false; modelStateChanged(); }
});
advancedButton?.addEventListener("click", async () => {
  advancedButton.disabled = true;
  advancedButton.textContent = "Instalando PaddleOCR…";
  engineSelect.disabled = true;
  modelStatus("Preparando OCR avançado… Carregando o motor neste navegador.");
  let installed = false;
  try {
    await window.LumeBrowser.installAdvanced();
    engineSelect.value = "paddle";
    showEnginePanel();
    modelStatus("PaddleOCR pronto neste dispositivo. Modelos salvos para uso offline.");
    advancedButton.textContent = "PaddleOCR instalado";
    installed = true;
    try { await navigator.storage?.persist?.(); } catch { /* The browser may manage storage persistence itself. */ }
  } catch (error) { modelStatus(`${error.message} O OCR básico continua disponível.`); }
  finally {
    if (!installed) advancedButton.textContent = "Tentar instalar PaddleOCR";
    advancedButton.disabled = false; engineSelect.disabled = false;
    modelStateChanged();
  }
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(asset("sw.js"), { scope: asset("") }).catch(() => {
    modelStatus("OCR local disponível. Este navegador não habilitou a abertura offline do site.");
  });
}

let installPrompt = null;
const installButton = document.getElementById("installApp");
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  if (installButton) installButton.hidden = false;
});
installButton?.addEventListener("click", async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  } else {
    modelStatus(window.LumeBrowser.device.ios ? "No iPhone/iPad, abra o site no Safari, toque em Compartilhar e escolha Adicionar à Tela de Início." : window.LumeBrowser.device.mobile ? "No Chrome do celular, abra o menu e escolha Adicionar à tela inicial ou Instalar aplicativo." : "No Safari do Mac, use Arquivo → Adicionar ao Dock. No Chrome, use o ícone de instalar na barra de endereço.");
  }
});
if (installButton && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium/.test(navigator.userAgent)) installButton.hidden = false;

const applicationScript = document.createElement("script");
applicationScript.src = new URL("./app.js", import.meta.url).href;
const buildVersion = new URL(import.meta.url).searchParams.get("v");
if (buildVersion) applicationScript.src += `?v=${encodeURIComponent(buildVersion)}`;
document.head.append(applicationScript);
