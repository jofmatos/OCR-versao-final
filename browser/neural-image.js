// Bound the quadratic vision attention allocation, including the processor's
// rounding to 28-pixel blocks. Long-edge limits alone do not bound this tensor.
export const MAX_VISION_PATCHES = 2048;

export function imageBands(image, maxPatches = MAX_VISION_PATCHES) {
  const { width, height, data, channels = 3 } = image;
  const columns = Math.ceil(width / 28) * 2;
  const limit = Math.floor(maxPatches / columns / 2) * 28;
  if (limit < 28) throw new Error("Esta página é larga demais para o motor de documentos.");
  const rowBlank = (y) => {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      if (data[at] < 250 || data[at + 1] < 250 || data[at + 2] < 250) return false;
    }
    return true;
  };
  const bands = [];
  for (let top = 0; top < height;) {
    let bottom = Math.min(height, top + limit);
    // Prefer a gap between text lines, without overlaps or duplicated text.
    if (bottom < height) {
      for (let y = bottom - 2; y >= top + Math.floor(limit * .65); y--) {
        if (rowBlank(y) && rowBlank(y - 1) && rowBlank(y + 1)) { bottom = y; break; }
      }
    }
    let blank = true;
    for (let y = top; y < bottom && blank; y++) blank = rowBlank(y);
    bands.push({ top, bottom, blank });
    top = bottom;
  }
  return bands;
}

export function readableNeuralError(error) {
  const message = error?.message || "Não foi possível concluir a leitura.";
  if (/Integer overflow|out of memory|memory access out of bounds|allocation failed/i.test(message)) {
    return "O motor atingiu um limite de memória ao ler esta página. Tente a qualidade padrão ou selecione outro motor.";
  }
  return message;
}
