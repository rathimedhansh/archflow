"""Validate and normalize an uploaded floor-plan image.

This is the single entry point through which raw user bytes become a trusted
image. Everything downstream (the future CV pipeline) can assume its input is
a decoded, size-bounded, metadata-free PNG.
"""

import io
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

from app.errors import InvalidImage, UnsupportedFileType

ALLOWED_FORMATS = {"PNG", "JPEG"}
MAX_PIXELS = 40_000_000

# Pillow's own decompression-bomb guard; keep it aligned with our limit.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


@dataclass(frozen=True)
class NormalizedImage:
    png_bytes: bytes
    width: int
    height: int
    source_format: str


def normalize_upload(data: bytes) -> NormalizedImage:
    """Decode `data` by content (never by filename/MIME) and re-encode as clean PNG."""
    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = probe.format
            if fmt not in ALLOWED_FORMATS:
                raise UnsupportedFileType("Only PNG and JPEG images are supported.")
            probe.verify()  # cheap integrity check; invalidates `probe`
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            img = ImageOps.exif_transpose(img)  # honour camera rotation
            width, height = img.size
            rgb = img.convert("RGB")  # flatten alpha/palette; drops all metadata
    except (UnidentifiedImageError, Image.DecompressionBombError, SyntaxError, OSError) as exc:
        if isinstance(exc, Image.DecompressionBombError):
            raise InvalidImage("Image dimensions are too large.") from exc
        raise InvalidImage("File is not a valid PNG or JPEG image.") from exc

    out = io.BytesIO()
    rgb.save(out, format="PNG", optimize=True)
    return NormalizedImage(out.getvalue(), width, height, fmt)
