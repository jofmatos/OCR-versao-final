#!/usr/bin/env python3
"""Exercise the running UI with real PDFs, OCR, editing and downloads."""
from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from docx import Document
import pymupdf
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import expect, sync_playwright


def fixtures(directory: Path) -> tuple[Path, Path]:
    native = directory / "Relatório de revisão.pdf"
    scan = directory / "Digitalização.pdf"
    with pymupdf.open() as pdf:
        for text in ["Conversão de documentos. Informação em português.", "Segunda página. Educação e comunicação."]:
            page = pdf.new_page()
            page.insert_text((55, 85), text, fontsize=16)
        pdf.save(native)
    image = Image.new("RGB", (1654, 2339), "white")
    font_file = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    font = ImageFont.truetype(str(font_file), 42) if font_file.exists() else ImageFont.load_default(size=42)
    draw = ImageDraw.Draw(image)
    for index, text in enumerate([
        "Conversão de documentos em português.",
        "Informação, educação e comunicação.",
        "Uma transcrição deve preservar acentuação.",
        "Este relatório contém o número 12345.",
    ]):
        draw.text((90, 300 + 80 * index), text, fill="black", font=font)
    stream = BytesIO()
    image.save(stream, format="PNG")
    with pymupdf.open() as pdf:
        page = pdf.new_page()
        page.insert_image(page.rect, stream=stream.getvalue())
        pdf.save(scan)
    return native, scan


def run(base_url: str, artifacts: Path, executable: str | None, browser_mode: bool = False):
    artifacts.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="lume-smoke-") as temporary, sync_playwright() as playwright:
        native, scan = fixtures(Path(temporary))
        browser = playwright.chromium.launch(executable_path=executable, headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
        network = []
        context.on("request", lambda request: network.append((request.method, request.url)))
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base_url, wait_until="networkidle")
        expect(page.locator("#connectionLabel")).to_have_text("OCR disponível")
        page.screenshot(path=str(artifacts / "desktop.png"), full_page=True)
        if browser_mode:
            # New HTML must not reuse old, unversioned code from an active SW.
            page.evaluate("navigator.serviceWorker.ready.then(() => true)")
            page.wait_for_function("navigator.serviceWorker.controller !== null")
            page.evaluate("""async () => {
                const key = (await caches.keys()).find(key => key.startsWith('lume-browser-'));
                const cache = await caches.open(key);
                for (const path of ['static/browser.js', 'static/app.js', 'static/paddle-worker.js']) {
                    await cache.put(new URL(path, document.baseURI), new Response('self.oldCachedCode = true;', {headers: {'Content-Type': 'text/javascript'}}));
                }
            }""")
            page.reload(wait_until="networkidle")
            expect(page.locator("#connectionLabel")).to_have_text("OCR disponível")
            assert not page.evaluate("Boolean(window.oldCachedCode)"), "Old cached script was reused"
            # A failed model installation must leave the working engine usable.
            context.route("https://media.githubusercontent.com/**", lambda route: route.fulfill(status=503, body="Unavailable", headers={"Access-Control-Allow-Origin": "*"}))
            context.route("https://raw.githubusercontent.com/**", lambda route: route.fulfill(status=503, body="Unavailable", headers={"Access-Control-Allow-Origin": "*"}))
            delayed_worker = []
            context.route("**/static/paddle-worker.js*", lambda route: delayed_worker.append(route))
            page.locator("#installAdvanced").click()
            expect(page.locator("#modelStatus")).to_contain_text("Preparando OCR avançado")
            expect(page.locator("#installAdvanced")).to_have_text("Instalando OCR avançado…")
            expect(page.locator("#prepareModels")).to_be_disabled()
            expect(page.locator("#ocrEngine")).to_be_disabled()
            page.wait_for_timeout(200)
            assert delayed_worker, "Advanced worker was not requested"
            delayed_worker[0].continue_()
            context.unroute("**/static/paddle-worker.js*")
            expect(page.locator("#modelStatus")).to_contain_text("OCR básico continua disponível", timeout=30000)
            expect(page.locator("#installAdvanced")).to_be_enabled()
            expect(page.locator("#installAdvanced")).to_have_text("Tentar instalar OCR avançado")
            expect(page.locator("#ocrEngine")).to_have_value("tesseract")
            context.unroute("https://media.githubusercontent.com/**")
            context.unroute("https://raw.githubusercontent.com/**")
            print("Advanced install OK: versioned code ignores stale cache; slow startup shows feedback; download failure preserves basic engine.")

        page.locator("#fileInput").set_input_files(str(native))
        expect(page.locator("#documentName")).to_have_text(native.name)
        expect(page.locator("#pagePreview")).to_be_visible()
        page.locator("#pageRange").fill("3")
        page.locator("#convertButton").click()
        expect(page.locator("#alertText")).to_contain_text("entre 1 e 2")
        page.locator("#pageRange").fill("")
        page.locator("#convertButton").click()
        expect(page.locator("#exportDocx")).to_be_enabled(timeout=60000)
        expect(page.locator("#pageText")).to_have_value("Conversão de documentos. Informação em português.")
        page.locator("#pageText").fill("Texto revisado: ação, educação e 12345.")
        page.locator("#nextPage").click()
        assert "Segunda página" in page.locator("#pageText").input_value()
        page.locator("#pageText").fill("Segunda página revisada.")

        for kind, button in [("txt", "#exportTxt"), ("docx", "#exportDocx")]:
            with page.expect_download() as pending:
                page.locator(button).click()
            download = pending.value
            output = artifacts / f"resultado.{kind}"
            download.save_as(str(output))
            text = output.read_text("utf-8") if kind == "txt" else "\n".join(p.text for p in Document(output).paragraphs)
            assert "Texto revisado: ação, educação e 12345." in text
            assert "Segunda página revisada." in text
        page.reload(wait_until="networkidle")
        expect(page.locator("#pageText")).to_have_value("Texto revisado: ação, educação e 12345.")
        page.screenshot(path=str(artifacts / "editor.png"), full_page=True)

        page.set_viewport_size({"width": 390, "height": 844})
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth"), "Mobile layout overflows"
        page.screenshot(path=str(artifacts / "mobile.png"), full_page=True)
        page.locator("#removeFile").click()
        page.locator("#confirmAction").click()
        expect(page.locator("#emptyState")).to_be_visible()

        page.set_viewport_size({"width": 1440, "height": 1000})
        page.locator("#fileInput").set_input_files(str(scan))
        expect(page.locator("#documentName")).to_have_text(scan.name)
        page.locator("#quality").select_option("high")
        page.locator("#convertButton").click()
        expect(page.locator("#exportDocx")).to_be_enabled(timeout=120000)
        expect(page.locator("#pageMethod")).to_have_text("Reconhecido por OCR")
        text = page.locator("#pageText").input_value()
        assert "português" in text and "12345" in text and "acentuação" in text
        expect(page.locator("#confidence")).to_contain_text("Confiança OCR:")
        page.screenshot(path=str(artifacts / "ocr.png"), full_page=True)
        if browser_mode:
            page.evaluate("navigator.serviceWorker.ready.then(() => true)")
            page.wait_for_function("navigator.serviceWorker.controller !== null")
            context.set_offline(True)
            page.reload(wait_until="domcontentloaded")
            expect(page.locator("#exportDocx")).to_be_enabled(timeout=30000)
            assert "12345" in page.locator("#pageText").input_value()
            page.locator("#convertButton").click()
            page.locator("#confirmAction").click()
            expect(page.locator("#exportDocx")).to_be_enabled(timeout=120000)
            assert "português" in page.locator("#pageText").input_value()
            context.set_offline(False)
            assert not any(method != "GET" for method, url in network if url.startswith("http")), "Document content sent over network"
            assert not any("/api/" in url for method, url in network), "Static version tried a backend API"
            print("Offline OCR OK: cached models reused; no PDF upload or backend API.")
        page.locator("#removeFile").click()
        page.locator("#confirmAction").click()
        expect(page.locator("#emptyState")).to_be_visible()
        page.locator("#fileInput").set_input_files({"name": "inválido.pdf", "mimeType": "application/pdf", "buffer": b"not a PDF"})
        expect(page.locator("#alertText")).to_contain_text("PDF válido")
        assert not errors, errors
        browser.close()
    print("Browser OK: native PDF, previews, page selection, edits, TXT/DOCX, reload, mobile, real Portuguese OCR, deletion and invalid upload.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--artifacts", type=Path, default=Path("test-results"))
    parser.add_argument("--browser", default=shutil.which("chromium") or shutil.which("google-chrome"))
    parser.add_argument("--browser-mode", action="store_true", help="Verify static processing, local models, offline reopening, and no uploads")
    arguments = parser.parse_args()
    run(arguments.base_url, arguments.artifacts, arguments.browser, arguments.browser_mode)
