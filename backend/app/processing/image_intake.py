"""Validate and normalize an uploaded floor-plan image.

This is the single entry point through which raw user bytes become a trusted
image. Everything downstream (the CV pipeline) can assume its input is a
decoded, size-bounded, metadata-free PNG.

Order of checks (the expensive steps come last):
1. Open lazily: Pillow parses only the header. The format is decided by content
   (never by filename/MIME); only PNG and JPEG are accepted.
2. Pixel limit from the header's width x height, before verification or any
   pixel decoding (settings.max_image_pixels, at most 20 MP).
3. Integrity check (verify), then decode, then a recheck that the decoded size
   equals the header's.
Every failure of a malformed or hostile file is a clean 422 (or 415 for another
format), never a 500, including Pillow's own safety refusals: its decompression-
bomb error and the ValueErrors it raises for oversized PNG text/ICC chunks.
"""

import io
import logging
import re
from dataclasses import dataclass

from PIL import Image, ImageOps

from app.config import settings
from app.errors import ArchflowError, InvalidImage, UnsupportedFileType

log = logging.getLogger(__name__)

ALLOWED_FORMATS = {"PNG", "JPEG"}

# Pillow's own, process-wide decompression-bomb guard, checked when a file is opened: it warns above this
# many pixels and refuses above twice as many. It follows our limit (20 MP or lower); our explicit header
# check below then refuses everything above the limit, so a warning never lets an image through.
Image.MAX_IMAGE_PIXELS = settings.max_image_pixels

_BOMB_PIXELS = re.compile(r"Image size \((\d+) pixels\)")


@dataclass(frozen=True)
class NormalizedImage:
    png_bytes: bytes
    width: int
    height: int
    source_format: str


def pixel_limit_text() -> str:
    """The configured limit, exactly: '20,000,000 pixels (20 megapixels)'."""
    limit = settings.max_image_pixels
    mp = f"{limit / 1e6:g}"
    return f"{limit:,} pixels ({mp} megapixel{'' if mp == '1' else 's'})"


def image_size_text(pixels: int, size: tuple[int, int] | None = None) -> str:
    """An image's size, exactly (never rounded, so a size just over the limit never reads like the limit)."""
    return f"{size[0]} × {size[1]} px = {pixels:,} pixels" if size else f"{pixels:,} pixels"


def too_large(pixels: int | None = None, size: tuple[int, int] | None = None) -> InvalidImage:
    if pixels is None:
        return InvalidImage(f"This image is too large. The limit is {pixel_limit_text()}: scale it down and upload it again.")
    return InvalidImage(f"This image is too large ({image_size_text(pixels, size)}). "
                        f"The limit is {pixel_limit_text()}: scale it down and upload it again.")


def _check_pixels(size: tuple[int, int]) -> None:
    width, height = size
    if width <= 0 or height <= 0:
        raise InvalidImage("File is not a valid PNG or JPEG image.")
    if width * height > settings.max_image_pixels:
        raise too_large(width * height, size)


def normalize_upload(data: bytes) -> NormalizedImage:
    """Decode `data` by content (never by filename/MIME) and re-encode as clean PNG."""
    try:
        with Image.open(io.BytesIO(data)) as probe:  # header only
            fmt = probe.format
            if fmt not in ALLOWED_FORMATS:
                raise UnsupportedFileType("Only PNG and JPEG images are supported.")
            header_size = probe.size
            _check_pixels(header_size)  # before verify() and before any pixel is decoded
            probe.verify()  # cheap integrity check; invalidates `probe`
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            if img.size != header_size:  # a decoder must never produce more (or other) pixels than declared
                raise InvalidImage("File is not a valid PNG or JPEG image.")
            img = ImageOps.exif_transpose(img)  # honour camera rotation (same pixel count)
            width, height = img.size
            rgb = img.convert("RGB")  # flatten alpha/palette; drops all metadata
    except ArchflowError:
        raise
    except Image.DecompressionBombError as exc:  # over twice Pillow's guard: refused while opening
        match = _BOMB_PIXELS.search(str(exc))
        raise too_large(int(match.group(1)) if match else None) from exc
    except MemoryError:
        raise
    except Exception as exc:  # noqa: BLE001 - any other decoder failure means a malformed or hostile file
        # Pillow raises OSError/SyntaxError for corrupt data, ValueError for oversized text/ICC chunks
        # ("decompression bombs" in metadata), and occasionally others (struct.error, EOFError, ...).
        log.info("Rejected an invalid image upload (%s)", type(exc).__name__)
        raise InvalidImage("File is not a valid PNG or JPEG image.") from exc

    out = io.BytesIO()
    rgb.save(out, format="PNG", optimize=True)
    return NormalizedImage(out.getvalue(), width, height, fmt)
