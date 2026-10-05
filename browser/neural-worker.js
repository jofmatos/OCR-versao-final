import { GLM_MODEL_ID, modelName, validateManifest, repeatsTokens, recognitionWarnings } from "./neural-policy.js";

let model, processor, runtime, manifest, initializing;
let name = "OCR de documentos";
const progress = (message, details = {}) => self.postMessage({ progress: { message, ...details } });
const local = (path) => new URL(`../${path}`, import.meta.url).href;

async function initialize() {
  if (model) return { model: name, bytes: manifest.bytes };
  if (initializing) return initializing;
  initializing = (async () => {
    if (!self.isSecureContext || !navigator.gpu) throw new Error("Este motor precisa de WebGPU. Use uma versão atual do Chrome no Mac, com aceleração gráfica ativada, ou selecione outro motor.");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("O navegador não disponibilizou a GPU. Ative a aceleração gráfica no Chrome e reabra o navegador.");
    progress("Verificando o modelo e o espaço no navegador…");
    const configUrl = new URL("./neural-model.json", import.meta.url);
    configUrl.search = new URL(import.meta.url).search;
    const response = await fetch(configUrl);
    if (!response.ok) throw new Error("Não foi possível carregar a configuração. Atualize a página e tente novamente.");
    manifest = validateManifest(await response.json());
    name = modelName(manifest);
    const storage = await navigator.storage?.estimate?.().catch(() => null);
    if (storage?.quota && storage.quota - (storage.usage || 0) < manifest.bytes * 1.15) {
      throw new Error("Falta espaço de armazenamento no navegador. Libere espaço antes de instalar este modelo.");
    }
    progress(`Carregando ${name}… O download inicial pode levar alguns minutos.`, { total: manifest.bytes });
    runtime = await import("@huggingface/transformers");
    runtime.env.allowLocalModels = false;
    runtime.env.useFSCache = false;
    runtime.env.useBrowserCache = true;
    runtime.env.backends.onnx.wasm.numThreads = 1;
    runtime.env.backends.onnx.wasm.proxy = false;
    runtime.env.backends.onnx.wasm.wasmPaths = {
      mjs: local("vendor/transformers/ort-wasm-simd-threaded.jsep.mjs"),
      wasm: local("vendor/transformers/ort-wasm-simd-threaded.jsep.wasm"),
    };
    const files = new Map();
    const progress_callback = (event) => {
      const file = event.file || "modelo";
      if (event.status === "progress" || event.status === "done") {
        files.set(file, event.status === "done" ? (manifest.sizes[file] || event.total || 0) : (event.loaded || 0));
        const loaded = Math.min(manifest.bytes, [...files.values()].reduce((a, b) => a + b, 0));
        const mb = (loaded / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
        const totalMb = (manifest.bytes / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
        progress(`Preparando ${name} · ${mb} de ${totalMb} MB`, { loaded, total: manifest.bytes });
      } else if (event.status === "initiate") {
        progress(`Preparando ${name} · ${file.split("/").at(-1)}`);
      }
    };
    const options = { revision: manifest.revision, progress_callback };
    // Load sequentially to avoid two large allocations during model startup.
    processor = await runtime.AutoProcessor.from_pretrained(manifest.model, options);
    progress("Preparando o modelo na GPU… Isso pode levar alguns minutos no primeiro uso.");
    model = await runtime.AutoModelForImageTextToText.from_pretrained(manifest.model, {
      ...options, dtype: "q4",
      // The vocabulary table can exceed a Mac GPU's single-buffer limit. Keep
      // that lookup in WASM; vision and decoding still run on the GPU.
      device: { embed_tokens: "wasm", vision_encoder: "webgpu", decoder_model_merged: "webgpu" },
      session_options: { enableCpuMemArena: false, enableMemPattern: false },
    });
    progress(`${name} pronto. O processamento será feito neste aparelho.`, { loaded: manifest.bytes, total: manifest.bytes, ready: true });
    return { model: name, bytes: manifest.bytes };
  })();
  try { return await initializing; }
  catch (error) {
    await model?.dispose().catch(() => {}); model = null; processor = null;
    throw error;
  } finally { initializing = null; }
}

async function recognize(image, quality) {
  await initialize();
  if (!(image?.data instanceof Uint8ClampedArray) || image.width < 1 || image.height < 1 || image.width * image.height > 12_100_000) {
    throw new Error("A imagem desta página não tem dimensões válidas.");
  }
  let raw = new runtime.RawImage(image.data, image.width, image.height, 4).rgb();
  const limit = quality === "high" ? 1540 : 1120;
  const scale = Math.min(1, limit / Math.max(raw.width, raw.height));
  if (scale < 1) raw = await raw.resize(Math.max(1, Math.round(raw.width * scale)), Math.max(1, Math.round(raw.height * scale)));
  const isGlm = manifest.model === GLM_MODEL_ID;
  const content = isGlm ? [{ type: "image" }, { type: "text", text: "Text Recognition:" }] : [{ type: "image" }];
  const prompt = processor.apply_chat_template([{ role: "user", content }], { tokenize: false, add_generation_prompt: true });
  const inputs = isGlm ? await processor(prompt, raw) : await processor(raw, prompt);
  const promptLength = inputs.input_ids.dims.at(-1);
  let repeated = false, lastUpdate = 0, received = 0;
  class RepetitionStop extends runtime.StoppingCriteria {
    _call(ids) { return ids.map((sequence) => { const result = repeatsTokens(sequence.slice(promptLength)); if (result) repeated = true; return result; }); }
  }
  const streamer = new runtime.TextStreamer(processor.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (text) => {
      received += text.length;
      if (Date.now() - lastUpdate > 1000) { progress(`Lendo a página com ${name} · ${received} caracteres…`); lastUpdate = Date.now(); }
    },
  });
  progress(`Lendo a página com ${name}…`);
  const max_new_tokens = 4096;
  try {
    const output = await model.generate({ ...inputs, do_sample: false, max_new_tokens, stopping_criteria: [new RepetitionStop()], streamer });
    const tokens = output.tolist()[0].slice(promptLength);
    const text = processor.tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
    if (text.length > 500000) throw new Error("A leitura excedeu o limite de texto desta página.");
    return { text, confidence: null, warnings: recognitionWarnings({ repeated, limited: tokens.length >= max_new_tokens }), model: name, tokens: tokens.length };
  } finally {
    for (const value of Object.values(inputs)) if (value?.dispose) value.dispose();
  }
}

self.onmessage = async ({ data }) => {
  try {
    const result = data.type === "init" ? await initialize() : data.type === "recognize" ? await recognize(data.image, data.quality) : null;
    if (!result) throw new Error("Operação de OCR desconhecida.");
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error?.message || "Não foi possível iniciar este OCR. Confira a conexão e a memória disponível." });
  }
};
