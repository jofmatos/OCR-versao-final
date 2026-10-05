import { build } from "esbuild";
import { readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const output = path.join(root, "docs");
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "static"), { recursive: true });
await mkdir(path.join(output, "vendor/tesseract/core"), { recursive: true });
await mkdir(path.join(output, "vendor/pdf"), { recursive: true });
await mkdir(path.join(output, "models"), { recursive: true });
let macHelperAvailable = false;
try {
  await mkdir(path.join(output, "downloads"), { recursive: true });
  await cp(".cache/mac-build/Lume-OCR-Mac.zip", path.join(output, "downloads/Lume-OCR-Mac.zip"));
  macHelperAvailable = true;
} catch (error) { if (error.code !== "ENOENT") throw error; }

for (const name of ["app.js", "styles.css", "favicon.svg"]) await cp(`app/static/${name}`, path.join(output, "static", name));
await build({ entryPoints: ["browser/client.js"], outfile: path.join(output, "static/browser.js"), bundle: true, minify: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "linked" });
await build({ entryPoints: ["browser/paddle-worker.js"], outfile: path.join(output, "static/paddle-worker.js"), bundle: true, minify: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "linked", external: ["fs", "path"] });
await build({ entryPoints: ["browser/neural-worker.js"], outfile: path.join(output, "static/neural-worker.js"), bundle: true, minify: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "linked" });
let neuralManifest = { available: false };
try { neuralManifest = JSON.parse(await readFile(".cache/neural-model.json", "utf8")); }
catch (error) { if (error.code !== "ENOENT" || process.env.LUME_REQUIRE_NEURAL_MODEL) throw error; }
const neuralJson = JSON.stringify(neuralManifest, null, 2);
await writeFile(path.join(output, "static/neural-model.json"), neuralJson);
let neuralComparison = "";
try { neuralComparison = await readFile(".cache/neural-comparison.json", "utf8"); await writeFile(path.join(output, "static/ocr-comparison.json"), neuralComparison); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const require = createRequire(import.meta.url);
const transformerRequire = createRequire(require.resolve("@huggingface/transformers"));
const transformerOrt = path.dirname(transformerRequire.resolve("onnxruntime-web"));
await mkdir(path.join(output, "vendor/transformers"), { recursive: true });
for (const suffix of ["mjs", "wasm"]) await cp(path.join(transformerOrt, `ort-wasm-simd-threaded.asyncify.${suffix}`), path.join(output, "vendor/transformers", `ort-wasm-simd-threaded.asyncify.${suffix}`));
await mkdir(path.join(output, "vendor/onnx"), { recursive: true });
for (const variant of ["", ".jsep"]) for (const suffix of ["mjs", "wasm"]) await cp(`node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded${variant}.${suffix}`, path.join(output, "vendor/onnx", `ort-wasm-simd-threaded${variant}.${suffix}`));
await cp("node_modules/tesseract.js/dist/worker.min.js", path.join(output, "vendor/tesseract/worker.min.js"));
await cp("node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt", path.join(output, "vendor/tesseract/worker.min.js.LICENSE.txt"));
for (const name of await readdir("node_modules/tesseract.js-core")) {
  if (name.endsWith(".wasm.js") || name === "LICENSE") await cp(`node_modules/tesseract.js-core/${name}`, path.join(output, "vendor/tesseract/core", name));
}
for (const name of ["cmaps", "standard_fonts", "wasm", "LICENSE"]) await cp(`node_modules/pdfjs-dist/${name}`, path.join(output, "vendor/pdf", name), { recursive: true });
await cp("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", path.join(output, "vendor/pdf/pdf.worker.min.mjs"));
for (const name of ["por", "eng", "spa"]) await cp(`node_modules/@tesseract.js-data/${name}/4.0.0_best_int/${name}.traineddata.gz`, path.join(output, "models", `${name}.traineddata.gz`));

let html = await readFile("app/static/index.html", "utf8");
html = html.replaceAll('href="/static/', 'href="./static/').replaceAll('href="/"', 'href="./"');
html = html.replace('<script src="/static/app.js" defer></script>', '<script type="module" src="./static/browser.js"></script>');
html = html.replaceAll("Processamento no seu servidor", "Processamento no seu computador");
html = html.replace("Processado neste servidor. Exclusão automática em 24 h, ou quando você quiser.", "Seu PDF fica neste navegador. Você pode removê-lo quando terminar.");
html = html.replace('  <meta name="theme-color"', '  <link rel="manifest" href="./manifest.webmanifest">\n  <meta name="theme-color"');
html = html.replace('      <section id="emptyState"', `      <section class="local-model-panel" aria-label="OCR no dispositivo"><div><strong>Instale um motor de OCR neste navegador</strong><p id="modelStatus" role="status" aria-live="polite">PaddleOCR v5 para português, inglês e espanhol. O primeiro uso baixa cerca de 13 MB de modelos, além do motor. Seus PDFs ficam neste computador.</p><label for="ocrEngine">Motor de leitura</label><select id="ocrEngine"><option value="paddle">PaddleOCR · avançado (experimental)</option><option value="tesseract" selected>Tesseract · básico</option></select></div><div class="local-actions"><button class="button primary small" id="installAdvanced">Instalar OCR avançado</button><button class="button secondary small" id="prepareModels">Preparar OCR básico</button><button class="button dark small" id="installApp" hidden>Usar como aplicativo</button></div></section>\n      <section id="emptyState"`);
html = html.replace("Instale um motor de OCR neste navegador", "Escolha um motor de OCR");
html = html.replace(">Instalar OCR avançado</button>", ">Instalar PaddleOCR</button>");
html = html.replace("PaddleOCR v5 para português, inglês e espanhol. O primeiro uso baixa cerca de 13 MB de modelos, além do motor. Seus PDFs ficam neste computador.", "O novo motor de documentos, Tesseract e PaddleOCR rodam no navegador. Apple Vision usa o OCR nativo do Mac. Seus documentos ficam neste aparelho.");
html = html.replace('<option value="paddle">', `<option value="neural">${neuralManifest.label || "LightOnOCR"} · documentos (WebGPU)</option><option value="paddle">`);
html = html.replace('<option value="paddle">', '<option value="vision">Apple Vision · OCR nativo do Mac</option><option value="paddle">');
html = html.replace('      <section id="emptyState"', `      <section id="macVisionPanel" class="local-model-panel mac-vision-panel" aria-label="Preparar Apple Vision" hidden><div><strong>Apple Vision no seu Mac</strong><p>Um aplicativo auxiliar conecta este site ao OCR do macOS 13 ou posterior, em Macs Intel ou Apple Silicon. Não precisa baixar um modelo de IA.</p><ol><li>Baixe e abra o aplicativo <b>Lume OCR Mac</b>.</li><li>Se o macOS bloquear a primeira abertura, autorize o app em <b>Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim</b>. O aplicativo ainda não tem notarização da Apple.</li><li>Deixe o app aberto e clique em <b>Conectar ao Mac</b>. No Chrome, permita o acesso à rede local se solicitado.</li></ol><p>As imagens das páginas são enviadas somente ao aplicativo neste Mac. O texto volta para edição e download no site.</p></div><div class="local-actions">${macHelperAvailable ? '<a id="downloadMacVision" class="button secondary small" href="./downloads/Lume-OCR-Mac.zip" download>Baixar Lume OCR Mac</a>' : '<span class="field-help">Download do app disponível após a compilação e publicação no Mac.</span>'}<button id="connectMacVision" class="button primary small">Conectar ao Mac</button></div></section>\n      <section id="emptyState"`);
html = html.replace("O resultado pode precisar de revisão, especialmente em manuscritos e tabelas.", "Deixe esta página aberta durante a extração. Revise manuscritos, números e tabelas.");
const modelSize = neuralManifest.bytes ? `${Math.ceil(neuralManifest.bytes / 1048576).toLocaleString("pt-BR")} MB` : "disponível após a validação do modelo";
html = html.replace('      <section id="emptyState"', `      <section id="neuralPanel" data-model-label="${neuralManifest.label || "LightOnOCR"}" class="local-model-panel mac-vision-panel" aria-label="Preparar ${neuralManifest.label || "LightOnOCR"}" hidden><div><strong>${neuralManifest.name || "LightOnOCR-2-1B"} no navegador</strong><p>Modelo especializado em leitura de documentos. Usa a GPU deste aparelho por WebGPU e não envia suas páginas para um servidor.</p><p>Download inicial: <b>${modelSize}</b>, além do motor. Os arquivos são guardados pelo navegador para reutilização. Recomendado para Chrome atualizado no Mac com 8 GB de memória ou mais. A disponibilidade no iPhone/iPad depende do navegador e da memória.</p><p>Deixe a aba aberta durante a preparação. Confira o resultado com o original, especialmente nomes, números e imagens pouco legíveis.</p><progress id="neuralProgress" max="100" aria-label="Preparação do modelo de documentos" hidden></progress></div><div class="local-actions"><button id="installNeural" class="button primary small">Instalar ${neuralManifest.label || "LightOnOCR"}</button><button id="cancelNeural" class="button secondary small" hidden>Cancelar ${neuralManifest.label || "LightOnOCR"}</button></div></section>\n      <section id="emptyState"`);
await writeFile(path.join(output, ".nojekyll"), "");
await mkdir(path.join(output, "icons"), { recursive: true });
for (const size of [192, 512]) await cp(`browser/icons/icon-${size}.png`, path.join(output, "icons", `icon-${size}.png`));
await writeFile(path.join(output, "manifest.webmanifest"), JSON.stringify({ name: "Lume OCR", short_name: "Lume OCR", lang: "pt-BR", start_url: "./", scope: "./", display: "standalone", background_color: "#f8f9f7", theme_color: "#17272f", icons: [192, 512].map((size) => ({ src: `./icons/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any maskable" })) }, null, 2));
let worker = await readFile("browser/sw.js", "utf8");
const version = createHash("sha256").update(await readFile(path.join(output, "static/browser.js"))).update(await readFile(path.join(output, "static/paddle-worker.js"))).update(await readFile(path.join(output, "static/neural-worker.js"))).update(neuralJson).update(neuralComparison).update(await readFile(path.join(output, "static/app.js"))).update(await readFile(path.join(output, "static/styles.css"))).update(html).update(worker).digest("hex").slice(0, 12);
html = html.replaceAll('./static/styles.css"', `./static/styles.css?v=${version}"`).replaceAll('./static/browser.js"', `./static/browser.js?v=${version}"`);
await writeFile(path.join(output, "index.html"), html);
worker = worker.replace("lume-browser-v1", `lume-browser-${version}`).replace("__BUILD_VERSION__", version);
await writeFile(path.join(output, "sw.js"), worker);
console.log("Versão de navegador preparada em docs/ (sem servidor de aplicação, CDNs ou envio de PDFs).");
