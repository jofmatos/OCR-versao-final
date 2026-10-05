export const MODEL_ID = "onnx-community/LightOnOCR-2-1B-ONNX";
export const MODEL_NAME = "LightOnOCR-2-1B";
export const GLM_MODEL_ID = "onnx-community/GLM-OCR-ONNX";
export const modelName = (manifest) => manifest.model === GLM_MODEL_ID ? "GLM-OCR" : MODEL_NAME;

export function validateManifest(manifest) {
  if (!manifest?.available) throw new Error("O modelo ainda não está disponível nesta compilação do site.");
  if (![MODEL_ID, GLM_MODEL_ID].includes(manifest.model) || !/^[a-f0-9]{40}$/.test(manifest.revision) || manifest.dtype !== "q4") {
    throw new Error("A configuração do modelo é inválida. Atualize a página antes de instalar.");
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > 2_000_000_000) {
    throw new Error("O tamanho do modelo não é compatível com esta versão do site.");
  }
  const sizes = manifest.sizes;
  if (!sizes || typeof sizes !== "object" || ["embed_tokens", "vision_encoder", "decoder_model_merged"].some((name) => !sizes[`onnx/${name}_q4.onnx`] || !sizes[`onnx/${name}_q4.onnx_data`]) ||
      Object.values(sizes).some((size) => !Number.isSafeInteger(size) || size <= 0) || Object.values(sizes).reduce((a, b) => a + b, 0) !== manifest.bytes) {
    throw new Error("A lista de arquivos do modelo está incompleta. Atualize a página e tente novamente.");
  }
  return manifest;
}

// Stop runaway decoding without replacing, correcting or completing the OCR.
export function repeatsTokens(tokens) {
  const tail = tokens.slice(-128);
  for (let width = 1; width <= 16; width++) {
    const count = width * 8;
    if (tail.length < Math.max(64, count)) continue;
    const start = tail.length - count;
    if (tail.slice(start).every((value, index) => value === tail[start + index % width])) return true;
  }
  return false;
}

export function recognitionWarnings({ repeated = false, limited = false } = {}) {
  const warnings = ["OCR por modelo generativo: confira nomes, números e trechos pouco legíveis com o original."];
  if (repeated) warnings.push("A leitura foi interrompida por repetição. O texto pode estar incompleto; tente outro motor nesta página.");
  if (limited) warnings.push("Esta página atingiu o limite de leitura. O texto pode estar incompleto; confira o final da página.");
  return warnings;
}
