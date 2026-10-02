#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v tesseract >/dev/null; then
  echo 'Instale o Tesseract 5 antes de continuar.' >&2
  echo 'Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y tesseract-ocr python3-venv fonts-dejavu-core' >&2
  echo 'macOS: brew install tesseract python@3.12' >&2
  exit 1
fi

python3 -c 'import sys; assert sys.version_info >= (3, 12), "Use Python 3.12 ou superior"'
lume_venv="${VENV_PATH:-$PWD/.venv}"
if [ ! -x "$lume_venv/bin/python" ]; then
  python3 -m venv "$lume_venv"
fi
lume_requirements=requirements.txt
if [ "${1:-}" = '--dev' ]; then lume_requirements=requirements-dev.txt; fi
"$lume_venv/bin/python" -m pip install -r "$lume_requirements"
"$lume_venv/bin/python" scripts/download_models.py
"$lume_venv/bin/python" -m pip check
TESSDATA_PREFIX="$PWD/.cache/tessdata" tesseract --list-langs
echo 'Lume OCR instalado. Execute bash scripts/start.sh.'
