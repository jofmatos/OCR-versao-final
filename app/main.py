from __future__ import annotations

import asyncio
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import re
import shutil
from threading import Event, RLock
import time
from typing import Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app import engine

ROOT = Path(__file__).resolve().parent.parent
# Prefer the high-accuracy models installed by scripts/setup.sh.
MODEL_DIR = ROOT / ".cache" / "tessdata"
if MODEL_DIR.joinpath("por.traineddata").exists():
    os.environ.setdefault("TESSDATA_PREFIX", str(MODEL_DIR))
os.environ.setdefault("OMP_THREAD_LIMIT", "2")
logger = logging.getLogger("lume")
LANGUAGE_NAMES = {"por": "Português", "eng": "Inglês", "spa": "Espanhol"}


class ConvertRequest(BaseModel):
    mode: Literal["auto", "ocr"] = "auto"
    language: str = Field(default="por+eng", max_length=100)
    quality: Literal["high", "standard"] = "high"
    pages: str = Field(default="", max_length=1000)


class PageEdit(BaseModel):
    number: int = Field(ge=1)
    text: str = Field(max_length=500_000)


class TextEdit(BaseModel):
    pages: list[PageEdit] = Field(max_length=200)


def parse_page_range(value: str, count: int) -> list[int]:
    """Validate the whole selection; never silently drop invalid pages."""
    if not value.strip():
        return list(range(1, count + 1))
    selected: set[int] = set()
    for section in value.split(","):
        match = re.fullmatch(r"\s*(\d+)(?:\s*-\s*(\d+))?\s*", section)
        if not match:
            raise HTTPException(400, "Páginas inválidas. Use, por exemplo, 1-3, 5.")
        first, last = int(match[1]), int(match[2] or match[1])
        if not 1 <= first <= last <= count:
            raise HTTPException(400, f"Escolha páginas entre 1 e {count}, em ordem crescente nos intervalos.")
        selected.update(range(first, last + 1))
    return sorted(selected)


class DocumentStore:
    def __init__(self, directory: Path, retention: int):
        self.directory = directory
        self.retention = retention
        self.lock = RLock()
        self.records: dict[str, dict] = {}
        self.cancellations: dict[str, Event] = {}
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="lume-ocr")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for state in directory.glob("*/state.json"):
            if not re.fullmatch(r"[a-f0-9]{32}", state.parent.name):
                continue
            try:
                record = json.loads(state.read_text("utf-8"))
                if record["id"] != state.parent.name or not (state.parent / "source.pdf").is_file():
                    continue
                if record["status"] == "processing":
                    record["status"] = "error"
                    record["error"] = "O servidor foi reiniciado. Inicie a conversão novamente."
                self.records[record["id"]] = record
                self.save(record)
            except (OSError, ValueError, KeyError):
                logger.warning("Não foi possível restaurar o estado de um documento.")
        self.cleanup()

    def save(self, record: dict) -> None:
        directory = self.directory / record["id"]
        temporary = directory / "state.tmp"
        temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        temporary.replace(directory / "state.json")

    def get(self, identifier: str) -> dict:
        record = self.records.get(identifier)
        if record is None:
            raise HTTPException(404, "Documento não encontrado ou expirado. Envie o arquivo novamente.")
        if record["status"] != "processing" and time.time() - record["updated_at"] > self.retention:
            self.remove(identifier)
            raise HTTPException(404, "Este documento expirou. Envie o arquivo novamente.")
        return record

    def public(self, record: dict) -> dict:
        return deepcopy({k: v for k, v in record.items() if k != "updated_at"})

    def remove(self, identifier: str) -> None:
        event = self.cancellations.get(identifier)
        if event:
            event.set()
        self.records.pop(identifier, None)
        # Do not resurrect a deleted job if the process stops before its current
        # page finishes. The worker only needs the PDF, never the state file.
        (self.directory / identifier / "state.json").unlink(missing_ok=True)
        # A running worker owns its files until it observes cancellation.
        if not event:
            shutil.rmtree(self.directory / identifier, ignore_errors=True)

    def cleanup(self) -> None:
        with self.lock:
            for identifier, record in list(self.records.items()):
                if record["status"] != "processing" and time.time() - record["updated_at"] > self.retention:
                    self.remove(identifier)

    def process(self, identifier: str, options: ConvertRequest, numbers: list[int], event: Event) -> None:
        def page_finished(page: dict) -> None:
            with self.lock:
                if event.is_set() or identifier not in self.records:
                    return
                record = self.records[identifier]
                record["pages"].append(page)
                record["progress"]["completed"] = len(record["pages"])
                record["updated_at"] = time.time()
                self.save(record)

        try:
            engine.convert_document(
                self.directory / identifier / "source.pdf",
                page_numbers=numbers,
                mode=options.mode,
                language=options.language,
                quality=options.quality,
                on_page=page_finished,
                cancelled=event.is_set,
            )
            with self.lock:
                if not event.is_set() and identifier in self.records:
                    record = self.records[identifier]
                    record["status"] = "ready"
                    record["updated_at"] = time.time()
                    self.save(record)
        except Exception as exc:
            if not isinstance(exc, engine.ProcessingError):
                logger.exception("Falha na conversão de um documento")
            with self.lock:
                if not event.is_set() and identifier in self.records:
                    record = self.records[identifier]
                    record["status"] = "error"
                    record["error"] = str(exc) if isinstance(exc, engine.ProcessingError) else "Não foi possível processar este PDF. Tente outra qualidade ou um arquivo diferente."
                    record["updated_at"] = time.time()
                    self.save(record)
        finally:
            with self.lock:
                self.cancellations.pop(identifier, None)
                if identifier not in self.records:
                    shutil.rmtree(self.directory / identifier, ignore_errors=True)


def create_app(data_dir: Path | None = None) -> FastAPI:
    storage_path = data_dir or Path(os.environ.get("LUME_DATA_DIR", str(ROOT / "data")))
    retention = int(os.environ.get("LUME_RETENTION_HOURS", "24")) * 3600
    max_upload = 50 * 1024 * 1024
    max_pages = 200

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        store = DocumentStore(storage_path, retention)
        application.state.store = store

        async def cleanup_loop():
            while True:
                await asyncio.sleep(60)
                await run_in_threadpool(store.cleanup)

        cleanup_task = asyncio.create_task(cleanup_loop())
        yield
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
        with store.lock:
            for event in store.cancellations.values():
                event.set()
        await run_in_threadpool(lambda: store.executor.shutdown(wait=True, cancel_futures=False))

    application = FastAPI(title="Lume OCR", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError):
        # Never echo submitted document text in validation failures. Invalid
        # Unicode in the input must not break JSON response serialization.
        return JSONResponse(status_code=422, content={"detail": "Confira os dados enviados. Há campos inválidos ou texto incompatível."})

    @application.middleware("http")
    async def response_headers(request: Request, call_next):
        length = request.headers.get("content-length", "0")
        if length.isdecimal() and int(length) > max_upload + 1024 * 1024:
            return Response('{"detail":"O arquivo deve ter no máximo 50 MB."}', status_code=413, media_type="application/json")
        # Native form submissions from unrelated sites must not create jobs.
        origin = request.headers.get("origin")
        if request.method in {"POST", "PATCH", "DELETE"} and origin:
            from urllib.parse import urlsplit
            if urlsplit(origin).netloc != request.headers.get("host"):
                return Response('{"detail":"Origem da solicitação não permitida."}', status_code=403, media_type="application/json")
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.get("/api/health")
    async def health():
        languages = await run_in_threadpool(engine.get_ocr_languages)
        return {
            "status": "ok",
            "ocr_available": bool(languages),
            "languages": [{"code": code, "label": LANGUAGE_NAMES.get(code, code)} for code in languages if code != "osd"],
            "limits": {"max_upload_mb": 50, "max_pages": max_pages},
        }

    @application.post("/api/documents", status_code=201)
    async def upload_document(request: Request, file: UploadFile = File(...)):
        store = request.app.state.store
        store.cleanup()
        with store.lock:
            if len(store.records) >= 30:
                raise HTTPException(429, "O armazenamento temporário está cheio. Remova documentos anteriores ou aguarde a expiração.")
        identifier = uuid4().hex
        directory = store.directory / identifier
        directory.mkdir(mode=0o700)
        source = directory / "source.pdf"
        size = 0
        try:
            with source.open("wb") as destination:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > max_upload:
                        raise HTTPException(413, "O arquivo deve ter no máximo 50 MB.")
                    destination.write(chunk)
            if size == 0:
                raise HTTPException(400, "O arquivo enviado está vazio.")
            with source.open("rb") as stream:
                if b"%PDF-" not in stream.read(1024):
                    raise HTTPException(415, "Envie um arquivo PDF válido.")
            try:
                info = await run_in_threadpool(engine.inspect_document, source)
            except engine.ProcessingError as exc:
                raise HTTPException(400, str(exc)) from exc
            if not 1 <= info["page_count"] <= max_pages:
                raise HTTPException(400, f"Envie um PDF com 1 a {max_pages} páginas.")
            name = re.sub(r"[\x00-\x1f\x7f]", "", (file.filename or "Documento.pdf").replace("\\", "/").split("/")[-1])[:200]
            record = {
                "id": identifier,
                "name": name or "Documento.pdf",
                "page_count": info["page_count"],
                "size": size,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": time.time(),
                "status": "uploaded",
                "progress": {"completed": 0, "total": info["page_count"]},
                "pages": [],
                "error": None,
            }
            with store.lock:
                store.records[identifier] = record
                store.save(record)
            return store.public(record)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            with store.lock:
                store.records.pop(identifier, None)
            raise
        finally:
            await file.close()

    @application.get("/api/documents/{identifier}")
    async def get_document(identifier: str, request: Request):
        store = request.app.state.store
        with store.lock:
            return store.public(store.get(identifier))

    @application.get("/api/documents/{identifier}/preview/{number}")
    async def preview(identifier: str, number: int, request: Request):
        store = request.app.state.store
        with store.lock:
            record = store.get(identifier)
            if not 1 <= number <= record["page_count"]:
                raise HTTPException(404, "Página não encontrada.")
        try:
            image = await run_in_threadpool(engine.render_preview, store.directory / identifier / "source.pdf", number)
        except engine.ProcessingError as exc:
            raise HTTPException(400, str(exc)) from exc
        return Response(image, media_type="image/png")

    @application.post("/api/documents/{identifier}/convert", status_code=202)
    async def convert(identifier: str, options: ConvertRequest, request: Request):
        store = request.app.state.store
        if not re.fullmatch(r"[a-z]{3}(?:\+[a-z]{3}){0,3}", options.language):
            raise HTTPException(400, "Selecione um idioma de OCR válido.")
        with store.lock:
            record = store.get(identifier)
            if record["status"] == "processing":
                raise HTTPException(409, "Este documento já está sendo processado.")
            if len(store.cancellations) >= 6:
                raise HTTPException(429, "A fila está cheia. Aguarde a conclusão de uma conversão.")
            numbers = parse_page_range(options.pages, record["page_count"])
            event = Event()
            record.update(status="processing", pages=[], error=None, progress={"completed": 0, "total": len(numbers)}, updated_at=time.time())
            store.save(record)
            store.cancellations[identifier] = event
            store.executor.submit(store.process, identifier, options, numbers, event)
            return store.public(record)

    @application.patch("/api/documents/{identifier}/text")
    async def edit_text(identifier: str, edits: TextEdit, request: Request):
        store = request.app.state.store
        if sum(len(page.text) for page in edits.pages) > 2_000_000:
            raise HTTPException(413, "O texto editado excede o limite de 2 milhões de caracteres.")
        with store.lock:
            record = store.get(identifier)
            if record["status"] != "ready":
                raise HTTPException(409, "Aguarde a conversão antes de editar o texto.")
            by_number = {page["number"]: page for page in record["pages"]}
            if len({p.number for p in edits.pages}) != len(edits.pages) or any(p.number not in by_number for p in edits.pages):
                raise HTTPException(400, "A edição contém páginas inválidas ou repetidas.")
            for page in edits.pages:
                if engine.XML_INVALID.search(page.text):
                    raise HTTPException(400, "O texto contém caracteres de controle inválidos.")
            total = sum(len(next((p.text for p in edits.pages if p.number == n), p["text"])) for n, p in by_number.items())
            if total > 2_000_000:
                raise HTTPException(413, "O documento excede o limite de 2 milhões de caracteres.")
            for page in edits.pages:
                by_number[page.number]["text"] = page.text
            record["updated_at"] = time.time()
            store.save(record)
            return store.public(record)

    @application.get("/api/documents/{identifier}/export")
    async def export(identifier: str, request: Request, format: Literal["txt", "docx"] = "docx"):
        store = request.app.state.store
        with store.lock:
            record = store.get(identifier)
            if record["status"] != "ready":
                raise HTTPException(409, "Conclua a conversão antes de baixar.")
            pages = [dict(page) for page in record["pages"]]
            title = Path(record["name"]).stem
        if format == "txt":
            content = await run_in_threadpool(engine.export_txt, pages)
            media_type = "text/plain; charset=utf-8"
        else:
            content = await run_in_threadpool(engine.export_docx, pages, title)
            media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        filename = quote(f"{title or 'documento'}.{format}", safe="")
        return StreamingResponse(BytesIO(content), media_type=media_type, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})

    @application.delete("/api/documents/{identifier}", status_code=204)
    async def delete(identifier: str, request: Request):
        store = request.app.state.store
        with store.lock:
            store.get(identifier)
            store.remove(identifier)
        return Response(status_code=204)

    @application.get("/", include_in_schema=False)
    async def index():
        return FileResponse(ROOT / "app" / "static" / "index.html")

    application.mount("/static", StaticFiles(directory=ROOT / "app" / "static", check_dir=False), name="static")
    return application


app = create_app()
