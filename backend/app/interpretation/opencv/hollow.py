"""Walls drawn as double outlines ("hollow" walls, optionally hatched inside like CAD poché).

The wall detector reads walls as solid, thick strokes. Many architectural drawings instead draw
a wall as two thin parallel lines, with nothing (or a diagonal hatch) between them. This module
turns such outline pairs back into solid wall bands, so the normal wall detector can read them.
It is only tried after every solid reading has failed (see `resolution.py`), so drawings that
already work are never affected.

The difficulty is everything else drawn with parallel thin lines. Each rule below rejects one of
those look-alikes; nothing is filled unless all of them pass:

* Hatching, stairs, graph paper, ruled tables: the lines form a *periodic* series. A pair whose
  neighbouring gap on either side is about the same as its own gap is never a wall.
* Furniture next to a wall, dimension chains, door leaves: the pair is a strip whose end is
  open, i.e. one line carries on while the other stops with nothing closing the strip. A wall
  band ends where both outlines stop (an opening), where a line crosses it (a jamb or cap),
  where a perpendicular band meets it, or where the same wall carries on after a junction.
  Both outlines may also run on briefly past the end (a stub beside a door, a door symbol that
  starts at the jamb); a strip's open-ended line runs on much further.
* Odd gaps: only gaps belonging to a frequent gap class (the drawing's wall thicknesses) count.
* Dimension lines and furniture rows along a wall: a line is the face of one wall only. When a
  wall's outline also pairs with a parallel line beyond it, the two bands are stacked on that
  outline. The drawing's real wall classes also occur as free-standing walls; a class that only
  ever appears stacked on another wall's outline is an artefact of that pairing and is dropped.
* Sheet borders and title-block frames: a bare outline ring that encloses every other band
  (a substantial drawing) without touching any of them is a frame, not a building, and is dropped.

Real line work is not continuous (scan dropouts, thresholded JPEGs). Where one outline breaks
for a short distance and the other carries on across the break, the wall is treated as
continuous: its pieces are joined (`_bridge`) and its end is extended to the perpendicular wall
it stops just short of (`_reach_junctions`). Where both outlines stop, there is an opening, and
nothing is filled.

What is left is accepted only if the walls it produces form a connected, room-making network
(checked by the caller), and the result is always reported with lower confidence than a solid
reading: the walls are a reconstruction, not something drawn as walls.
"""

from dataclasses import replace

import cv2
import numpy as np

from app.interpretation.opencv.types import Preprocessed, Unsupported
from app.interpretation.opencv.walls import open_rect

MIN_LINE = 20  # an outline segment between openings is at least this long (working px)
MAX_GAP = 48  # widest wall interior considered (about 0.5 m at typical working scales)
PERIODIC = 0.35  # a neighbouring gap within this share of a pair's gap makes the pair part of a series
MIN_BAND = 3  # columns
CLASS_SPREAD = (0.75, 1.3)  # a gap class covers this range around its peak
BRIDGE = 4  # a break in one outline is bridged over at most this many wall gaps (+4 px) ...
MAX_BRIDGE = 2 * MIN_LINE  # ... and never further: two breaks around one lost fragment
MIN_CARRY = 0.9  # ... when the other outline is present along this share of the break
FRAME_CORE = 0.05  # a sheet frame has at most this share of its pixels away from its bounding box
FRAME_CONTENT = 0.2  # ... and encloses bands of at least this share of its own area (a drawing, not a label)
STACK_SUPPORT = 0.5  # a stacked band goes when its class stands alone less than this share as often as the other's


# ---- outline pairs -------------------------------------------------------------------------------

def _pairs(lines: np.ndarray) -> np.ndarray:
    """Consecutive horizontal line pairs in every column that are not part of a periodic series.

    Returns an (N, 5) int array of (x, top start, top end, bottom start, bottom end), rows exclusive at the end."""
    h, w = lines.shape
    padded = np.zeros((h + 2, w), np.int8)
    padded[1:-1] = lines > 0
    d = np.diff(padded, axis=0)
    sx, sy = np.nonzero(d.T == 1)  # column-major: sorted by column, then row
    _, ey = np.nonzero(d.T == -1)
    if sx.size < 2:
        return np.zeros((0, 5), int)
    i = np.flatnonzero(sx[:-1] == sx[1:])  # line i and line i+1 are consecutive in the same column
    gap = sy[i + 1] - ey[i]
    ok = (gap >= 2) & (gap <= MAX_GAP)
    above = np.full(i.shape, -1)
    has_above = (i > 0) & (sx[np.maximum(i - 1, 0)] == sx[i])
    above[has_above] = sy[i[has_above]] - ey[i[has_above] - 1]
    below = np.full(i.shape, -1)
    has_below = (i + 2 < sx.size) & (sx[np.minimum(i + 2, sx.size - 1)] == sx[i])
    below[has_below] = sy[i[has_below] + 2] - ey[i[has_below] + 1]
    periodic = ((above >= 0) & (np.abs(above - gap) <= PERIODIC * gap)) | ((below >= 0) & (np.abs(below - gap) <= PERIODIC * gap))
    i = i[ok & ~periodic]
    return np.stack([sx[i], sy[i], ey[i], sy[i + 1], ey[i + 1]], axis=1)


def _bands(pairs: np.ndarray, min_len: int = MIN_BAND) -> list[np.ndarray]:
    """Link pairs in neighbouring columns that overlap and have a similar gap into bands."""
    n = len(pairs)
    if not n:
        return []
    parent = np.arange(n)

    def root(k: int) -> int:
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    by_x: dict[int, list[int]] = {}
    for k, x in enumerate(pairs[:, 0].tolist()):
        by_x.setdefault(x, []).append(k)
    gaps = pairs[:, 3] - pairs[:, 2]
    for k in range(n):
        x, a0, _, _, b1 = pairs[k].tolist()
        for j in by_x.get(x - 1, ()):
            if pairs[j, 1] < b1 and a0 < pairs[j, 4] and abs(gaps[j] - gaps[k]) <= max(1, 0.25 * gaps[k]):
                parent[root(k)] = root(j)
    roots = np.array([root(k) for k in range(n)])
    order = np.argsort(roots, kind="stable")
    cuts = np.flatnonzero(np.diff(roots[order])) + 1
    return [pairs[g] for g in np.split(order, cuts) if len(g) >= min_len]


def _bridge_len(gap: int) -> int:
    """Longest break in an outline (or stub of one outline past the other) read as part of a wall of this gap."""
    return min(BRIDGE * gap + 4, MAX_BRIDGE)


def _run(outline: np.ndarray) -> int:
    """How many columns from the first one the outline (rows × columns) carries on without a break."""
    present = (outline > 0).any(axis=0)
    return int(present.size if present.all() else np.argmin(present))


def _carries_on(top: np.ndarray, bottom: np.ndarray) -> bool:
    """Both outlines (rows × columns, from a band end outwards) are present again at the far end, and the
    one that breaks is bridged by the other: the wall continues after a junction or a dropout."""
    t, b = (top > 0).any(axis=0), (bottom > 0).any(axis=0)
    tail = slice(-MIN_BAND, None)
    if not (t[tail].all() and b[tail].all()):
        return False
    return bool(t.mean() >= MIN_CARRY or b.mean() >= MIN_CARRY)


def _bridge(bands: list[np.ndarray], lines: np.ndarray) -> list[np.ndarray]:
    """Join collinear pieces of one wall that a break in one of its outlines split apart.

    A scan or a thresholded JPEG drops short pieces of line work; a piece shorter than MIN_LINE between
    two breaks is lost entirely. Two band pieces are joined when they have the same outlines (rows and
    gap) and the other outline carries on across the break. A door is never bridged: both outlines stop.
    The break is at most a few wall gaps long (and at most MAX_BRIDGE), shorter than any door."""
    if len(bands) < 2:
        return bands
    first, last = _ends(bands)
    gaps_f = first[:, 3] - first[:, 2]
    parent = list(range(len(bands)))

    def root(k: int) -> int:
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    filled: dict[int, list[np.ndarray]] = {}
    for k in range(len(bands)):
        x, a0, a1, b0, b1 = (int(v) for v in last[k])
        g = b0 - a1
        dist = first[:, 0] - x
        near = ((dist >= 1) & (dist <= _bridge_len(g)) & (np.abs(first[:, 1] - a0) <= 2) & (np.abs(first[:, 4] - b1) <= 2)
                & (np.abs(gaps_f - g) <= max(1, 0.25 * g)))
        for j in sorted(np.flatnonzero(near).tolist(), key=lambda j: (dist[j], j)):
            if root(j) == root(k):
                continue
            cols = np.arange(x + 1, int(first[j, 0]))
            if cols.size:
                top = (lines[a0:a1, cols] > 0).any(axis=0).mean()
                bottom = (lines[b0:b1, cols] > 0).any(axis=0).mean()
                if max(top, bottom) < MIN_CARRY:
                    continue
                filled.setdefault(k, []).append(np.stack([cols] + [np.full(cols.size, v) for v in (a0, a1, b0, b1)], axis=1))
            parent[root(j)] = root(k)
            break
    groups: dict[int, list[np.ndarray]] = {}
    for k, band in enumerate(bands):
        groups.setdefault(root(k), []).extend([band] + filled.get(k, []))
    return [np.concatenate(g) for _, g in sorted(groups.items())]


# ---- which bands are walls -----------------------------------------------------------------------

def _ends(bands: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """Per band, its first and last pair (rows of `pairs`)."""
    first = np.array([b[np.argmin(b[:, 0])] for b in bands])
    last = np.array([b[np.argmax(b[:, 0])] for b in bands])
    return first, last


def _explained(lines: np.ndarray, ink: np.ndarray, other_fill: np.ndarray, bands: list[np.ndarray]) -> list[bool]:
    """Is every end of each band explained (opening, cap, perpendicular wall, continuation, image edge)?"""
    if not bands:
        return []
    first, last = _ends(bands)
    gaps_f, gaps_l = first[:, 3] - first[:, 2], last[:, 3] - last[:, 2]
    w = lines.shape[1]
    result = []
    for k in range(len(bands)):
        ok = True
        for at_start in (True, False):
            p = first[k] if at_start else last[k]
            x, a0, a1, b0, b1 = (int(v) for v in p)
            g = b0 - a1
            reach = int(1.5 * g) + 3
            # the same wall carries on after a junction or a short break
            q = last if at_start else first
            qg = gaps_l if at_start else gaps_f
            dist = (x - q[:, 0]) if at_start else (q[:, 0] - x)
            cont = (dist > 0) & (dist <= reach) & (q[:, 1] < b1) & (q[:, 4] > a0) & (np.abs(qg - g) <= max(1, 0.25 * g))
            cont[k] = False
            if cont.any():
                continue
            cols = np.arange(x - 1, x - 1 - reach, -1) if at_start else np.arange(x + 1, x + 1 + reach)
            cols = cols[(cols >= 0) & (cols < w)]
            if not cols.size:
                continue  # image edge
            if (ink[a1:b0, cols] > 0).all(axis=0).any() or (other_fill[a1:b0, cols] > 0).any():
                continue  # a cap line crosses the band, or it runs into a perpendicular band
            far = cols[cols.size // 2:]  # both outlines have stopped by the far end: an opening (short jamb stubs are fine)
            if (lines[a0:a1, far] > 0).any(axis=0).mean() < 0.5 and (lines[b0:b1, far] > 0).any(axis=0).mean() < 0.5:
                continue
            # Both outlines stop soon after: a wall stub next to a door, a door symbol starting at the jamb, or one
            # broken outline. Furniture, dimension lines and door leaves run on much further beside open paper.
            stub = _bridge_len(g)
            ext = np.arange(x - 1, x - 2 - stub, -1) if at_start else np.arange(x + 1, x + 2 + stub)
            ext = ext[(ext >= 0) & (ext < w)]
            if ext.size == stub + 1 and _run(lines[a0:a1, ext]) <= stub and _run(lines[b0:b1, ext]) <= stub:
                continue
            # The same wall carries on past a short break in one outline that no band covers, e.g. a T-junction
            # whose far side runs along an open door leaf (leaf and outlines look like a periodic series there).
            if ext.size == stub + 1 and _carries_on(lines[a0:a1, ext], lines[b0:b1, ext]):
                continue
            ok = False  # one outline runs on with open paper beside it: furniture, a dimension line, a door leaf
            break
        result.append(ok)
    return result


def _reach_junctions(bands: list[np.ndarray], lines: np.ndarray, other: np.ndarray) -> list[np.ndarray]:
    """Extend band ends that stop just short of a perpendicular wall band up to it.

    Where an outline is broken next to a junction, the corner pocket is open, so it is not filled as one and
    the wall seems to end in mid-air. As in `_bridge`, the other outline must carry on across the space: a
    door next to the junction (no outlines across it) is never filled."""
    if not bands:
        return bands
    first, last = _ends(bands)
    w = lines.shape[1]
    out = []
    for k, band in enumerate(bands):
        parts = [band]
        for p, step in ((first[k], -1), (last[k], 1)):
            x, a0, a1, b0, b1 = (int(v) for v in p)
            cols = x + step * np.arange(1, _bridge_len(b0 - a1) + 1)
            cols = cols[(cols >= 0) & (cols < w)]
            hit = np.flatnonzero((other[a1:b0, cols] > 0).any(axis=0))
            if not hit.size or hit[0] == 0:
                continue
            cols = cols[:hit[0]]
            top, bottom = (lines[a0:a1, cols] > 0).any(axis=0).mean(), (lines[b0:b1, cols] > 0).any(axis=0).mean()
            if max(top, bottom) >= MIN_CARRY:
                parts.append(np.stack([cols] + [np.full(cols.size, v) for v in (a0, a1, b0, b1)], axis=1))
        out.append(np.concatenate(parts))
    return out


def _paint(bands: list[np.ndarray], shape: tuple[int, int]) -> np.ndarray:
    fill = np.zeros(shape, np.uint8)
    for band in bands:
        for x, a0, _, _, b1 in band.tolist():
            fill[a0:b1, x] = 255
    return fill


def _stacked(bands: list[np.ndarray], class_of) -> list[tuple[int, int]]:
    """(i, j) for bands of different gap classes where band j's first outline is band i's second one (their
    rows overlap) along a shared stretch (at least half the shorter band): two readings of the same outline."""
    if len(bands) < 2:
        return []
    med = np.array([np.median(b, axis=0) for b in bands])
    x0 = np.array([b[:, 0].min() for b in bands])
    x1 = np.array([b[:, 0].max() for b in bands])
    classes = [class_of(b) for b in bands]
    out = []
    for i in range(len(bands)):
        on_outline = np.maximum(med[:, 1], med[i, 3]) < np.minimum(med[:, 2], med[i, 4])
        shared = np.minimum(x1, x1[i]) - np.maximum(x0, x0[i])
        for j in np.flatnonzero(on_outline & (shared >= 0) & (shared >= 0.5 * np.minimum(x1 - x0, x1[i] - x0[i]))).tolist():
            if j != i and classes[j] != classes[i]:
                out.append((i, j))
    return out


def _drop_stacked(walls_h: list[np.ndarray], walls_v: list[np.ndarray], class_of) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Of two bands stacked on one outline, drop the one whose gap class is (almost) never a free-standing wall.

    A class's support is the share of its band length not stacked on another class. The drawing's walls
    (partitions, most of the exterior) stand alone; the strip between a wall and a dimension line or a row
    of furniture exists only beside that wall. When both classes are mostly stacked there is no evidence
    either way, and both are kept."""
    stacks = [_stacked(walls_h, class_of), _stacked(walls_v, class_of)]
    total: dict = {}
    alone: dict = {}
    for bands, pairs in zip((walls_h, walls_v), stacks):
        involved = {k for pair in pairs for k in pair}
        for k, b in enumerate(bands):
            c = class_of(b)
            total[c] = total.get(c, 0) + len(b)
            alone[c] = alone.get(c, 0) + (0 if k in involved else len(b))
    support = {c: alone[c] / total[c] for c in total}
    out = []
    for bands, pairs in zip((walls_h, walls_v), stacks):
        drop = set()
        for i, j in pairs:
            si, sj = support[class_of(bands[i])], support[class_of(bands[j])]
            if si < STACK_SUPPORT * sj:
                drop.add(i)
            elif sj < STACK_SUPPORT * si:
                drop.add(j)
        out.append([b for k, b in enumerate(bands) if k not in drop])
    return out[0], out[1]


def _classes(gaps: np.ndarray, min_total: float) -> list[tuple[int, int]]:
    """Gap ranges that occur often enough to be the drawing's wall thicknesses."""
    hist = np.bincount(gaps, minlength=MAX_GAP + 2).astype(float)
    smooth = np.convolve(hist, [0.25, 0.5, 0.25], mode="same")
    peaks = [g for g in range(2, MAX_GAP + 1) if smooth[g] >= smooth[g - 1] and smooth[g] > smooth[g + 1]]
    if not peaks:
        return []
    top = max(smooth[p] for p in peaks)
    out = []
    for p in peaks:
        lo, hi = int(np.floor(p * CLASS_SPREAD[0])), int(np.ceil(p * CLASS_SPREAD[1]))
        if smooth[p] >= 0.15 * top and hist[lo:hi + 1].sum() >= min_total:
            out.append((lo, hi))
    return out


def _fill_junctions(fill: np.ndarray, ink: np.ndarray, widest: int) -> np.ndarray:
    """Corner and junction squares contain no parallel pair: fill the small paper pockets that the outlines
    and the bands enclose completely, and the hatch strokes between filled fragments."""
    pocket = (cv2.bitwise_or(ink, fill) == 0).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(pocket, connectivity=4)
    near = np.zeros(n, bool)
    near[np.unique(lab[cv2.dilate(fill, np.ones((3, 3), np.uint8)) > 0])] = True
    side = widest + 4
    small = (st[:, cv2.CC_STAT_AREA] <= 2 * side * side) & (st[:, cv2.CC_STAT_WIDTH] <= side) & (st[:, cv2.CC_STAT_HEIGHT] <= side)
    small[0] = False
    fill = fill.copy()
    fill[(small & near)[lab]] = 255
    fill[(ink > 0) & (cv2.morphologyEx(fill, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0)] = 255
    return fill


def _drop_frames(fill: np.ndarray, widest: int = MAX_GAP) -> np.ndarray:
    """Remove sheet borders: thin outlines enclosing every other band without touching any (often nested).

    A frame is a bare ring (nearly all of it lies along its bounding box) around a substantial drawing.
    A building whose partitions failed to join its outer walls is not one: the partitions are part of it
    away from the box, or what it encloses is only a few stray marks (room labels fused by blur)."""
    while True:
        n, lab, st, _ = cv2.connectedComponentsWithStats(fill, connectivity=8)
        if n <= 2:
            return fill
        i = int(np.argmax(st[1:, cv2.CC_STAT_WIDTH] * st[1:, cv2.CC_STAT_HEIGHT])) + 1
        x, y, w, h, area = (int(v) for v in st[i])
        others = np.delete(np.arange(1, n), i - 1)
        o = st[others]
        inside = bool(np.all((o[:, 0] > x) & (o[:, 1] > y) & (o[:, 0] + o[:, 2] < x + w) & (o[:, 1] + o[:, 3] < y + h)))
        m = 2 * widest + 4
        core = int(np.count_nonzero(lab[y + m:y + h - m, x + m:x + w - m] == i)) if w > 2 * m and h > 2 * m else area
        ring = core <= FRAME_CORE * area
        encloses_plan = int(o[:, cv2.CC_STAT_AREA].sum()) >= FRAME_CONTENT * area
        if not (inside and area < 0.15 * w * h and ring and encloses_plan):
            return fill
        fill = fill.copy()
        fill[lab == i] = 0


def fill_hollow_walls(ink: np.ndarray) -> np.ndarray:
    """Solid wall bands reconstructed from double-line walls (255 = wall). Raises `Unsupported` if none."""
    h, w = ink.shape
    lh = open_rect(ink, MIN_LINE, 1)  # long horizontal thin lines
    lv = np.ascontiguousarray(open_rect(ink, 1, MIN_LINE).T)  # long vertical lines, transposed to run along x
    ink_t = np.ascontiguousarray(ink.T)
    pairs_h, pairs_v = _pairs(lh), _pairs(lv)
    bands_h, bands_v = _bridge(_bands(pairs_h), lh), _bridge(_bands(pairs_v), lv)
    # Every candidate, however short, to recognise where a band meets a perpendicular one.
    raw_h, raw_v = _paint(_bands(pairs_h, 1), ink.shape), _paint(_bands(pairs_v, 1), ink_t.shape)
    bands_h = [b for b, ok in zip(bands_h, _explained(lh, ink, np.ascontiguousarray(raw_v.T), bands_h)) if ok]
    bands_v = [b for b, ok in zip(bands_v, _explained(lv, ink_t, np.ascontiguousarray(raw_h.T), bands_v)) if ok]
    if not bands_h and not bands_v:
        raise Unsupported("no double-line walls")
    gaps = np.concatenate([b[:, 3] - b[:, 2] for b in bands_h + bands_v])
    classes = _classes(gaps, 0.25 * min(h, w))
    if not classes:
        raise Unsupported("no consistent double-line wall thickness")

    def class_of(band: np.ndarray) -> tuple[int, int] | None:
        g = float(np.median(band[:, 3] - band[:, 2]))
        return next(((lo, hi) for lo, hi in classes if lo <= g <= hi), None)

    walls_h, walls_v = [b for b in bands_h if class_of(b)], [b for b in bands_v if class_of(b)]
    walls_h, walls_v = _drop_stacked(walls_h, walls_v, class_of)
    fill_h, fill_v = _paint(walls_h, ink.shape), np.ascontiguousarray(_paint(walls_v, ink_t.shape).T)
    walls_h = _reach_junctions(walls_h, lh, fill_v)
    walls_v = _reach_junctions(walls_v, lv, np.ascontiguousarray(fill_h.T))
    fill = cv2.bitwise_or(_paint(walls_h, ink.shape), np.ascontiguousarray(_paint(walls_v, ink_t.shape).T))
    widest = max(hi for _, hi in classes)
    fill = _drop_frames(_fill_junctions(fill, ink, widest), widest)
    if not cv2.countNonZero(fill):
        raise Unsupported("no double-line walls")
    return fill


def hollow_inputs(pre: Preprocessed) -> tuple[Preprocessed, Preprocessed]:
    """(preprocessing for the wall detector, preprocessing for the later stages) of a hollow-wall drawing.

    The wall detector sees only the reconstructed bands: in a hollow drawing every other stroke is annotation.
    The later stages see the drawing plus the bands; in the grey image the bands are painted solid, so the
    light interior of a hollow wall is not mistaken for window glazing."""
    fill = fill_hollow_walls(pre.ink)
    later = replace(pre, ink=cv2.bitwise_or(pre.ink, fill), symbols=cv2.bitwise_or(pre.symbols, fill),
                    gray=np.minimum(pre.gray, cv2.bitwise_not(fill)))
    return replace(later, ink=fill), later
