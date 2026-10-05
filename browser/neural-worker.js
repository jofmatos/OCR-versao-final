import { GLM_MODEL_ID, modelName, validateManifest, missingModelBytes, repeatsTokens, recognitionWarnings } from "./neural-policy.js";

let model, processor, runtime, manifest, initializing;
const execution = { embed_tokens: "webgpu", vision_encoder: "wasm", decoder_model_merged: "wasm" };
let name = "OCR de documentos";
const progress = (message, details = {}) => self.postMessage({ progress: { message, ...details } });
const local = (path) => new URL(`../${path}`, import.meta.url).href;

async function initialize() {
  if (model) return { model: name, bytes: manifest.bytes, execution };
  if (initializing) return initializing;
  initializing = (async () => {
    if (!self.isSecureContext || !navigator.gpu) throw new Error("Este motor precisa de WebGPU. Use uma versão atual do Chrome no Mac, com aceleração gráfica ativada, ou selecione outro motor.");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("O navegador não disponibilizou a GPU. Ative a aceleração gráfica no Chrome e reabra o navegador.");
    progress("Verificando a configuração do modelo…");
    const configUrl = new URL("./neural-model.json", import.meta.url);
    configUrl.search = new URL(import.meta.url).search;
    const response = await fetch(configUrl);
    if (!response.ok) throw new Error("Não foi possível carregar a configuração. Atualize a página e tente novamente.");
    manifest = validateManifest(await response.json());
    name = modelName(manifest);
    runtime = await import("@huggingface/transformers");
    runtime.env.allowLocalModels = false;
    runtime.env.useFSCache = false;
    runtime.env.useBrowserCache = true;
    const cache = await caches.open(runtime.env.cacheKey).catch(() => null);
    if (!cache) throw new Error("O navegador não permitiu guardar este modelo. Use uma janela normal do Chrome ou selecione outro motor.");
    const missing = await missingModelBytes(manifest, async (file) => {
      const url = `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${file}`;
      return Boolean(await cache.match(url));
    });
    // Storage estimates can shrink below current usage and include padding.
    // They must not block loading existing files. Cache writes and the real
    // offline restart check determine whether installation is reusable.
    progress(missing ? `Carregando ${name}… O download inicial pode levar alguns minutos.` : `Carregando ${name} dos arquivos já instalados…`, { total: manifest.bytes });
    runtime.env.backends.onnx.wasm.numThreads = 1;
    runtime.env.backends.onnx.wasm.proxy = false;
    runtime.env.backends.onnx.wasm.wasmPaths = {
      mjs: local("vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs"),
      wasm: local("vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm"),
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
      // GLM's export omits q4 entries from its external-data configuration.
      // Each component in the verified manifest has one external weight file.
      use_external_data_format: true,
      // Quantized Gather requires WebGPU. The dense vision and decoder graphs
      // use WASM to avoid large GPU bindings and driver-dependent stalls.
      device: execution,
      session_options: { enableCpuMemArena: false, enableMemPattern: false },
    });
    const vision = model.sessions.vision_encoder;
    const runVision = vision.run.bind(vision);
    vision.run = async (...args) => {
      progress(`Analisando a imagem com ${name}…`);
      const result = await runVision(...args);
      progress(`Transcrevendo a página com ${name}…`);
      return result;
    };
    progress(`${name} pronto. O processamento será feito neste aparelho.`, { loaded: manifest.bytes, total: manifest.bytes, ready: true });
    return { model: name, bytes: manifest.bytes, execution };
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
