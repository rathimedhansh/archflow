"""Stage 1: image -> clean binary "ink" masks at a bounded working resolution, deskewed."""

import io
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from app.config import settings
from app.interpretation.opencv.types import Preprocessed, Unsupported
from app.processing.image_intake import image_size_text, pixel_limit_text

# Large enough for 5+ px interior walls on typical plans, small enough to stay fast.
MAX_WORKING_SIDE = 2000
MIN_RECOMMENDED_SIDE = 800
MIN_INK_RATIO = 0.003  # below: essentially blank
MAX_INK_RATIO = 0.40  # above: photo, filled/coloured drawing, or inverted scan we cannot read
MIN_SKEW_DEG = 0.25  # below this a scan is treated as straight
MAX_SKEW_DEG = 10.0  # above this the drawing is not a slightly skewed scan


def _too_large(pixels: int, size: tuple[int, int] | None = None) -> Unsupported:
    return Unsupported(f"The image is too large for automatic detection ({image_size_text(pixels, size)}; "
                       f"the limit is {pixel_limit_text()}).")


def load_image(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)  # works with non-ASCII paths on Windows
    if not data.size:
        raise Unsupported("The image could not be decoded.")
    # Size from the header before decoding (stored plans are normally checked at upload; this also covers
    # files changed on disk). If the header cannot be read, OpenCV decides below.
    try:
        with Image.open(io.BytesIO(data.tobytes())) as header:
            width, height = header.size
    except Image.DecompressionBombError:  # Pillow refused it as far over the limit
        raise Unsupported(f"The image is too large for automatic detection (the limit is {pixel_limit_text()}).") from None
    except Exception:  # noqa: BLE001 - unreadable header: let the decoder below refuse it
        width = height = 0
    if width * height > settings.max_image_pixels:
        raise _too_large(width * height, (width, height))
    image = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise Unsupported("The image could not be decoded.")
    if image.shape[0] * image.shape[1] > settings.max_image_pixels:  # decoded size, whatever the header said
        raise _too_large(image.shape[0] * image.shape[1], (image.shape[1], image.shape[0]))
    return image


def _despeckle(mask: np.ndarray, max_area: int) -> np.ndarray:
    """Remove isolated specks (scan dust, noise) smaller than any real stroke."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    small = np.flatnonzero(stats[:, cv2.CC_STAT_AREA] <= max_area)
    small = small[small != 0]
    if not small.size:
        return mask
    out = mask.copy()
    out[np.isin(labels, small)] = 0
    return out


def _binarize(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, bool]:
    """(gray with dark ink, ink mask, sensitive symbol mask, inverted?)."""
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)  # suppresses JPEG ringing and scanner noise
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    ink = cv2.bitwise_not(binary)  # dark strokes -> 255
    inverted = False
    # Plans are dark lines on light paper. Mostly "ink" means light-on-dark (e.g. a blueprint): flip.
    if cv2.countNonZero(ink) > 0.5 * ink.size:
        ink, gray, blurred, inverted = cv2.bitwise_not(ink), cv2.bitwise_not(gray), cv2.bitwise_not(blurred), True
    # Symbols: anything noticeably darker than the paper, so faint thin lines (door arcs, window
    # lines on a blurred or light scan) survive. Used only as symbol evidence, never for walls.
    paper = float(np.median(blurred))
    darkest = float(np.percentile(blurred, 0.5))
    cut = paper - max(25.0, 0.2 * (paper - darkest))
    symbols = cv2.bitwise_or(np.where(blurred < cut, 255, 0).astype(np.uint8), ink)
    return gray, ink, symbols, inverted


def estimate_skew(ink: np.ndarray) -> float | None:
    """Rotation of the drawing in degrees (the angle long straight lines make with the image
    axes), or None when there is no consistent answer."""
    h, w = ink.shape
    edges = cv2.Canny(ink, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, math.pi / 720, threshold=60, minLineLength=int(0.12 * min(h, w)), maxLineGap=4)
    if lines is None:
        return None
    angles, weights = [], []
    for x1, y1, x2, y2 in lines.reshape(-1, 4):  # OpenCV 4 returns (N, 1, 4), OpenCV 5 (N, 4)
        a = math.degrees(math.atan2(y2 - y1, x2 - x1))
        angles.append(((a + 45) % 90) - 45)  # fold horizontal and vertical lines together
        weights.append(math.hypot(x2 - x1, y2 - y1))
    order = np.argsort(angles)
    a_sorted, w_sorted = np.array(angles)[order], np.array(weights)[order]
    median = float(a_sorted[np.searchsorted(np.cumsum(w_sorted), w_sorted.sum() / 2)])
    agree = w_sorted[np.abs(a_sorted - median) <= 1.5].sum() / w_sorted.sum()
    return median if agree >= 0.5 else None


def preprocess(image: np.ndarray) -> Preprocessed:
    """Grayscale, downscale, binarize (Otsu), fix polarity, deskew, and reject images with no plan."""
    if image.ndim == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = image.shape
    warnings: list[str] = []
    if max(h, w) < MIN_RECOMMENDED_SIDE:
        warnings.append(
            f"Low resolution ({w}×{h} px). Thin walls may be missed; {MIN_RECOMMENDED_SIDE}+ px is recommended."
        )

    factor = max(1.0, max(h, w) / MAX_WORKING_SIDE)
    gray = image if factor == 1.0 else cv2.resize(image, (round(w / factor), round(h / factor)), interpolation=cv2.INTER_AREA)
    if float(gray.std()) < 2.0:
        raise Unsupported("The image is blank: no drawing was found.")

    gray, ink, symbols, inverted = _binarize(gray)
    if inverted:
        warnings.append("Light-on-dark drawing detected; colours were inverted.")
    ratio = cv2.countNonZero(ink) / ink.size
    if ratio < MIN_INK_RATIO:
        raise Unsupported("The image is almost empty: no floor-plan drawing was found.")
    if ratio > MAX_INK_RATIO:
        raise Unsupported(
            "Too much of the image is dark. This looks like a photo, a shaded or coloured rendering, "
            "or a scan with a dark background, which the automatic detector does not support."
        )

    # A slightly rotated scan is straightened; results are rotated back to image coordinates later.
    to_image = None
    skew = estimate_skew(ink)
    if skew is not None and MIN_SKEW_DEG <= abs(skew) <= MAX_SKEW_DEG:
        gh, gw = gray.shape
        m = cv2.getRotationMatrix2D((gw / 2, gh / 2), skew, 1.0)
        paper = int(np.median(gray))
        gray = cv2.warpAffine(gray, m, (gw, gh), flags=cv2.INTER_LINEAR, borderValue=paper)
        gray, ink, symbols, _ = _binarize(gray)  # `gray` is already dark-on-light here
        to_image = cv2.invertAffineTransform(m)
        warnings.append(f"The drawing is rotated by about {abs(skew):.1f}°; it was straightened for detection.")
    elif skew is not None and abs(skew) > MAX_SKEW_DEG:
        raise Unsupported(f"The drawing is rotated by about {abs(skew):.0f}°. Upload it straight (walls horizontal and vertical).")

    return Preprocessed(
        gray=gray, ink=_despeckle(ink, 3), symbols=_despeckle(symbols, 4), factor=factor, ink_ratio=ratio,
        inverted=inverted, to_image=to_image, skew_deg=skew or 0.0, warnings=tuple(warnings),
    )
