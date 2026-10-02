import { PaddleOCR } from "@paddleocr/paddleocr-js";
import { parsePaddleDictionary } from "./paddle-dictionary.js";

// Converted PaddleOCR v5 weights, pinned to the model distributor's Git commit
// and Git LFS SHA-256. Only public model assets ever leave this worker.
const revision = "384182c7187c12d4ea181ae3b97c8b7e12089d9d";
const repository = "PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models";
const models = [
  { path: "detection/PP-OCRv5_mobile_det_infer.onnx", hash: "d7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924", size: 4748769, label: "detector de texto" },
  { path: "recognition/multi/latin/v5/latin_PP-OCRv5_mobile_rec_infer.onnx", hash: "497dbed20b7fd86334c9deb5082c2958982a316bb16e3589ebc6502cd85cae79", size: 8066518, label: "reconhecimento em português" },
  { path: "recognition/multi/latin/v5/ppocrv5_latin_dict.txt", hash: "7274e68c7675355e45dd75c360c83faa0d0624de33a704c799a7da8897662201", label: "dicionário latino", plain: true },
];
const cacheName = "lume-paddle-models-v5-latin-1";
const notify = (message) => self.postMessage({ progress: message });
let engine;

function textLines(items) {
  const rows = [];
  for (const item of items) {
    const xs = item.poly.map((point) => point[0]), ys = item.poly.map((point) => point[1]);
    const box = { text: item.text, left: Math.min(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    const height = Math.max(1, box.bottom - box.top);
    const row = rows.find((candidate) => Math.min(candidate.bottom, box.bottom) - Math.max(candidate.top, box.top) >= Math.min(height, candidate.bottom - candidate.top) * 0.5);
    if (row) {
      row.items.push(box);
      row.top = Math.min(row.top, box.top); row.bottom = Math.max(row.bottom, box.bottom);
    } else rows.push({ top: box.top, bottom: box.bottom, items: [box] });
  }
  return rows.sort((a, b) => a.top - b.top).map((row) => row.items.sort((a, b) => a.left - b.left).map((item) => item.text).join(" ")).join("\n");
}

async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function download(model) {
  const host = model.plain ? "raw.githubusercontent.com" : "media.githubusercontent.com/media";
  const url = `https://${host}/${repository}/${revision}/${model.path}`;
  const cache = await caches.open(cacheName);
  const saved = await cache.match(url);
  if (saved) {
    const bytes = new Uint8Array(await saved.arrayBuffer());
    if (await digest(bytes) === model.hash) return bytes;
    await cache.delete(url);
  }
  notify(`Baixando ${model.label}…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`Download do ${model.label}: HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  const limit = model.size || 100000;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.length;
    if (count > limit) { await reader.cancel(); throw new Error("O modelo baixado excede o tamanho esperado."); }
    chunks.push(value);
    notify(`Baixando ${model.label} · ${model.size ? Math.round(count / model.size * 100) + "%" : "preparando"}`);
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (await digest(bytes) !== model.hash) throw new Error("A verificação do modelo falhou. Tente instalar novamente.");
  await cache.put(url, new Response(bytes));
  return bytes;
}

// The official SDK consumes ustar archives containing ONNX and inference.yml.
// JSON is valid YAML; these settings follow the PP-OCRv5 mobile preprocessing.
function archive(model, config) {
  const encoder = new TextEncoder();
  const entries = [["inference.onnx", model], ["inference.yml", encoder.encode(JSON.stringify(config))]];
  const bytes = new Uint8Array(entries.reduce((sum, [, data]) => sum + 512 + Math.ceil(data.length / 512) * 512, 1024));
  let offset = 0;
  for (const [name, data] of entries) {
    const header = bytes.subarray(offset, offset + 512);
    const field = (start, text) => header.set(encoder.encode(text), start);
    field(0, name); field(100, "0000644\0"); field(124, data.length.toString(8).padStart(11, "0") + "\0");
    header.fill(32, 148, 156); header[156] = 48; field(257, "ustar\0"); field(263, "00");
    field(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ");
    bytes.set(data, offset + 512);
    offset += 512 + Math.ceil(data.length / 512) * 512;
  }
  return bytes;
}

async function initialize() {
  if (engine) return;
  const [det, rec, dictionary] = await Promise.all(models.map(download));
  const assets = {
    detector: archive(det, { model_name: "PP-OCRv5_mobile_det", PreProcess: { transform_ops: [
      { DetResizeForTest: { resize_long: 960, limit_type: "max", max_side_limit: 4000 } },
      { NormalizeImage: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] } },
    ] }, PostProcess: { thresh: 0.3, box_thresh: 0.6, unclip_ratio: 1.5 } }),
    recognizer: archive(rec, { model_name: "latin_PP-OCRv5_mobile_rec", PreProcess: { transform_ops: [{ RecResizeImg: { image_shape: [3, 48, 320] } }] }, PostProcess: { character_dict: parsePaddleDictionary(dictionary) } }),
  };
  notify("Iniciando PaddleOCR neste dispositivo…");
  engine = await PaddleOCR.create({
    textDetectionModelName: "PP-OCRv5_mobile_det", textDetectionModelAsset: { url: "detector" },
    textRecognitionModelName: "latin_PP-OCRv5_mobile_rec", textRecognitionModelAsset: { url: "recognizer" },
    fetch: async (url) => new Response(assets[url]),
    textRecognitionBatchSize: 1,
    // Single-thread WASM also works on hosts without COOP/COEP, including Pages.
    ortOptions: { backend: "wasm", numThreads: 1, wasmPaths: new URL("../vendor/onnx/", import.meta.url).href },
  });
}

self.onmessage = async ({ data }) => {
  try {
    await initialize();
    if (data.type === "init") self.postMessage({ id: data.id, result: true });
    else {
      notify("Reconhecendo texto com PaddleOCR no seu computador…");
      // The SDK accepts cv.Mat in direct mode. Its default ImageData adapter
      // uses document.createElement, which is unavailable in a dedicated worker.
      const mat = engine.cv.matFromImageData(data.image);
      let result;
      try {
        [result] = await engine.predict(mat, { textDetLimitSideLen: data.quality === "high" ? 1920 : 1280, textRecScoreThresh: 0 });
      } finally { mat.delete(); }
      self.postMessage({ id: data.id, result: {
        text: textLines(result.items),
        confidence: result.items.length ? result.items.reduce((sum, item) => sum + item.score, 0) / result.items.length * 100 : null,
      } });
    }
  } catch (error) { self.postMessage({ id: data.id, error: error.message || "Não foi possível iniciar o PaddleOCR." }); }
};
