export class PaddleClient {
  constructor(onProgress) {
    this.pending = new Map();
    this.counter = 0;
    this.alive = true;
    const workerUrl = new URL("./paddle-worker.js", import.meta.url);
    workerUrl.search = new URL(import.meta.url).search;
    this.worker = new Worker(workerUrl, { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.progress) { onProgress(data.progress); return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timeout);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    this.worker.onerror = () => this.terminate("Não foi possível carregar o motor avançado neste navegador.");
  }
  request(type, payload = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      if (!this.alive) { reject(new Error("O motor foi interrompido. Inicie a leitura novamente.")); return; }
      const timeout = setTimeout(() => this.terminate("O OCR avançado excedeu o tempo de espera. Tente menos páginas ou o motor básico."), 180000);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  async recognize(canvas, quality) {
    return this.request("recognize", { image: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height), quality });
  }
  terminate(message = "A leitura foi interrompida.") {
    this.worker.terminate();
    this.alive = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error(message)); }
    this.pending.clear();
  }
}
