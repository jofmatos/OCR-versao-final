"""Local PDF extraction, Tesseract OCR and editable document export.

Every document is opened inside the call that uses it: PyMuPDF document objects
must not be shared by concurrent workers. Exported text follows reading order;
DOCX is an editable transcription, not a replica of the original page layout.
"""

from __future__ import annotations

import io
import math
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Callable

import pymupdf as fitz
import pytesseract
from docx import Document
from docx.shared import Cm, Pt
from PIL import Image, ImageFilter, ImageOps


MAX_RENDER_PIXELS = 20_000_000
OCR_TIMEOUT_SECONDS = 120
_PDF_LOCK = threading.RLock()
LANGUAGE_PATTERN = re.compile(r"^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$")
XML_INVALID = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")


class ProcessingError(Exception):
    """An actionable, user-facing document-processing error."""


class ProcessingCancelled(ProcessingError):
    """The user cancelled work between page-processing operations."""


def _open_pdf(path: Path) -> fitz.Document:
    try:
        document = fitz.open(str(path))
    except (RuntimeError, ValueError, OSError) as exc:
        raise ProcessingError("Não foi possível abrir o PDF. Verifique se o arquivo está íntegro.") from exc
    if not document.is_pdf:
        document.close()
        raise ProcessingError("O arquivo precisa ser um PDF válido.")
    if document.needs_pass:
        document.close()
        raise ProcessingError("Este PDF está protegido por senha. Remova a senha antes de enviá-lo.")
    if not document.page_count:
        document.close()
        raise ProcessingError("Este PDF não contém páginas.")
    return document


def inspect_document(path: Path) -> dict:
    """Validate a PDF without executing scripts or opening embedded files."""
    with _PDF_LOCK, _open_pdf(path) as document:
        return {"page_count": document.page_count, "password_protected": False}


def _page(document: fitz.Document, number: int) -> fitz.Page:
    if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= document.page_count:
        raise ProcessingError("O número da página está fora do intervalo do documento.")
    return document.load_page(number - 1)


def render_preview(path: Path, number: int) -> bytes:
    """Render a bounded PNG, including PDFs whose page dimensions are extreme."""
    with _PDF_LOCK, _open_pdf(path) as document:
        page = _page(document, number)
        longest = max(page.rect.width, page.rect.height)
        if longest <= 0:
            raise ProcessingError("Esta página não tem dimensões válidas.")
        scale = min(2, 1400 / longest)
        try:
            return page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).tobytes("png")
        except (RuntimeError, ValueError) as exc:
            raise ProcessingError("Não foi possível gerar a prévia desta página.") from exc


def get_ocr_languages() -> list[str]:
    """Return installed transcription languages; OSD is orientation metadata."""
    try:
        return sorted(language for language in pytesseract.get_languages(config="") if language != "osd")
    except (pytesseract.TesseractNotFoundError, pytesseract.TesseractError, OSError):
        return []


def _validate_languages(language: str) -> None:
    if not isinstance(language, str) or not LANGUAGE_PATTERN.fullmatch(language):
        raise ProcessingError("A seleção de idiomas do OCR é inválida.")
    installed = set(get_ocr_languages())
    if not installed:
        raise ProcessingError("O Tesseract OCR não está disponível. Instale o programa e seus pacotes de idiomas.")
    missing = set(language.split("+")) - installed
    if missing:
        raise ProcessingError("Instale os idiomas do Tesseract necessários: " + ", ".join(sorted(missing)) + ".")


def _normalise_paragraph(text: str) -> str:
    # Keep accents and intentional hyphens; whitespace from wrapped PDF lines
    # becomes editable prose, while separate PDF blocks remain paragraphs.
    return " ".join(text.replace("\x00", "").split())


def _ordered_blocks(page: fitz.Page) -> list:
    blocks = [block for block in page.get_text("blocks", sort=True) if block[6] == 0 and block[4].strip()]
    middle = page.rect.x0 + page.rect.width / 2
    left = [block for block in blocks if block[2] < middle - 5]
    right = [block for block in blocks if block[0] > middle + 5]
    # Recognize clear, balanced two-column layouts. Full-width headings or
    # footers split the page into horizontal regions, each read left then right.
    if len(left) < 2 or len(right) < 2:
        return blocks
    if max(block[2] for block in left) >= min(block[0] for block in right) - 10:
        return blocks
    spanning = [block for block in blocks if block not in left and block not in right]
    ordered = []
    remaining = left + right
    for boundary in sorted(spanning, key=lambda block: (block[1], block[0])):
        preceding = [block for block in remaining if block[1] < boundary[1]]
        for column in (left, right):
            ordered.extend(sorted((block for block in preceding if block in column), key=lambda block: (block[1], block[0])))
        remaining = [block for block in remaining if block not in preceding]
        ordered.append(boundary)
    for column in (left, right):
        ordered.extend(sorted((block for block in remaining if block in column), key=lambda block: (block[1], block[0])))
    return ordered


def _native_text(page: fitz.Page) -> str:
    return "\n\n".join(_normalise_paragraph(block[4]) for block in _ordered_blocks(page)).strip()


def _should_ocr(page: fitz.Page, text: str) -> bool:
    compact = "".join(text.split())
    images = page.get_image_info()
    if not compact:
        # A truly blank PDF page should remain blank and needs no OCR process.
        return bool(images or page.get_drawings())
    if "(cid:" in text or text.count("\ufffd") / len(compact) > 0.02:
        return True
    if sum(character.isalnum() for character in compact) / len(compact) < 0.35:
        return True
    if images:
        area = max(page.rect.get_area(), 1)
        coverage = min(1.0, sum((fitz.Rect(image["bbox"]) & page.rect).get_area() for image in images) / area)
        # A scan can have a searchable header or page number without having a
        # usable text layer for its actual content. Do not mistake that for a
        # digitally authored page merely because get_text returned something.
        if coverage >= 0.60 and len(compact) < 160:
            return True
    return False


def _check_cancelled(cancelled: Callable[[], bool]) -> None:
    if cancelled():
        raise ProcessingCancelled("Processamento cancelado.")


def _render_for_ocr(page: fitz.Page, quality: str) -> Image.Image:
    dpi = 350 if quality == "high" else 250
    width, height = page.rect.width, page.rect.height
    if width <= 0 or height <= 0 or not math.isfinite(width * height):
        raise ProcessingError("Esta página não tem dimensões válidas.")
    scale = min(dpi / 72, math.sqrt(MAX_RENDER_PIXELS / (width * height)), 14_000 / max(width, height))
    # Ceiling raster dimensions can exceed the cap very slightly; leave room
    # for rounding rather than allocating an unexpectedly large bitmap.
    scale *= 0.999
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    return Image.frombytes("L", (pixmap.width, pixmap.height), pixmap.samples)


def _orient(image: Image.Image, warnings: list[str]) -> Image.Image:
    sample = image.copy()
    sample.thumbnail((2200, 2200))
    try:
        orientation = pytesseract.image_to_osd(sample, output_type=pytesseract.Output.DICT, timeout=15)
        rotation = int(orientation.get("rotate", 0))
        confidence = float(orientation.get("orientation_conf", 0))
        if rotation in (90, 180, 270) and confidence >= 2:
            warnings.append(f"Orientação corrigida automaticamente em {rotation}°.")
            return image.rotate(-rotation, expand=True, fillcolor=255)
    except (pytesseract.TesseractError, RuntimeError, ValueError):
        # OSD normally declines sparse/blank pages. Actual text recognition
        # remains useful and reports its own confidence separately.
        pass
    finally:
        sample.close()
    return image


def _transcribe(original: Image.Image, number: int, language: str, quality: str, cancelled: Callable[[], bool]) -> tuple[str, float | None, list[str]]:
    warnings: list[str] = []
    oriented = None
    processed = None
    try:
        _check_cancelled(cancelled)
        oriented = _orient(original, warnings)
        _check_cancelled(cancelled)
        processed = ImageOps.autocontrast(oriented, cutoff=0.3)
        if quality == "high":
            sharpened = processed.filter(ImageFilter.UnsharpMask(radius=1, percent=110, threshold=3))
            processed.close()
            processed = sharpened
        data = pytesseract.image_to_data(
            processed,
            lang=language,
            config="--oem 1 --psm 3 -c preserve_interword_spaces=1",
            output_type=pytesseract.Output.DICT,
            timeout=OCR_TIMEOUT_SECONDS,
        )
        _check_cancelled(cancelled)
        paragraphs: OrderedDict[tuple, OrderedDict[tuple, list[str]]] = OrderedDict()
        scores: list[tuple[float, int]] = []
        for index, word in enumerate(data["text"]):
            word = str(word).strip()
            if not word:
                continue
            paragraph_key = (data["block_num"][index], data["par_num"][index])
            line_key = (data["line_num"][index],)
            paragraphs.setdefault(paragraph_key, OrderedDict()).setdefault(line_key, []).append(word)
            confidence = float(data["conf"][index])
            if confidence >= 0:
                scores.append((confidence, len(word)))
        text = "\n\n".join(" ".join(" ".join(words) for words in lines.values()) for lines in paragraphs.values()).strip()
        confidence = round(sum(score * size for score, size in scores) / sum(size for _, size in scores), 1) if scores else None
        if not text:
            warnings.append("Nenhum texto reconhecido nesta página. Confira a prévia e a legibilidade do original.")
        elif confidence is not None and confidence < 65:
            warnings.append("O OCR teve baixa confiança nesta página. Revise o texto antes de usar.")
        return text, confidence, warnings
    except pytesseract.TesseractNotFoundError as exc:
        raise ProcessingError("O Tesseract OCR não está instalado neste ambiente.") from exc
    except pytesseract.TesseractError as exc:
        raise ProcessingError(f"O OCR falhou na página {number}. Verifique os idiomas instalados e a integridade do PDF.") from exc
    except RuntimeError as exc:
        raise ProcessingError(f"O OCR excedeu o tempo limite na página {number}. Tente a qualidade padrão ou processe menos páginas.") from exc
    finally:
        if processed is not None:
            processed.close()
        if oriented is not None and oriented is not original:
            oriented.close()


def convert_document(
    path: Path,
    *,
    page_numbers: list[int],
    mode: str = "auto",
    language: str = "por+eng",
    quality: str = "high",
    on_page: Callable[[dict], None] = lambda result: None,
    cancelled: Callable[[], bool] = lambda: False,
) -> list[dict]:
    """Process selected pages in the requested order, reporting each result."""
    if mode not in {"auto", "ocr"}:
        raise ProcessingError("Escolha o modo automático ou OCR.")
    if quality not in {"high", "standard"}:
        raise ProcessingError("Escolha a qualidade alta ou padrão.")
    if not page_numbers:
        raise ProcessingError("Selecione ao menos uma página para converter.")
    results: list[dict] = []
    languages_validated = False
    with _PDF_LOCK:
        document = _open_pdf(path)
    try:
        # Validate the whole selection before producing partial output.
        with _PDF_LOCK:
            for number in page_numbers:
                _page(document, number)
        for number in page_numbers:
            _check_cancelled(cancelled)
            image = None
            try:
                # MuPDF itself is not thread safe, even with separate document
                # objects. Serialize its operations, then release the lock for
                # Tesseract so previews can run while recognition is in flight.
                with _PDF_LOCK:
                    page = _page(document, number)
                    text = _native_text(page)
                    use_ocr = mode == "ocr" or _should_ocr(page, text)
                    if use_ocr:
                        image = _render_for_ocr(page, quality)
                    del page
                if use_ocr:
                    if not languages_validated:
                        _validate_languages(language)
                        languages_validated = True
                    text, confidence, warnings = _transcribe(image, number, language, quality, cancelled)
                else:
                    confidence = None
                    warnings = [] if text else ["Esta página está em branco ou não contém texto extraível."]
            except ProcessingError:
                raise
            except (RuntimeError, ValueError, OSError) as exc:
                raise ProcessingError(f"Não foi possível processar a página {number}. Verifique se o PDF está íntegro.") from exc
            finally:
                if image is not None:
                    image.close()
            _check_cancelled(cancelled)
            result = {"number": number, "text": text, "method": "ocr" if use_ocr else "native", "confidence": confidence, "warnings": warnings}
            results.append(result)
            on_page(result)
    finally:
        with _PDF_LOCK:
            document.close()
    return results


def export_txt(pages: list[dict]) -> bytes:
    """Export plain UTF-8 text without adding synthetic page labels."""
    return ("\n\n".join(str(page.get("text", "")).strip() for page in pages) + "\n").encode("utf-8")


def export_docx(pages: list[dict], title: str) -> bytes:
    """Create editable paragraphs and preserve the selected page boundaries."""
    document = Document()
    document.core_properties.title = XML_INVALID.sub("", title)[:255]
    document.core_properties.subject = "Transcrição de PDF"
    document.core_properties.author = "Lume OCR"
    section = document.sections[0]
    section.top_margin = section.bottom_margin = Cm(2)
    section.left_margin = section.right_margin = Cm(2)
    style = document.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)
    style.paragraph_format.space_after = Pt(8)
    for index, page in enumerate(pages):
        if index:
            document.add_page_break()
        text = XML_INVALID.sub("", str(page.get("text", "")))
        paragraphs = re.split(r"\n\s*\n", text) if text else [""]
        for paragraph in paragraphs:
            document.add_paragraph(paragraph)
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()
