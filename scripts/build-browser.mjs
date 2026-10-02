import { build } from "esbuild";
import { readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "docs");
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "static"), { recursive: true });
await mkdir(path.join(output, "vendor/tesseract/core"), { recursive: true });
await mkdir(path.join(output, "vendor/pdf"), { recursive: true });
await mkdir(path.join(output, "models"), { recursive: true });

for (const name of ["app.js", "styles.css", "favicon.svg"]) await cp(`app/static/${name}`, path.join(output, "static", name));
await build({ entryPoints: ["browser/client.js"], outfile: path.join(output, "static/browser.js"), bundle: true, minify: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "linked" });
await build({ entryPoints: ["browser/paddle-worker.js"], outfile: path.join(output, "static/paddle-worker.js"), bundle: true, minify: true, format: "esm", platform: "browser", target: ["es2022"], legalComments: "linked", external: ["fs", "path"] });
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
html = html.replace("O resultado pode precisar de revisão, especialmente em manuscritos e tabelas.", "Deixe esta página aberta durante a extração. Revise manuscritos, números e tabelas.");
await writeFile(path.join(output, ".nojekyll"), "");
await mkdir(path.join(output, "icons"), { recursive: true });
for (const size of [192, 512]) await cp(`browser/icons/icon-${size}.png`, path.join(output, "icons", `icon-${size}.png`));
await writeFile(path.join(output, "manifest.webmanifest"), JSON.stringify({ name: "Lume OCR", short_name: "Lume OCR", lang: "pt-BR", start_url: "./", scope: "./", display: "standalone", background_color: "#f8f9f7", theme_color: "#17272f", icons: [192, 512].map((size) => ({ src: `./icons/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any maskable" })) }, null, 2));
let worker = await readFile("browser/sw.js", "utf8");
const version = createHash("sha256").update(await readFile(path.join(output, "static/browser.js"))).update(await readFile(path.join(output, "static/paddle-worker.js"))).update(await readFile(path.join(output, "static/app.js"))).update(await readFile(path.join(output, "static/styles.css"))).update(html).update(worker).digest("hex").slice(0, 12);
html = html.replaceAll('./static/styles.css"', `./static/styles.css?v=${version}"`).replaceAll('./static/browser.js"', `./static/browser.js?v=${version}"`);
await writeFile(path.join(output, "index.html"), html);
worker = worker.replace("lume-browser-v1", `lume-browser-${version}`).replace("__BUILD_VERSION__", version);
await writeFile(path.join(output, "sw.js"), worker);
console.log("Versão de navegador preparada em docs/ (sem servidor de aplicação, CDNs ou envio de PDFs).");
