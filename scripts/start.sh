#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
lume_venv="${VENV_PATH:-$PWD/.venv}"
if [ ! -x "$lume_venv/bin/python" ]; then
  echo 'Execute bash scripts/setup.sh antes de iniciar.' >&2
  exit 1
fi
export TESSDATA_PREFIX="${TESSDATA_PREFIX:-$PWD/.cache/tessdata}"
export OMP_THREAD_LIMIT="${OMP_THREAD_LIMIT:-2}"
exec "$lume_venv/bin/python" -m uvicorn app.main:app --host "${LUME_HOST:-127.0.0.1}" --port "${LUME_PORT:-8000}" --workers 1
