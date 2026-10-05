export class NeuralClient {
  constructor(onProgress) {
    this.pending = new Map();
    this.counter = 0;
    this.alive = true;
    const url = new URL("./neural-worker.js", import.meta.url);
    url.search = new URL(import.meta.url).search;
    this.worker = new Worker(url, { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.progress) { onProgress(data.progress); return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timeout);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    this.worker.onerror = () => this.terminate("O motor de OCR foi interrompido. Feche outras abas para liberar memória e tente novamente.");
  }
  request(type, payload = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error("O OCR foi interrompido. Tente novamente.")); return; }
      const timeout = setTimeout(() => this.terminate("O OCR excedeu o tempo de espera. Tente uma página por vez ou outro motor."), type === "init" ? 900000 : 600000);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  recognize(canvas, quality) {
    const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    return this.request("recognize", { image, quality });
  }
  terminate(message = "OCR cancelado. Você pode instalar ou extrair novamente.") {
    if (!this.alive) return;
    this.alive = false;
    this.worker.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error(message)); }
    this.pending.clear();
  }
}
