#!/usr/bin/env python3
"""Run the actual quantized OCR model through the published browser bundle."""
import argparse
from difflib import SequenceMatcher
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import time
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from urllib.parse import urlsplit

import pymupdf
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import TimeoutError as BrowserTimeout, expect, sync_playwright

EXPECTED = [
    "Uma transcrição deve preservar acentuação.",
    "Informação, educação e comunicação: 12345.",
    "Valor: R$ 1.234,56. Data: 05/10/2026.",
]


def normalized(text):
    return re.sub(r"\s+", " ", text).strip().casefold()


def notice(stage, message):
    print(f"{stage}: {message}", flush=True)
    if os.environ.get("GITHUB_ACTIONS"):
        escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::notice title={stage}::{escaped[:1500]}", flush=True)


def wait_condition(page, predicate, timeout, stage, artifacts):
    deadline = time.monotonic() + timeout / 1000
    last_status = None
    while True:
        remaining = max(1, int((deadline - time.monotonic()) * 1000))
        try:
            page.wait_for_function(predicate, timeout=min(60000, remaining))
            notice(stage, page.locator("#modelStatus").inner_text())
            return
        except BrowserTimeout:
            status = page.locator("#modelStatus").inner_text()
            if time.monotonic() >= deadline:
                message = f"{stage} exceeded {timeout / 1000:.0f}s. Last browser status: {status}"
                (artifacts / "model-error.txt").write_text(message)
                raise RuntimeError(message)
            if status != last_status:
                notice(stage, status)
                last_status = status


def run(artifacts: Path, baseline=False):
    artifacts.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="lume-neural-") as temp:
        directory = Path(temp)
        prefix = directory / "site"
        prefix.mkdir()
        (prefix / "OCR-versao-final").symlink_to(Path("docs").resolve(), target_is_directory=True)
        image = Image.new("RGB", (1000, 260), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 36)
        for index, text in enumerate(EXPECTED):
            draw.text((48, 24 + index * 74), text, fill="black", font=font)
        png = BytesIO()
        image.save(png, "PNG")
        scan = directory / "Português.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page(width=1000, height=260)
            page.insert_image(page.rect, stream=png.getvalue())
            pdf.save(scan)
        server = subprocess.Popen(["python3", "-m", "http.server", "8082", "--bind", "127.0.0.1", "--directory", str(prefix)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            base = "http://127.0.0.1:8082/OCR-versao-final/"
            for attempt in range(100):
                try:
                    with urlopen(base, timeout=2) as response:
                        if response.status == 200: break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError("Test site did not start")
            with sync_playwright() as playwright:
                proxy_server = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
                browser = playwright.chromium.launch(executable_path=os.environ.get("LUME_TEST_BROWSER"), headless=True,
                    proxy={"server": proxy_server, "bypass": "127.0.0.1,localhost"} if proxy_server else None,
                    args=["--no-sandbox", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-vulkan-surface"])
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
                network = []
                context.on("request", lambda request: network.append((request.method, request.url)))
                context.on("requestfailed", lambda request: print("Request failed:", urlsplit(request.url).hostname, urlsplit(request.url).path, request.failure, flush=True))
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda message: print("browser:", message.text) if message.type == "error" else None)
                page.goto(base, wait_until="networkidle")
                page.evaluate("navigator.serviceWorker.ready.then(() => true)")
                page.wait_for_function("navigator.serviceWorker.controller !== null")
                adapter = page.evaluate("async () => {const a = await navigator.gpu?.requestAdapter(); return a ? {features: [...a.features], info: {...a.info}} : null;}")
                assert adapter, "Headless Chromium did not expose WebGPU"
                print("WebGPU adapter:", json.dumps(adapter))
                page.locator("#ocrEngine").select_option("neural")
                label = page.locator("#neuralPanel").get_attribute("data-model-label")
                page.locator("#installNeural").click()
                wait_condition(page, "!window.LumeBrowser.neuralPromise && !document.getElementById('installNeural').disabled", 900000, f"{label} loading", artifacts)
                if page.locator("#installNeural").inner_text() != f"{label} preparado":
                    (artifacts / "model-error.txt").write_text(page.locator("#modelStatus").inner_text())
                assert page.locator("#installNeural").inner_text() == f"{label} preparado", page.locator("#modelStatus").inner_text()
                page.locator("#fileInput").set_input_files(str(scan))
                expect(page.locator("#documentName")).to_have_text(scan.name)
                page.locator("#quality").select_option("standard")
                page.locator("#convertButton").click()
                wait_condition(page, "['ready', 'error'].includes(window.LumeBrowser?.record?.doc.status)", 600000, f"{label} recognition", artifacts)
                doc = page.evaluate("window.LumeBrowser.record.doc")
                if doc["status"] != "ready":
                    (artifacts / "model-error.txt").write_text(doc.get("error") or "OCR failed")
                assert doc["status"] == "ready", doc.get("error")
                expect(page.locator("#exportTxt")).to_be_enabled(timeout=10000)
                text = page.locator("#pageText").input_value()
                (artifacts / "recognized-text.txt").write_text(text)
                print("Actual OCR:", text)
                score = SequenceMatcher(None, normalized(" ".join(EXPECTED)), normalized(text)).ratio()
                assert score >= .93, f"Portuguese OCR similarity {score:.3f} is below .93: {text!r}"
                for value in ["acentuação", "educação", "12345", "1.234,56", "05/10/2026"]:
                    assert value in text, f"Important text was changed: {value!r} in {text!r}"
                assert doc["pages"][0]["engine"] == "neural"
                assert doc["pages"][0]["confidence"] is None, "A fabricated confidence score was displayed"
                assert any("generativo" in item for item in doc["pages"][0]["warnings"])
                with page.expect_download() as download:
                    page.locator("#exportTxt").click()
                download.value.save_as(str(artifacts / "actual-ocr.txt"))
                assert normalized((artifacts / "actual-ocr.txt").read_text()) == normalized(text)
                page.screenshot(path=str(artifacts / "actual-browser-ocr.png"), full_page=True)
                assert not errors, errors
                assert not any(method != "GET" for method, url in network if url.startswith("http")), "Document data was uploaded"
                # A new worker must be able to load its models without network.
                page.evaluate("window.LumeBrowser.neural.terminate(); window.LumeBrowser.neural = null;")
                context.set_offline(True)
                page.locator("#installNeural").click()
                wait_condition(page, "!window.LumeBrowser.neuralPromise && !document.getElementById('installNeural').disabled", 300000, f"{label} offline reload", artifacts)
                assert page.locator("#installNeural").inner_text() == f"{label} preparado", page.locator("#modelStatus").inner_text()
                context.set_offline(False)
                baselines = {}
                if baseline:
                    for engine in ["paddle", "tesseract"]:
                        page.locator("#ocrEngine").select_option(engine)
                        page.locator("#convertButton").click()
                        if page.locator("#confirmAction").is_visible():
                            page.locator("#confirmAction").click()
                        page.wait_for_function("['ready', 'error'].includes(window.LumeBrowser?.record?.doc.status)", timeout=300000)
                        result = page.evaluate("window.LumeBrowser.record.doc")
                        if result["status"] == "ready":
                            recognized = result["pages"][0]["text"]
                            baselines[engine] = {"similarity": SequenceMatcher(None, normalized(" ".join(EXPECTED)), normalized(recognized)).ratio(), "text": recognized}
                        else:
                            baselines[engine] = {"error": result.get("error")}
                assert not any(method != "GET" for method, url in network if url.startswith("http")), "Document data was uploaded"
                (artifacts / "report.json").write_text(json.dumps({"model": label, "dtype": "q4", "quality": "standard", "fixture_pixels": [1000, 260], "portuguese_similarity": score, "native_browser_webgpu": True, "cached_offline_restart": True, "document_uploads": False, "baselines": baselines}, indent=2) + "\n")
                browser.close()
                print(f"Actual browser OCR passed: Portuguese similarity {score:.3f}, accents, numbers, TXT, WebGPU and offline model reload.")
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path("test-results/neural"))
    parser.add_argument("--baseline", action="store_true")
    arguments = parser.parse_args()
    try:
        run(arguments.artifacts, arguments.baseline)
    except Exception as error:
        target = arguments.artifacts / "model-error.txt"
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_text(str(error))
        raise
