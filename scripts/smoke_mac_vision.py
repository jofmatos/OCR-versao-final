#!/usr/bin/env python3
"""Run the actual native macOS helper and exercise its HTTP/Apple Vision API."""
import argparse
import base64
import json
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ORIGIN = "https://jofmatos.github.io"
BASE = "http://127.0.0.1:17861"

def request(path, method="GET", body=None, origin=ORIGIN):
    headers = {"Origin": origin}
    if body is not None: headers["Content-Type"] = "application/json"
    with urlopen(Request(BASE + path, data=body, method=method, headers=headers), timeout=120) as response:
        return response.status, response.headers, response.read()

def main(executable):
    with tempfile.TemporaryDirectory() as directory:
        fixture = Path(directory) / "scan.png"
        subprocess.run([executable, "--self-test", "--fixture", str(fixture)], check=True)
        helper = subprocess.Popen([executable, "--server-only"])
        try:
            for _ in range(100):
                try:
                    status, headers, data = request("/health")
                    break
                except URLError: time.sleep(0.1)
            else: raise AssertionError("Native helper did not start")
            assert json.loads(data)["engine"] == "apple-vision"
            status, headers, _ = request("/recognize", method="OPTIONS")
            assert status == 204 and headers["Access-Control-Allow-Origin"] == ORIGIN
            assert headers["Access-Control-Allow-Private-Network"] == "true"
            body = json.dumps({"image": base64.b64encode(fixture.read_bytes()).decode(), "language": "por+eng"}).encode()
            _, _, data = request("/recognize", method="POST", body=body)
            result = json.loads(data)
            assert all(word in result["text"] for word in ["português", "acentuação", "12345"]), result
            assert result["confidence"] > 65
            for path, method, payload, origin, expected in [
                ("/recognize", "POST", b'{"image":"invalid"}', ORIGIN, 400),
                ("/recognize", "POST", body, "https://untrusted.example", 403),
            ]:
                try: request(path, method=method, body=payload, origin=origin)
                except HTTPError as error: assert error.code == expected
                else: raise AssertionError("Invalid request was accepted")
            print("Native Mac API OK: real Portuguese OCR, CORS, local-network preflight, invalid image and denied origin.")
        finally:
            helper.terminate(); helper.wait(timeout=10)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", required=True)
    main(parser.parse_args().executable)
