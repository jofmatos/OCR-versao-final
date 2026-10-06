#!/usr/bin/env python3
"""Check device selection and real Tesseract OCR with mobile browser emulation."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from urllib.request import urlopen
import time

from playwright.sync_api import expect, sync_playwright
from smoke_browser import fixtures


def run(artifacts):
    artifacts.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="lume-mobile-") as temporary, sync_playwright() as playwright:
        directory = Path(temporary)
        _, scan = fixtures(directory)
        (directory / "OCR-versao-final").symlink_to(Path("docs").resolve(), target_is_directory=True)
        server = subprocess.Popen(["python3", "-m", "http.server", "8083", "--bind", "127.0.0.1", "--directory", str(directory)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            base = "http://127.0.0.1:8083/OCR-versao-final/"
            for _ in range(100):
                try:
                    with urlopen(base, timeout=2): break
                except OSError: time.sleep(.1)
            browser = playwright.chromium.launch(executable_path=os.environ.get("LUME_TEST_BROWSER"), headless=True, args=["--no-sandbox"])
            profiles = [
                {"name": "iphone", "agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1", "platform": "iPhone", "touch": 5, "gpu": True, "mobile": True},
                {"name": "ipad-desktop-mode", "agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15", "platform": "MacIntel", "touch": 5, "gpu": True, "mobile": True},
                {"name": "android", "agent": "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36", "platform": "Linux armv8l", "touch": 5, "gpu": True, "mobile": True},
                {"name": "desktop-no-gpu", "agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0", "platform": "Win32", "touch": 0, "gpu": False, "mobile": False},
            ]
            for profile in profiles:
                context = browser.new_context(user_agent=profile["agent"], viewport={"width": 390, "height": 844}, is_mobile=profile["mobile"], has_touch=profile["mobile"], accept_downloads=True)
                context.add_init_script("""const profile = """ + json.dumps(profile) + """;
                    try { localStorage.setItem('lume-ocr-engine', 'neural'); } catch {}
                    Object.defineProperty(navigator, 'platform', {value:profile.platform});
                    Object.defineProperty(navigator, 'maxTouchPoints', {value:profile.touch});
                    Object.defineProperty(navigator, 'deviceMemory', {value:8});
                    Object.defineProperty(navigator, 'gpu', {value:profile.gpu ? {} : undefined});
                    const read = CanvasRenderingContext2D.prototype.getImageData;
                    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
                        window.maxReadPixels = Math.max(window.maxReadPixels || 0, args[2] * args[3]);
                        return read.apply(this, args);
                    };
                """)
                requests, errors = [], []
                context.on("request", lambda request: requests.append((request.method, request.url)))
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base, wait_until="networkidle")
                expect(page.locator("#connectionLabel")).to_have_text("OCR disponível")
                expect(page.locator("#ocrEngine")).to_have_value("tesseract")
                assert page.locator('#ocrEngine option[value="neural"]').is_disabled()
                assert page.locator('#ocrEngine option[value="vision"]').is_disabled()
                expect(page.locator("#modelStatus")).to_contain_text("escolha anterior")
                expect(page.locator("#deviceNotice")).to_be_visible()
                expect(page.locator("#prepareModels")).to_be_visible()
                expect(page.locator("#installAdvanced")).to_be_hidden()
                expect(page.locator("#installNeural")).to_be_hidden()
                reason = page.evaluate("window.LumeBrowser.ensureNeural().then(() => '', error => error.message)")
                assert reason
                assert not any("neural-worker" in url or "huggingface.co" in url for _, url in requests)
                page.locator("#ocrEngine").select_option("paddle")
                expect(page.locator("#installAdvanced")).to_be_visible()
                expect(page.locator("#prepareModels")).to_be_hidden()
                page.locator("#ocrEngine").select_option("tesseract")
                expect(page.locator("#installAdvanced")).to_be_hidden()
                assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
                if profile["name"] == "iphone":
                    page.locator("#fileInput").set_input_files(str(scan))
                    expect(page.locator("#documentName")).to_have_text(scan.name)
                    page.locator("#quality").select_option("high")
                    page.locator("#convertButton").click()
                    page.wait_for_function("['ready', 'error'].includes(window.LumeBrowser?.record?.doc.status)", timeout=180000)
                    doc = page.evaluate("window.LumeBrowser.record.doc")
                    assert doc["status"] == "ready", doc.get("error")
                    text = doc["pages"][0]["text"]
                    assert "português" in text and "acentuação" in text and "12345" in text, text
                    assert doc["pages"][0]["engine"] == "tesseract"
                    assert page.evaluate("maxReadPixels") < 4_100_000
                    with page.expect_download() as download:
                        page.locator("#exportTxt").click()
                    download.value.save_as(str(artifacts / "mobile-real-ocr.txt"))
                page.screenshot(path=str(artifacts / (profile["name"] + ".png")), full_page=True)
                assert not errors, errors
                assert not any(method != "GET" for method, url in requests if url.startswith("http"))
                context.close()
                print(profile["name"] + ": device selection, exclusive controls, no heavy model download and layout passed", flush=True)
            browser.close()
            print("Mobile emulation passed, including actual Tesseract OCR. This does not validate physical iOS devices.", flush=True)
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path("test-results/mobile"))
    run(parser.parse_args().artifacts)
