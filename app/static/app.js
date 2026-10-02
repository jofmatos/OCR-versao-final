"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    doc: null, page: 1, zoom: 100, busy: false, exporting: false,
    edits: new Map(), pollTimer: null, pollErrors: 0, toastTimer: null,
    health: null, maxMB: 50, maxPages: 200,
  };

  function notify(message) {
    $("toast").textContent = message;
    $("toast").hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
  }

  function showError(message) {
    $("alertText").textContent = message;
    $("alert").hidden = false;
  }

  function clearError() { $("alert").hidden = true; }

  async function request(path, options = {}) {
    if (window.LumeBrowser) return window.LumeBrowser.request(path, options);
    let response;
    try { response = await fetch(path, options); }
    catch { throw new Error("Não foi possível conectar ao servidor. Confira sua conexão e tente novamente."); }
    if (!response.ok) {
      let message = `Não foi possível concluir a operação (erro ${response.status}).`;
      try {
        const body = await response.json();
        const detail = body.detail || body.error;
        if (typeof detail === "string") message = detail;
        else if (Array.isArray(detail)) message = "Confira as opções de conversão e tente novamente.";
      } catch { /* Keep a useful fallback for non-JSON errors. */ }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function remember(id) {
    try {
      if (id) sessionStorage.setItem("lume-document", id);
      else sessionStorage.removeItem("lume-document");
    } catch { /* Session recovery is optional when storage is disabled. */ }
  }

  function restoreId() {
    try { return sessionStorage.getItem("lume-document"); }
    catch { return null; }
  }

  function ask(title, message, action) {
    return new Promise((resolve) => {
      const dialog = $("confirmDialog");
      $("confirmTitle").textContent = title;
      $("confirmMessage").textContent = message;
      $("confirmAction").textContent = action;
      dialog.returnValue = "cancel";
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
    });
  }

  function sizeLabel(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  }

  function currentPage() {
    return state.doc?.pages?.find((page) => page.number === state.page);
  }

  function isProcessing() { return state.doc?.status === "processing"; }
  function hasText() { return Boolean(state.doc?.pages?.some((page) => page.method)); }
  function canExport() { return state.doc?.status === "ready" && hasText(); }

  function updateControls() {
    const installing = Boolean(window.LumeBrowser?.paddlePromise || window.LumeBrowser?.visionPromise);
    const locked = state.busy || isProcessing() || state.exporting || installing;
    $("chooseFile").disabled = state.busy;
    $("removeFile").disabled = state.busy || state.exporting;
    $("convertButton").disabled = locked || !state.doc;
    for (const id of ["mode", "language", "quality", "pageRange"]) $(id).disabled = locked;
    $("exportDocx").disabled = locked || !canExport();
    $("exportTxt").disabled = locked || !canExport();
    $("saveText").disabled = locked || !state.edits.size;
    $("copyText").disabled = !currentPage()?.method || state.busy;
    $("pageText").readOnly = locked;
    if ($("prepareModels")) $("prepareModels").disabled = locked || Boolean(window.LumeBrowser?.workerPromise);
    if ($("installAdvanced")) $("installAdvanced").disabled = locked || Boolean(window.LumeBrowser?.paddlePromise);
    if ($("ocrEngine")) $("ocrEngine").disabled = locked || Boolean(window.LumeBrowser?.paddlePromise);
    if ($("connectMacVision")) $("connectMacVision").disabled = locked;
    $("previousPage").disabled = !state.doc || state.page <= 1;
    $("nextPage").disabled = !state.doc || state.page >= state.doc.page_count;
    $("zoomOut").disabled = state.zoom <= 50;
    $("zoomIn").disabled = state.zoom >= 200;
    $("saveStatus").textContent = state.edits.size ? "Alterações não salvas" : "";
    $("convertButton").querySelector("span").textContent = isProcessing() ? "Extraindo texto…" : hasText() ? "Extrair novamente" : "Extrair texto";
  }

  function updateStats(text) {
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
    $("textStats").textContent = `${words.toLocaleString("pt-BR")} ${words === 1 ? "palavra" : "palavras"} · ${text.length.toLocaleString("pt-BR")} caracteres`;
  }

  function renderText() {
    const page = currentPage();
    const extracted = Boolean(page?.method);
    $("textPlaceholder").hidden = extracted;
    $("pageText").hidden = !extracted;
    $("pageMethod").hidden = !extracted;
    $("pageWarnings").replaceChildren();
    $("pageWarnings").hidden = !page?.warnings?.length;
    for (const warning of page?.warnings || []) {
      const paragraph = document.createElement("p");
      paragraph.textContent = warning;
      $("pageWarnings").append(paragraph);
    }
    $("confidence").textContent = "";
    if (extracted) {
      const text = state.edits.has(state.page) ? state.edits.get(state.page) : page.text || "";
      $("pageText").value = text;
      $("pageText").setAttribute("aria-label", `Transcrição editável da página ${state.page}`);
      $("pageMethod").textContent = page.method === "ocr" ? "Reconhecido por OCR" : "Texto do PDF";
      updateStats(text);
      if (page.method === "ocr" && Number.isFinite(page.confidence)) {
        $("confidence").textContent = `Confiança OCR: ${Math.round(page.confidence)}%`;
        $("confidence").title = "Estimativa do mecanismo OCR. Revise o texto para conferir a exatidão.";
      }
    } else {
      $("pageText").value = "";
      $("textStats").textContent = state.doc?.status === "ready" ? "Página fora da seleção" : "Aguardando extração";
      $("textPlaceholder").querySelector("h3").textContent = state.doc?.status === "ready" ? "Esta página não foi extraída" : "As palavras aparecem aqui";
      $("textPlaceholder").querySelector("p").textContent = state.doc?.status === "ready" ? "Inclua esta página em uma nova extração para editar seu conteúdo." : "Extraia o texto para revisar e editar o conteúdo desta página.";
    }
    updateControls();
  }

  function showPage(number) {
    if (!state.doc) return;
    state.page = Math.max(1, Math.min(number, state.doc.page_count));
    $("pageSelect").value = String(state.page);
    const image = $("pagePreview");
    image.hidden = true;
    $("previewLoading").hidden = false;
    $("previewError").hidden = true;
    image.alt = `Página ${state.page} do documento ${state.doc.name}`;
    if (window.LumeBrowser) {
      const id = state.doc.id, page = state.page;
      window.LumeBrowser.preview(id, page).then((url) => {
        if (state.doc?.id === id && state.page === page) image.src = url;
      }).catch((error) => {
        if (state.doc?.id !== id || state.page !== page) return;
        $("previewLoading").hidden = true;
        $("previewError").textContent = error.message;
        $("previewError").hidden = false;
      });
    } else image.src = `/api/documents/${encodeURIComponent(state.doc.id)}/preview/${state.page}`;
    $("previewCanvas").scrollTop = 0;
    renderText();
  }

  function renderDocument({ reset = false } = {}) {
    const doc = state.doc;
    $("emptyState").hidden = Boolean(doc);
    $("workspace").hidden = !doc;
    if (!doc) { updateControls(); return; }
    $("documentName").textContent = doc.name;
    $("documentName").title = doc.name;
    $("documentMeta").textContent = `${doc.page_count} ${doc.page_count === 1 ? "página" : "páginas"} · ${sizeLabel(doc.size)} · PDF`;
    const statuses = { uploaded: "Pronto para converter", processing: "Extraindo texto", ready: "Texto extraído", error: "Conversão interrompida" };
    $("documentStatus").textContent = statuses[doc.status] || "Documento enviado";
    $("documentStatus").className = `badge ${doc.status}`;
    $("progressPanel").hidden = !isProcessing();
    $("progressTitle").textContent = doc.progress?.message || "Lendo seu documento…";
    const total = doc.progress?.total || doc.page_count;
    const completed = doc.progress?.completed || 0;
    $("progressCount").textContent = `${completed} de ${total} ${total === 1 ? "página" : "páginas"}`;
    const progress = Math.min(100, Math.round(completed / Math.max(total, 1) * 100));
    $("progressFill").style.width = `${progress}%`;
    $("progressFill").parentElement.setAttribute("aria-valuenow", String(progress));
    if (reset) {
      $("pageSelect").replaceChildren();
      for (let i = 1; i <= doc.page_count; i += 1) {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = `Página ${i}`;
        $("pageSelect").append(option);
      }
      $("pageTotal").textContent = `de ${doc.page_count}`;
      showPage(1);
    } else if (document.activeElement !== $("pageText")) renderText();
    if (doc.status === "error" && doc.error) showError(doc.error);
    updateControls();
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (!state.doc || !isProcessing()) return;
    state.pollTimer = setTimeout(poll, 1200);
  }

  async function poll() {
    const id = state.doc?.id;
    if (!id) return;
    try {
      const doc = await request(`/api/documents/${encodeURIComponent(id)}`);
      if (state.doc?.id !== id) return;
      state.doc = doc;
      if (state.pollErrors >= 3) clearError();
      state.pollErrors = 0;
      renderDocument();
      if (doc.status === "ready") {
        const first = doc.pages?.find((page) => page.method);
        if (first && !currentPage()?.method) showPage(first.number);
        notify("Texto extraído. Revise o resultado e escolha um formato para baixar.");
      }
      schedulePoll();
    } catch (error) {
      if (state.doc?.id !== id) return;
      state.pollErrors += 1;
      if (error.status === 404) {
        state.doc = null;
        state.edits.clear();
        remember(null);
        renderDocument();
        showError("Este documento não está mais disponível. Envie o PDF novamente.");
        return;
      }
      if (state.pollErrors === 3) showError("A conexão foi interrompida. Tentando retomar o acompanhamento da conversão…");
      state.pollTimer = setTimeout(poll, Math.min(15000, 2000 * state.pollErrors));
    }
  }

  async function upload(file) {
    if (!file || state.busy || state.doc) return;
    clearError();
    if (!/\.pdf$/i.test(file.name)) {
      showError("Selecione um arquivo PDF. Outros formatos ainda não são aceitos.");
      return;
    }
    if (file.size > state.maxMB * 1024 * 1024) {
      showError(`O arquivo excede o limite de ${state.maxMB} MB. Escolha um PDF menor.`);
      return;
    }
    if (!file.size) { showError("Este arquivo está vazio. Escolha um PDF válido."); return; }
    state.busy = true;
    updateControls();
    const button = $("chooseFile");
    const label = document.createElement("span");
    label.textContent = "Enviando documento…";
    const original = [...button.childNodes];
    button.replaceChildren(label);
    try {
      const data = new FormData();
      data.append("file", file);
      state.doc = await request("/api/documents", { method: "POST", body: data });
      state.edits.clear();
      remember(state.doc.id);
      state.zoom = 100;
      setZoom(100);
      renderDocument({ reset: true });
      $("convertButton").focus();
      notify("Documento pronto. Configure a leitura e extraia o texto.");
    } catch (error) { showError(error.message); }
    finally {
      state.busy = false;
      button.replaceChildren(...original);
      $("fileInput").value = "";
      updateControls();
    }
  }

  function validateRange(value) {
    if (!value.trim()) return;
    const parts = value.split(",");
    for (const part of parts) {
      const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) throw new Error("Informe as páginas como 1-3, 5 ou deixe o campo vazio para ler todas.");
      const first = Number(match[1]);
      const last = Number(match[2] || match[1]);
      if (first < 1 || last < first || last > state.doc.page_count) {
        throw new Error(`Use páginas entre 1 e ${state.doc.page_count}, com os intervalos em ordem crescente.`);
      }
    }
  }

  async function convert(event) {
    event.preventDefault();
    if (!state.doc || state.busy || isProcessing()) return;
    clearError();
    const pages = $("pageRange").value.trim();
    try { validateRange(pages); }
    catch (error) { showError(error.message); $("pageRange").focus(); return; }
    if (hasText() && !await ask("Extrair o texto novamente?", "Uma nova extração substitui a transcrição atual, incluindo suas edições. Baixe uma cópia antes de continuar se quiser preservá-la.", "Extrair novamente")) return;
    state.busy = true;
    updateControls();
    try {
      state.doc = await request(`/api/documents/${encodeURIComponent(state.doc.id)}/convert`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: $("mode").value, language: $("language").value, quality: $("quality").value, pages }),
      });
      state.edits.clear();
      state.pollErrors = 0;
      renderDocument();
      schedulePoll();
    } catch (error) { showError(error.message); }
    finally { state.busy = false; updateControls(); }
  }

  async function saveEdits() {
    if (!state.edits.size || !state.doc) return true;
    const pages = [...state.edits].map(([number, text]) => ({ number, text }));
    $("saveStatus").textContent = "Salvando…";
    const doc = await request(`/api/documents/${encodeURIComponent(state.doc.id)}/text`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages }),
    });
    for (const page of pages) {
      if (state.edits.get(page.number) === page.text) state.edits.delete(page.number);
    }
    state.doc = doc;
    $("saveStatus").textContent = "Alterações salvas";
    return true;
  }

  async function save() {
    if (state.busy || isProcessing()) return;
    clearError();
    state.busy = true;
    updateControls();
    try { await saveEdits(); notify("Alterações salvas."); }
    catch (error) { showError(`Não foi possível salvar. ${error.message}`); }
    finally { state.busy = false; updateControls(); }
  }

  async function exportFile(format) {
    if (!canExport() || state.exporting || state.busy) return;
    clearError();
    state.exporting = true;
    updateControls();
    try {
      await saveEdits();
      let blob;
      if (window.LumeBrowser) blob = await window.LumeBrowser.export(state.doc.id, format);
      else {
      const response = await fetch(`/api/documents/${encodeURIComponent(state.doc.id)}/export?format=${format}`);
      if (!response.ok) {
        let message = "Não foi possível gerar o arquivo. Tente novamente.";
        try { const data = await response.json(); if (typeof data.detail === "string") message = data.detail; } catch { /* Fallback message. */ }
        throw new Error(message);
      }
      blob = await response.blob();
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = state.doc.name.replace(/\.pdf$/i, "") + `.${format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      notify(`Arquivo ${format.toUpperCase()} pronto para download.`);
    } catch (error) { showError(`Exportação interrompida. ${error.message}`); }
    finally { state.exporting = false; updateControls(); }
  }

  async function remove() {
    if (!state.doc || state.busy || state.exporting) return;
    const processing = isProcessing();
    const place = window.LumeBrowser ? "deste navegador" : "deste servidor";
    const message = processing ? "A extração será interrompida e o documento será excluído. A página em leitura pode terminar de ser processada internamente antes da interrupção." : state.edits.size ? `Suas alterações não salvas serão perdidas. O PDF e a transcrição serão excluídos ${place}.` : `O PDF e sua transcrição serão excluídos ${place}. Os arquivos já baixados continuam no seu dispositivo.`;
    if (!await ask(processing ? "Interromper e remover?" : "Remover este documento?", message, processing ? "Interromper e remover" : "Remover documento")) return;
    clearError();
    state.busy = true;
    updateControls();
    try {
      await request(`/api/documents/${encodeURIComponent(state.doc.id)}`, { method: "DELETE" });
      clearTimeout(state.pollTimer);
      state.doc = null;
      state.edits.clear();
      remember(null);
      $("pageRange").value = "";
      $("pagePreview").removeAttribute("src");
      renderDocument();
      notify("Documento removido.");
    } catch (error) { showError(error.message); }
    finally { state.busy = false; updateControls(); }
  }

  function setZoom(value) {
    state.zoom = Math.max(50, Math.min(200, value));
    $("zoomValue").textContent = `${state.zoom}%`;
    $("pagePreview").style.width = `${state.zoom}%`;
    updateControls();
  }

  function setLanguages(health) {
    const select = $("language");
    select.replaceChildren();
    const languages = health.languages || [];
    const codes = new Set(languages.map((language) => language.code));
    if (codes.has("por") && codes.has("eng")) {
      const option = document.createElement("option");
      option.value = "por+eng";
      option.textContent = "Português + inglês";
      select.append(option);
    }
    const sorted = [...languages].sort((a, b) => {
      if (a.code === "por") return -1;
      if (b.code === "por") return 1;
      return a.label.localeCompare(b.label, "pt-BR");
    });
    for (const language of sorted) {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      select.append(option);
    }
    if (!languages.length) {
      const option = document.createElement("option");
      option.value = "eng";
      option.textContent = "OCR indisponível";
      select.append(option);
    }
    $("mode").querySelector('[value="ocr"]').disabled = !health.ocr_available;
    if (!health.ocr_available) $("conversionHint").textContent = "OCR indisponível neste servidor. A extração do texto incorporado ao PDF continua disponível.";
  }

  async function initialize() {
    state.busy = true;
    updateControls();
    try {
      const health = await request("/api/health");
      state.health = health;
      state.maxMB = health.limits?.max_upload_mb || 50;
      state.maxPages = health.limits?.max_pages || 200;
      $("uploadLimit").textContent = `Arquivos PDF · Até ${state.maxMB} MB · ${state.maxPages} páginas`;
      $("connectionDot").className = "status-dot online";
      $("connectionLabel").textContent = health.ocr_available ? "OCR disponível" : "Leitura de PDF disponível";
      setLanguages(health);
      if (!health.ocr_available) showError("O reconhecimento de imagens ainda não está disponível neste servidor. Você pode extrair texto de PDFs digitais.");
    } catch (error) {
      $("connectionDot").className = "status-dot offline";
      $("connectionLabel").textContent = "Serviço indisponível";
      showError(error.message);
    }
    const id = restoreId();
    if (!id) { state.busy = false; updateControls(); return; }
    try {
      state.doc = await request(`/api/documents/${encodeURIComponent(id)}`);
      renderDocument({ reset: true });
      schedulePoll();
    } catch (error) {
      if (error.status === 404) { remember(null); notify("A sessão anterior expirou. Envie seu documento novamente."); }
      else showError(error.message);
    } finally { state.busy = false; updateControls(); }
  }

  $("chooseFile").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (event) => upload(event.target.files?.[0]));
  let dragDepth = 0;
  $("dropzone").addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth += 1; $("dropzone").classList.add("dragover"); });
  $("dropzone").addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
  $("dropzone").addEventListener("dragleave", (event) => { event.preventDefault(); dragDepth -= 1; if (dragDepth <= 0) $("dropzone").classList.remove("dragover"); });
  $("dropzone").addEventListener("drop", (event) => {
    event.preventDefault(); dragDepth = 0; $("dropzone").classList.remove("dragover");
    if (event.dataTransfer.files.length > 1) { showError("Envie um PDF por vez para revisar e exportar o conteúdo."); return; }
    upload(event.dataTransfer.files[0]);
  });
  window.addEventListener("dragover", (event) => { if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault(); });
  window.addEventListener("drop", (event) => { if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault(); });
  $("dismissAlert").addEventListener("click", clearError);
  $("convertForm").addEventListener("submit", convert);
  $("previousPage").addEventListener("click", () => showPage(state.page - 1));
  $("nextPage").addEventListener("click", () => showPage(state.page + 1));
  $("pageSelect").addEventListener("change", (event) => showPage(Number(event.target.value)));
  $("zoomOut").addEventListener("click", () => setZoom(state.zoom - 25));
  $("zoomIn").addEventListener("click", () => setZoom(state.zoom + 25));
  $("pagePreview").addEventListener("load", () => { $("previewLoading").hidden = true; $("previewError").hidden = true; $("pagePreview").hidden = false; });
  $("pagePreview").addEventListener("error", () => { if (!state.doc) return; $("previewLoading").hidden = true; $("previewError").hidden = false; $("pagePreview").hidden = true; });
  $("pageText").addEventListener("input", (event) => {
    const text = event.target.value;
    if (text === (currentPage()?.text || "")) state.edits.delete(state.page);
    else state.edits.set(state.page, text);
    updateStats(text);
    updateControls();
  });
  $("saveText").addEventListener("click", save);
  $("exportTxt").addEventListener("click", () => exportFile("txt"));
  $("exportDocx").addEventListener("click", () => exportFile("docx"));
  $("removeFile").addEventListener("click", remove);
  $("copyText").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("pageText").value); notify("Texto da página copiado."); }
    catch { $("pageText").focus(); $("pageText").select(); notify("Texto selecionado. Use Ctrl+C ou ⌘C para copiar."); }
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.edits.size) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("lume-model-state", updateControls);
  initialize();
})();
