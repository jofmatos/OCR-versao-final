const endpoint = "http://127.0.0.1:17861";

export class MacVision {
  controller = null;
  alive = true;
  async fetch(path, options = {}) {
    if (!this.alive) throw new Error("A extração foi interrompida.");
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), path === "/health" ? 15000 : 120000);
    try {
      const response = await fetch(endpoint + path, { ...options, signal: controller.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "O OCR do Mac não conseguiu ler esta página.");
      return result;
    } finally { clearTimeout(timeout); if (this.controller === controller) this.controller = null; }
  }
  async connect() {
    let result;
    try { result = await this.fetch("/health"); }
    catch { throw new Error("Abra o aplicativo Lume OCR Mac e permita o acesso à rede local no Chrome. Depois clique em Conectar novamente."); }
    if (result.engine !== "apple-vision" || result.version !== 1) throw new Error("Atualize o aplicativo Lume OCR Mac para conectar.");
  }
  async recognize(canvas, language) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Não foi possível preparar a imagem para o OCR do Mac.");
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = () => reject(new Error("Não foi possível ler a imagem.")); reader.readAsDataURL(blob);
    });
    const result = await this.fetch("/recognize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image, language }) });
    if (typeof result.text !== "string" || result.text.length > 500000) throw new Error("O OCR do Mac retornou um resultado inválido.");
    return result;
  }
  terminate() { this.alive = false; this.controller?.abort(); }
}
