export function devicePolicy(device, secure = true) {
  const agent = device.userAgent || "";
  const ios = /iPhone|iPad|iPod/i.test(agent) || (/Mac/i.test(device.platform || "") && device.maxTouchPoints > 1);
  const mobile = ios || Boolean(device.userAgentData?.mobile) || /Android|Mobile/i.test(agent);
  const mac = !mobile && /Mac/i.test(device.platform || agent);
  const memory = Number(device.deviceMemory);
  const neuralReason = mobile ? "Nesta versão, o motor de documentos está disponível somente no computador. No celular, use Tesseract ou PaddleOCR." :
    !secure || !device.gpu ? "O motor de documentos precisa de WebGPU. Use Chrome atualizado em um computador, com aceleração gráfica ativada." :
    memory > 0 && memory < 8 ? "O motor de documentos precisa de mais memória. Neste computador, use Tesseract ou PaddleOCR." : "";
  return { mobile, ios, mac, neuralReason, visionReason: mac ? "" : "Apple Vision usa o aplicativo auxiliar do Mac; não está disponível neste aparelho.", pixelLimit: mobile ? 4_000_000 : memory > 0 && memory <= 4 ? 6_000_000 : 12_000_000 };
}

export function compatibleEngine(saved, policy) {
  if (saved === "neural") return policy.neuralReason ? "tesseract" : saved;
  if (saved === "vision") return policy.visionReason ? "tesseract" : saved;
  return saved === "paddle" ? saved : "tesseract";
}
