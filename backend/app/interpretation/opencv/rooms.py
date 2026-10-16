"""Stage 3: walls -> enclosed room regions.

Rooms are the connected areas of free space once every wall and every candidate opening is
closed (a doorway still separates two rooms). Regions touching the image border are the
outside. Each room outline is snapped onto the wall centrelines around it, which is the same
convention as tracing a room by hand in the editor.
"""

import cv2
import numpy as np

from app.interpretation.opencv.types import Preprocessed, RoomDetection, RoomRegion, WallDetection, WallSegment


def _closed_walls(det: WallDetection, shape: tuple[int, int]) -> np.ndarray:
    closed = det.wall_mask.copy()
    for g in det.gaps:
        a, b = int(np.floor(g.start)), int(np.ceil(g.end))
        c0, c1 = int(np.floor(g.center - g.thickness / 2)), int(np.ceil(g.center + g.thickness / 2))
        if g.orientation == "h":
            closed[max(0, c0) : c1, max(0, a) : b] = 255
        else:
            closed[max(0, a) : b, max(0, c0) : c1] = 255
    # Seal hairline leaks where wall bands meet imperfectly.
    return cv2.dilate(closed, np.ones((3, 3), np.uint8))


def _snap_axis(value: float, other: float, walls: list[WallSegment], tol_extra: float) -> tuple[float, bool]:
    """Snap one coordinate of a vertex to the nearest parallel wall centreline that bounds it."""
    best: tuple[float, float] | None = None
    for w in walls:
        if abs(w.center - value) > w.thickness / 2 + tol_extra:
            continue
        if not (w.start - w.thickness <= other <= w.end + w.thickness):
            continue
        d = abs(w.center - value)
        if best is None or d < best[0]:
            best = (d, w.center)
    return (best[1], True) if best else (value, False)


def _clean(poly: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Drop repeated and collinear vertices."""
    changed = True
    while changed and len(poly) >= 3:
        changed = False
        for i in range(len(poly)):
            a, b, c = poly[i - 1], poly[i], poly[(i + 1) % len(poly)]
            cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            if abs(b[0] - a[0]) + abs(b[1] - a[1]) < 1e-6 or abs(cross) < 1e-6:
                poly.pop(i)
                changed = True
                break
    return poly


def _support(poly: list[tuple[float, float]], vertical: list[WallSegment], horizontal: list[WallSegment]) -> float:
    """Share of the outline's length that runs along a detected wall centreline."""
    total = supported = 0.0
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
        length = abs(x2 - x1) + abs(y2 - y1)
        total += length
        if abs(x1 - x2) < 1e-6:
            lo, hi = sorted((y1, y2))
            walls = [w for w in vertical if abs(w.center - x1) < 1e-6]
        elif abs(y1 - y2) < 1e-6:
            lo, hi = sorted((x1, x2))
            walls = [w for w in horizontal if abs(w.center - y1) < 1e-6]
        else:
            continue  # a diagonal edge is never on an axis-aligned wall
        covered = sum(max(0.0, min(hi, w.end) - max(lo, w.start)) for w in walls)
        supported += min(length, covered)
    return supported / total if total else 0.0


def detect_rooms(pre: Preprocessed, det: WallDetection) -> RoomDetection:
    h, w = pre.ink.shape
    closed = _closed_walls(det, (h, w))
    free = (closed == 0).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)

    border = set(np.unique(np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])).tolist())
    t = det.thickness_px
    min_area = max(16 * t * t, 0.0015 * h * w)
    horizontal = [s for s in det.walls if s.orientation == "h"]
    vertical = [s for s in det.walls if s.orientation == "v"]
    tol = 0.35 * t + 2

    candidates: list[tuple[list[tuple[float, float]], float, float, bool]] = []
    warnings: list[str] = []
    holes = 0
    for i in range(1, n):
        area = float(stats[i, cv2.CC_STAT_AREA])
        if i in border or area < min_area:
            continue
        region = (labels == i).astype(np.uint8)
        contours, hierarchy = cv2.findContours(region, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        outer = [c for c, hier in zip(contours, hierarchy[0]) if hier[3] == -1]
        if not outer:
            continue
        contour = max(outer, key=cv2.contourArea)
        has_hole = any(hier[3] != -1 for hier in hierarchy[0])
        approx = cv2.approxPolyDP(contour, max(1.5, 0.3 * t), True).reshape(-1, 2)
        poly: list[tuple[float, float]] = []
        for px, py in approx:
            # Region pixels are inside the room; its face is between the pixel and the wall.
            x, _ = _snap_axis(float(px) + 0.5, float(py) + 0.5, vertical, tol)
            y, _ = _snap_axis(float(py) + 0.5, float(px) + 0.5, horizontal, tol)
            poly.append((x, y))
        poly = _clean(poly)
        if len(poly) < 3:
            continue
        candidates.append((poly, area, _support(poly, vertical, horizontal), has_hole))

    # A region with a hole that contains other rooms is the space inside a drawing frame, not a room.
    rooms: list[RoomRegion] = []
    kept = []
    for poly, area, support, has_hole in candidates:
        if has_hole:
            inner = [p for p, *_ in candidates if p is not poly and cv2.pointPolygonTest(np.array(poly, np.float32), p[0], False) > 0]
            if inner:
                warnings.append("A drawing frame or border around the plan was ignored.")
                continue
            holes += 1
        kept.append((poly, area, support))

    kept.sort(key=lambda r: (round(min(y for _, y in r[0]), 1), round(min(x for x, _ in r[0]), 1)))
    dropped = 0
    for poly, area, support in kept:
        confidence = round(0.3 + 0.7 * support, 3)
        if confidence < 0.45:
            dropped += 1  # mostly bounded by things that are not walls: do not invent a room
            continue
        rooms.append(RoomRegion(id=f"r{len(rooms)}", polygon=tuple(poly), area_px=area, confidence=confidence))
    if holes:
        warnings.append(f"{holes} room{'s have' if holes > 1 else ' has'} an island inside (e.g. a column or stair core); the island is not cut out.")
    if dropped:
        warnings.append(f"{dropped} enclosed area{'s' if dropped > 1 else ''} not bounded by detected walls {'were' if dropped > 1 else 'was'} left out.")
    if not rooms and det.walls:
        warnings.append("No closed rooms were found. The outer walls may have a gap the detector could not close.")
    return RoomDetection(rooms=tuple(rooms), warnings=tuple(warnings))
