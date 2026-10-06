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
            large = Image.new("RGB", (1654, 2339), "white")
            large_draw = ImageDraw.Draw(large)
            large_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 58)
            for y, text in zip([100, 600, 780], EXPECTED):
                large_draw.text((80, y), text, fill="black", font=large_font)
            large_png = BytesIO()
            large.save(large_png, "PNG")
            page = pdf.new_page(width=595, height=842)
            page.insert_image(page.rect, stream=large_png.getvalue())
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
                context = playwright.chromium.launch_persistent_context(str(directory / "browser-profile"), executable_path=os.environ.get("LUME_TEST_BROWSER"), headless=True,
                    proxy={"server": proxy_server, "bypass": "127.0.0.1,localhost"} if proxy_server else None,
                    args=["--no-sandbox", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-vulkan-surface"],
                    viewport={"width": 1440, "height": 1000}, accept_downloads=True)
                network = []
                context.on("request", lambda request: network.append((request.method, request.url)))
                failed_requests = []
                def request_failed(request):
                    url = urlsplit(request.url)
                    failed_requests.append({"host": url.hostname, "path": url.path, "error": request.failure})
                    (artifacts / "failed-requests.json").write_text(json.dumps(failed_requests, indent=2))
                context.on("requestfailed", request_failed)
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                console_messages = []
                def browser_console(message):
                    if message.type in ["error", "warning"]:
                        console_messages.append(message.text)
                        (artifacts / "browser-console.json").write_text(json.dumps(console_messages, indent=2))
                page.on("console", browser_console)
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
                model_info = page.evaluate("window.LumeBrowser.neural.request('init')")
                page.locator("#fileInput").set_input_files(str(scan))
                expect(page.locator("#documentName")).to_have_text(scan.name)
                page.locator("#quality").select_option("standard")
                page.locator("#pageRange").fill("1")
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
                # The original short fixture could not exercise the dense
                # vision allocation that fails on full A4 pages in high quality.
                page.locator("#pageRange").fill("2")
                page.locator("#quality").select_option("high")
                page.locator("#convertButton").click()
                if page.locator("#confirmAction").is_visible():
                    page.locator("#confirmAction").click()
                wait_condition(page, "['ready', 'error'].includes(window.LumeBrowser?.record?.doc.status)", 900000, f"{label} A4 high recognition", artifacts)
                a4_doc = page.evaluate("window.LumeBrowser.record.doc")
                assert a4_doc["status"] == "ready", a4_doc.get("error")
                a4_text = a4_doc["pages"][0]["text"]
                a4_score = SequenceMatcher(None, normalized(" ".join(EXPECTED)), normalized(a4_text)).ratio()
                (artifacts / "a4-high-text.txt").write_text(a4_text)
                assert a4_score >= .93, (a4_score, a4_text)
                for value in ["acentuação", "educação", "12345", "1.234,56", "05/10/2026"]:
                    assert value in a4_text, (value, a4_text)
                assert a4_doc["pages"][0]["number"] == 2
                assert any("faixas" in item for item in a4_doc["pages"][0]["warnings"])
                notice(f"{label} A4 high passed", f"Portuguese similarity {a4_score:.3f}; full A4 raster, high quality, bounded vision regions")
                page.screenshot(path=str(artifacts / "a4-high-browser.png"), full_page=True)
                assert not errors, errors
                assert not any(method != "GET" for method, url in network if url.startswith("http")), "Document data was uploaded"
                cache_info = page.evaluate("""async () => ({storage: await navigator.storage.estimate(), caches: await Promise.all((await caches.keys()).map(async name => ({name, files: (await (await caches.open(name)).keys()).map(request => {const url = new URL(request.url); return {host: url.hostname, path: url.pathname};})})))})""")
                (artifacts / "browser-cache.json").write_text(json.dumps(cache_info, indent=2))
                notice(f"{label} cache", f"Browser cache entries: {sum(len(item['files']) for item in cache_info['caches'])}; usage {cache_info['storage'].get('usage')}; quota {cache_info['storage'].get('quota')}")
                # A new worker must be able to load its models without network.
                page.evaluate("window.LumeBrowser.neural.terminate(); window.LumeBrowser.neural = null;")
                context.set_offline(True)
                page.locator("#installNeural").click()
                wait_condition(page, "!window.LumeBrowser.neuralPromise && !document.getElementById('installNeural').disabled", 300000, f"{label} offline reload", artifacts)
                assert page.locator("#installNeural").inner_text() == f"{label} preparado", page.locator("#modelStatus").inner_text()
                context.set_offline(False)
                baselines = {}
                if baseline:
                    page.locator("#pageRange").fill("1")
                    page.locator("#quality").select_option("standard")
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
                (artifacts / "report.json").write_text(json.dumps({"model": label, "dtype": "q4", "execution": model_info["execution"], "browser_profile": "persistent", "quality": "standard", "fixture_pixels": [1000, 260], "portuguese_similarity": score, "a4_high_similarity": a4_score, "a4_high_passed": True, "a4_fixture_pixels": [1654, 2339], "native_browser_webgpu": True, "cached_offline_restart": True, "document_uploads": False, "baselines": baselines}, indent=2) + "\n")
                context.close()
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
