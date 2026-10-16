"""Stage 4: classify every wall gap as a door, a window, or an unknown opening.

Supported symbols (the common architectural conventions):
* Door: a gap in the wall with a quarter-circle swing arc (radius = gap width) hinged at
  one end, on either side of the wall. Double doors: two arcs of half the width. Next to a
  wall junction the door may be narrower than the detected gap (the tiny wall stub beside it
  is not detected); then the best-fitting narrower arc is searched for.
* Window: a gap in the wall bridged by two or more thin lines running along the wall,
  inside the wall's thickness.

Anything else (a plain gap, a sliding door, an unfamiliar symbol) is reported as an
unknown opening and left open: the detector does not guess.
"""

import math
from dataclasses import replace

import cv2
import numpy as np

from app.interpretation.opencv.types import Gap, Opening, OpeningDetection, Preprocessed, WallDetection
from app.interpretation.opencv.walls import open_rect

ARC_SAMPLES = 24
DOOR_THRESHOLD = 0.6
NARROW_DOOR_THRESHOLD = 0.7
WINDOW_MIN_LINES = 2
LINE_COVERAGE = 0.8


def _gap_frame(g: Gap, image: np.ndarray) -> np.ndarray:
    """View `image` so the gap's wall runs horizontally (rows = across the wall)."""
    return image if g.orientation == "h" else image.T


def _count_lines(band: np.ndarray) -> tuple[int, float]:
    """Groups of consecutive rows that are (almost) fully covered: lines running along the wall."""
    coverage = band.mean(axis=1)
    lines, covs, run = 0, [], []
    for value in list(coverage) + [0.0]:
        if value >= LINE_COVERAGE:
            run.append(value)
        elif run:
            lines += 1
            covs.append(float(np.mean(run)))
            run = []
    return lines, (float(np.mean(covs)) if covs else 0.0)


def _window_evidence(g: Gap, ink: np.ndarray, gray: np.ndarray) -> tuple[int, float, float]:
    """(number of thin lines spanning the gap, their mean coverage, share of the band containing ink).

    Lines are counted on the ink mask and on the raw grayscale (where 1 px separations between
    closely spaced window lines survive), and the larger count is used."""
    a, b = int(math.ceil(g.start)) + 1, int(math.floor(g.end)) - 1
    c0, c1 = int(math.ceil(g.center - g.thickness / 2)), int(math.floor(g.center + g.thickness / 2))
    if b - a < 3 or c1 - c0 < 1:
        return 0, 0.0, 0.0
    band = _gap_frame(g, ink)[max(0, c0) : c1 + 1, max(0, a) : b] > 0
    if band.size == 0:
        return 0, 0.0, 0.0
    lines, cov = _count_lines(band)
    raw = _gap_frame(g, gray)[max(0, c0) : c1 + 1, max(0, a) : b].astype(np.float32)
    paper = float(np.median(gray))
    raw_lines, raw_cov = _count_lines(raw < paper - max(40.0, 0.35 * (paper - float(raw.min()))))
    if raw_lines > lines:
        lines, cov = raw_lines, raw_cov
    return lines, cov, float(band.any(axis=0).mean())


def _arc_score(thin: np.ndarray, hinge: tuple[float, float], radius: float, along_sign: int, side: int) -> float:
    """Share of points on a quarter circle around `hinge` that fall on thin ink (rows=across, cols=along)."""
    across, along = hinge
    hits = 0
    h, w = thin.shape
    for s in range(ARC_SAMPLES):
        theta = math.radians(10 + 75 * s / (ARC_SAMPLES - 1))  # skip the ends touching the wall and the leaf
        col = int(round(along + along_sign * radius * math.cos(theta)))
        row = int(round(across + side * radius * math.sin(theta)))
        if 0 <= row < h and 0 <= col < w and thin[row, col]:
            hits += 1
    return hits / ARC_SAMPLES


def _narrower_door(g: Gap, img: np.ndarray) -> tuple[float, float, float]:
    """Best single-leaf door *narrower* than the gap: (score, door start, door end).

    Next to a wall junction the short wall stub beside a door is often too small to be
    detected, so the gap runs on to the perpendicular wall and is wider than the door. Search
    hinge positions and radii (0.6-1.0 × gap width) for an arc that fits inside the gap."""
    thetas = np.radians(10 + 75 * np.arange(ARC_SAMPLES) / (ARC_SAMPLES - 1))
    cos, sin = np.cos(thetas)[None, :], np.sin(thetas)[None, :]
    h, w = img.shape
    best = (0.0, g.start, g.end)
    radii = np.arange(math.ceil(0.6 * g.width), math.floor(g.width) + 1, dtype=float)
    for side in (-1, 1):
        face = g.center + side * g.thickness / 2
        for sign in (1, -1):  # 1: hinge at the door's start, -1: at its end
            for r in radii:
                lo, hi = (g.start, g.end - r) if sign == 1 else (g.start + r, g.end)
                if hi < lo:
                    continue
                hinges = np.arange(lo, hi + 0.5, 1.0)[:, None]
                cols = np.rint(hinges + sign * r * cos).astype(int)
                rows = np.rint(np.broadcast_to(face + side * r * sin, cols.shape)).astype(int)
                ok = (rows >= 0) & (rows < h) & (cols >= 0) & (cols < w)
                hits = np.zeros(cols.shape, bool)
                hits[ok] = img[rows[ok], cols[ok]]
                scores = hits.mean(axis=1)
                i = int(np.argmax(scores))
                if scores[i] > best[0]:
                    hinge = float(hinges[i, 0])
                    best = (float(scores[i]), *((hinge, hinge + r) if sign == 1 else (hinge - r, hinge)))
    return best


def _door_evidence(g: Gap, thin_near: np.ndarray) -> tuple[float, str, float, float]:
    """(score, description, door start, door end) of the best door symbol in the gap."""
    img = _gap_frame(g, thin_near)
    best, how = 0.0, ""
    for side in (-1, 1):
        face = g.center + side * g.thickness / 2
        for hinge, sign, label in ((g.start, 1, "hinged at the start"), (g.end, -1, "hinged at the end")):
            score = _arc_score(img, (face, hinge), g.width, sign, side)
            if score > best:
                best, how = score, f"single swing arc {label}"
        double = (_arc_score(img, (face, g.start), g.width / 2, 1, side) + _arc_score(img, (face, g.end), g.width / 2, -1, side)) / 2
        if double > best:
            best, how = double, "double-door arcs"
    if best >= DOOR_THRESHOLD:
        return best, how, g.start, g.end
    # A narrower door is one of many hypotheses, so it must be clearer to count.
    score, start, end = _narrower_door(g, img)
    if score >= NARROW_DOOR_THRESHOLD and score > best:
        return score, "swing arc of a door narrower than the wall gap (next to a junction)", start, end
    return best, how, g.start, g.end


def _windows_in_bands(pre: Preprocessed, walls: WallDetection) -> list[Opening]:
    """Windows drawn *inside* a continuous wall band: dark frame lines at both faces of the wall
    with light stripes between them. At low resolution the stripes are too thin to survive
    thresholding, so this reads the grayscale image directly."""
    gray = pre.gray.astype(np.float32)
    paper = float(np.median(gray))
    found: list[Opening] = []
    for wseg in walls.walls:
        img = gray if wseg.orientation == "h" else gray.T
        t = wseg.thickness
        c0, c1 = int(round(wseg.center - t / 2)), int(round(wseg.center + t / 2)) - 1
        a, b = int(math.ceil(wseg.start + t)), int(math.floor(wseg.end - t))  # stay clear of junctions
        if c1 - c0 < 4 or b - a < 4:
            continue
        band = img[c0 : c1 + 1, a:b]
        ink_level = float(np.median(band))
        if paper - ink_level < 60:
            continue  # low contrast: cannot tell stripes from wall fill
        light = (paper + ink_level) / 2
        edge = max(2, int(round(0.3 * band.shape[0])))
        dark = band <= light
        # A frame line near each face of the wall, and a light stripe between the two.
        framed = dark[:edge].any(axis=0) & dark[-edge:].any(axis=0)
        first = np.where(dark[:edge].any(axis=0), edge - 1 - np.argmax(dark[:edge][::-1], axis=0), 0)
        last = np.where(dark[-edge:].any(axis=0), band.shape[0] - edge + np.argmax(dark[-edge:], axis=0), band.shape[0] - 1)
        rows = np.arange(band.shape[0])[:, None]
        between = (rows > first[None, :]) & (rows < last[None, :])
        striped = ((band > light) & between).any(axis=0)
        cols = striped & framed
        in_gap = np.zeros_like(cols)
        for g in walls.gaps:
            if g.wall_id == wseg.id:
                in_gap[max(0, int(g.start) - a - 2) : max(0, int(g.end) - a + 2)] = True
        cols &= ~in_gap
        min_len = max(2 * walls.min_thickness_px, 0.8 * walls.thickness_px)
        run_start = None
        for i, v in enumerate(list(cols) + [False]):
            if v and run_start is None:
                run_start = i
            elif not v and run_start is not None:
                if i - run_start >= min_len:
                    gap = Gap(wall_id=wseg.id, orientation=wseg.orientation, center=wseg.center,
                              start=float(a + run_start), end=float(a + i), thickness=t)
                    stripe_share = float(striped[run_start:i].mean())
                    found.append(Opening("window", gap, round(0.75 * stripe_share, 3), "light stripes inside the wall"))
                run_start = None
    return found


def detect_openings(pre: Preprocessed, walls: WallDetection) -> OpeningDetection:
    ink = pre.symbols
    thick = open_rect(pre.ink, walls.min_thickness_px, walls.min_thickness_px)
    thin = cv2.bitwise_and(ink, cv2.bitwise_not(cv2.dilate(thick, np.ones((3, 3), np.uint8))))
    # Tolerate slightly imprecise arcs (hand drafting, rasterisation, JPEG).
    thin_near = cv2.dilate(thin, np.ones((5, 5), np.uint8)) > 0

    doors: list[Opening] = []
    windows: list[Opening] = []
    unknown: list[Opening] = []
    t = walls.thickness_px
    for g in walls.gaps:
        if g.width < max(2 * walls.min_thickness_px, 0.8 * t):
            continue  # narrower than any door or window: a break in the drawing; the wall stays continuous
        lines, line_cov, band_ink = _window_evidence(g, ink, pre.gray)
        if lines >= WINDOW_MIN_LINES:
            confidence = round(min(1.0, line_cov) * (1.0 if lines <= 4 else 0.7), 3)
            windows.append(Opening("window", g, confidence, f"{lines} thin lines across the gap"))
            continue
        score, how, d_start, d_end = _door_evidence(g, thin_near)
        # A door gap is empty, except that many CAD drawings close it with one threshold line.
        if score >= DOOR_THRESHOLD and (band_ink < 0.35 or lines == 1):
            if lines == 1:
                how += " (threshold line across the gap)"
            door_gap = g if (d_start, d_end) == (g.start, g.end) else replace(g, start=d_start, end=d_end)
            doors.append(Opening("door", door_gap, round(score, 3), how))
            continue
        if lines == 1:
            # One line bridging the gap inside the wall: a window drawn as a single sash line, or closely
            # spaced lines that merged. Door gaps are empty, so this is a window, but less certain.
            windows.append(Opening("window", g, round(0.65 * min(1.0, line_cov), 3), "one line across the gap"))
            continue
        why = "no door arc or window lines found" if score < DOOR_THRESHOLD else "door-like arc but the gap is not empty"
        unknown.append(Opening("unknown", g, round(max(score, line_cov if lines else 0.0), 3), why))
    windows.extend(_windows_in_bands(pre, walls))

    warnings: list[str] = []
    if unknown:
        n = len(unknown)
        warnings.append(
            f"{n} wall opening{'s' if n > 1 else ''} could not be identified as a door or window and "
            f"{'were' if n > 1 else 'was'} left as {'gaps' if n > 1 else 'a gap'} in the wall."
        )
    return OpeningDetection(doors=tuple(doors), windows=tuple(windows), unknown=tuple(unknown), warnings=tuple(warnings))
