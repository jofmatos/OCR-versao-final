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
html = html.replace('      <section id="emptyState"', `      <section class="local-model-panel" aria-label="OCR no dispositivo"><div><strong>O processamento é feito neste computador</strong><p id="modelStatus" role="status" aria-live="polite">No primeiro uso, os modelos de OCR são baixados e guardados no navegador. Seus PDFs não são enviados.</p></div><div class="local-actions"><button class="button secondary small" id="prepareModels">Preparar OCR neste dispositivo</button><button class="button dark small" id="installApp" hidden>Usar como aplicativo</button></div></section>\n      <section id="emptyState"`);
html = html.replace("O resultado pode precisar de revisão, especialmente em manuscritos e tabelas.", "Deixe esta página aberta durante a extração. Revise manuscritos, números e tabelas.");
await writeFile(path.join(output, "index.html"), html);
await writeFile(path.join(output, ".nojekyll"), "");
await mkdir(path.join(output, "icons"), { recursive: true });
for (const size of [192, 512]) await cp(`browser/icons/icon-${size}.png`, path.join(output, "icons", `icon-${size}.png`));
await writeFile(path.join(output, "manifest.webmanifest"), JSON.stringify({ name: "Lume OCR", short_name: "Lume OCR", lang: "pt-BR", start_url: "./", scope: "./", display: "standalone", background_color: "#f8f9f7", theme_color: "#17272f", icons: [192, 512].map((size) => ({ src: `./icons/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any maskable" })) }, null, 2));
let worker = await readFile("browser/sw.js", "utf8");
const version = createHash("sha256").update(await readFile(path.join(output, "static/browser.js"))).update(await readFile(path.join(output, "static/app.js"))).update(await readFile(path.join(output, "static/styles.css"))).update(html).digest("hex").slice(0, 12);
worker = worker.replace("lume-browser-v1", `lume-browser-${version}`);
await writeFile(path.join(output, "sw.js"), worker);
console.log("Versão de navegador preparada em docs/ (sem servidor de aplicação, CDNs ou envio de PDFs).");
