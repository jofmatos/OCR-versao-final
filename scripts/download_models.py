#!/usr/bin/env python3
"""Download immutable official Tesseract models with TLS and SHA-256 checks."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import ssl
import urllib.request

REVISION = "e12c65a915945e4c28e237a9b52bc4a8f39a0cec"
MODELS = {
    "por": "711de9dbb8052067bd42f16b9119967f30bada80d57e2ef24f65d09f531adb04",
    "eng": "8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba",
    "spa": "e2c1ffdad8b30f26c45d4017a9183d3a7f9aa69e59918be4f88b126fac99ab2c",
    "osd": "9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff",
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def install(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for language, checksum in MODELS.items():
        target = directory / f"{language}.traineddata"
        if target.exists() and digest(target) == checksum:
            print(f"Modelo verificado: {language}", flush=True)
            continue
        url = f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/{REVISION}/{language}.traineddata"
        temporary = target.with_suffix(".download")
        print(f"Instalando modelo de alta precisão: {language}", flush=True)
        try:
            with urllib.request.urlopen(url, timeout=120, context=ssl.create_default_context()) as source, temporary.open("wb") as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
            if digest(temporary) != checksum:
                raise RuntimeError(f"A verificação SHA-256 do modelo {language} falhou.")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / ".cache" / "tessdata")
    install(parser.parse_args().directory)
