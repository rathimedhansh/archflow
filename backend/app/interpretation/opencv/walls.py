"""Stage 2: ink mask -> axis-aligned wall centrelines, plus the gaps between collinear pieces.

Approach (classical CV, no learning):
1. Estimate the wall stroke thickness from the histogram of ink run lengths. Walls are the
   thick strokes; text, dimension lines, door arcs, window lines and furniture are thin.
2. Morphological opening with a thick horizontal (then vertical) rectangle keeps only thick,
   long, axis-aligned strokes: the walls.
3. Each connected band becomes a centreline segment with a measured thickness.
4. Collinear pieces separated by a short break are merged into one wall and the break is
   recorded as a candidate opening (door / window / unknown, decided in a later stage).
5. Wall ends are snapped onto the centreline of the perpendicular wall they run into, so
   corners and T-junctions share exact points (the editor can then move them together).
"""

from dataclasses import replace

import cv2
import numpy as np

from app.interpretation.opencv.types import Gap, Preprocessed, Unsupported, WallDetection, WallSegment

MAX_GAP_FACTOR = 16  # breaks longer than this many wall thicknesses are not openings
MAX_THIN_PX = 3  # annotation line width limit at working resolution
MIN_WALL_PX = 4  # thinnest wall the detector supports at working resolution
MAX_UNEXPLAINED = 0.55  # above this share of thick ink, the drawing is not axis-aligned walls


# ---- thickness estimation -----------------------------------------------------------------

def _runs(b: np.ndarray) -> np.ndarray:
    """Lengths of horizontal runs of True in every row."""
    padded = np.zeros((b.shape[0], b.shape[1] + 2), np.int8)
    padded[:, 1:-1] = b
    d = np.diff(padded, axis=1)
    return np.flatnonzero(d == -1) - np.flatnonzero(d == 1)


def _peaks(hist: np.ndarray, min_count: float) -> list[int]:
    """Local maxima of a smoothed histogram above `min_count`, ascending by thickness."""
    peaks = []
    for t in range(1, len(hist) - 1):
        if hist[t] >= min_count and hist[t] >= hist[t - 1] and hist[t] > hist[t + 1]:
            peaks.append(t)
    return peaks


def open_rect(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    """Morphological opening with a width×height rectangle, treating outside the image as paper.

    OpenCV's default border for erosion counts outside pixels as ink, so a wall lying along the
    image edge would survive an opening across it and fuse the walls at its ends into one blob."""
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (width, height))
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)


def estimate_thickness(ink: np.ndarray) -> tuple[float, float, int, int | None]:
    """(dominant wall thickness, thickest wall, minimum wall thickness, thin-line width) in px."""
    b = ink > 0
    h, w = b.shape
    cap = max(12, min(h, w) // 6)
    runs = np.concatenate([_runs(b), _runs(b.T)])
    runs = runs[runs <= cap]
    if runs.size == 0:
        raise Unsupported("No line work was found in the image.")
    hist = np.bincount(runs, minlength=cap + 2).astype(float)
    smooth = np.convolve(hist, [0.25, 0.5, 0.25], mode="same")

    # A real wall set spans at least about half the image side in total length.
    significant = max(0.04 * smooth.max(), 0.25 * min(h, w))
    peaks = _peaks(smooth, significant)
    # Annotation strokes (text, dimensions, door arcs, window lines) are at most MAX_THIN_PX wide at
    # working resolution; walls are at least MIN_WALL_PX. Thin strokes are found even when there are
    # few of them, so a sparse drawing cannot make interior walls look like annotation.
    thin_peaks = [t for t in range(1, MAX_THIN_PX + 1) if hist[t] > 0 and hist[t] >= hist[t - 1] and hist[t] >= hist[t + 1]]
    thin = max(thin_peaks, key=lambda t: hist[t]) if thin_peaks else None
    wall_peaks = [p for p in peaks if p >= MIN_WALL_PX]
    if not wall_peaks and not peaks:
        raise Unsupported("No consistent wall strokes were found.")
    if not wall_peaks:
        raise Unsupported(
            "No walls drawn as solid, thick lines were found. This happens when walls are drawn as two thin "
            "outlines or hatched, or when the image is not a 2D line drawing (for example a 3D rendering or a photo)."
        )
    dominant = max(wall_peaks, key=lambda p: smooth[p])
    wmin = wall_peaks[0]
    t_max = wall_peaks[-1]
    while t_max + 1 < cap and smooth[t_max + 1] >= 0.3 * smooth[wall_peaks[-1]]:
        t_max += 1
    k = max(3, (thin + wmin + 1) // 2 if thin else int(0.5 * wmin))
    return float(dominant), float(t_max), int(k), thin


# ---- band extraction ------------------------------------------------------------------------

def _bands(mask: np.ndarray, orientation: str, t_max: float) -> tuple[list[WallSegment], int]:
    """Connected bands of an oriented mask -> centreline segments. Also returns rejected blob area."""
    work = mask if orientation == "h" else mask.T  # treat both as horizontal
    n, labels, stats, _ = cv2.connectedComponentsWithStats(work, connectivity=8)
    segments: list[WallSegment] = []
    rejected = 0
    for i in range(1, n):
        x0, y0, bw, bh, area = (int(v) for v in stats[i])
        if bw <= bh:
            continue  # not elongated along this axis; the other orientation handles it
        sub = labels[y0 : y0 + bh, x0 : x0 + bw] == i
        counts = sub.sum(axis=0)
        cols = counts > 0
        thickness = float(np.median(counts[cols]))
        if thickness > 2.2 * t_max:
            rejected += area  # a filled block (legend, solid fill), not a wall
            continue
        rows = np.arange(bh, dtype=float)[:, None] + 0.5
        centers = (sub * rows).sum(axis=0)[cols] / counts[cols]
        center = y0 + float(np.median(centers))
        cv_thick = float(np.std(counts[cols]) / max(thickness, 1.0))
        consistency = max(0.0, min(1.0, 1.0 - 2.0 * cv_thick))
        segments.append(
            WallSegment(
                id="", orientation=orientation, center=center, start=float(x0), end=float(x0 + bw),  # type: ignore[arg-type]
                thickness=thickness, confidence=consistency,
            )
        )
    return segments, rejected


def _merge_collinear(segs: list[WallSegment], k: int, t_wall: float) -> tuple[list[WallSegment], list[tuple[int, float, float]]]:
    """Merge pieces on the same line. Returns merged walls and gaps as (wall index, start, end)."""
    segs = sorted(segs, key=lambda s: (s.center, s.start))
    lines: list[list[WallSegment]] = []
    for s in segs:
        for line in lines:
            ref = line[0]
            if abs(ref.center - s.center) <= max(2.0, 0.35 * max(ref.thickness, s.thickness)):
                line.append(s)
                break
        else:
            lines.append([s])

    merged: list[WallSegment] = []
    gaps: list[tuple[int, float, float]] = []
    max_gap = MAX_GAP_FACTOR * t_wall
    for line in lines:
        line.sort(key=lambda s: s.start)
        group = [line[0]]
        group_gaps: list[tuple[float, float]] = []

        def flush() -> None:
            total = sum(p.length for p in group)
            merged.append(
                replace(
                    group[0],
                    center=sum(p.center * p.length for p in group) / total,
                    start=min(p.start for p in group),
                    end=max(p.end for p in group),
                    thickness=sum(p.thickness * p.length for p in group) / total,
                    confidence=sum(p.confidence * p.length for p in group) / total,
                )
            )
            gaps.extend((len(merged) - 1, a, b) for a, b in group_gaps)

        for s in line[1:]:
            end = max(p.end for p in group)
            gap = s.start - end
            if gap <= max(2.0, 0.6 * k):
                group.append(s)  # overlap or a hairline break in the drawing
            elif gap <= max_gap:
                group.append(s)
                group_gaps.append((end, s.start))
            else:
                flush()
                group, group_gaps = [s], []
        flush()
    return merged, gaps


def _snap_junctions(walls: list[WallSegment]) -> tuple[list[WallSegment], list[list[bool]]]:
    """Move each wall end onto the centreline of the perpendicular wall it runs into.
    Returns the walls and, per wall, whether its [start, end] is connected."""
    out: list[WallSegment] = []
    connected: list[list[bool]] = []
    for w in walls:
        ends = [w.start, w.end]
        hits = [False, False]
        for which in (0, 1):
            e = ends[which]
            best: tuple[float, float] | None = None
            for p in walls:
                if p.orientation == w.orientation:
                    continue
                reach = p.thickness / 2 + 0.5 * w.thickness + 2
                if abs(p.center - e) > reach:
                    continue
                if not (p.start - w.thickness / 2 - 2 <= w.center <= p.end + w.thickness / 2 + 2):
                    continue
                d = abs(p.center - e)
                if best is None or d < best[0]:
                    best = (d, p.center)
            if best is not None:
                ends[which] = best[1]
                hits[which] = True
        connected.append(hits)
        start, end = min(ends), max(ends)
        out.append(replace(w, start=start, end=end))
    return out, connected


def _bridge_free_ends(
    walls: list[WallSegment], connected: list[list[bool]], max_gap: float, min_gap: float,
) -> tuple[list[WallSegment], list[list[bool]], list[tuple[int, float, float]]]:
    """A wall that stops short of a perpendicular wall usually ends at an opening next to the
    junction (the short stub beyond the door is too small to detect). Extend the wall to that
    perpendicular wall and record the space as a candidate opening."""
    out, gaps = list(walls), []
    ends = [list(c) for c in connected]
    for i, w in enumerate(walls):
        for which, sign in ((0, -1), (1, 1)):
            if ends[i][which]:
                continue
            e = w.start if which == 0 else w.end
            best: tuple[float, WallSegment] | None = None
            for p in walls:
                if p.orientation == w.orientation or not (p.start - p.thickness / 2 <= w.center <= p.end + p.thickness / 2):
                    continue
                face = p.center - sign * p.thickness / 2  # the face of p that this end looks at
                d = (face - e) * sign  # how far ahead of this end that face is
                if min_gap <= d <= max_gap and (best is None or d < best[0]):
                    best = (d, p)
            if best is None:
                continue
            p = best[1]
            face = p.center - sign * p.thickness / 2
            if which == 0:
                gaps.append((i, face, e))
                out[i] = replace(out[i], start=p.center)
            else:
                gaps.append((i, e, face))
                out[i] = replace(out[i], end=p.center)
            ends[i][which] = True
    return out, ends, gaps


def _split_gaps_at_junctions(walls: list[WallSegment], gaps: list[tuple[int, float, float]]) -> list[tuple[int, float, float]]:
    """A perpendicular wall that meets a wall inside one of its gaps divides that gap: an opening
    never contains a wall junction (e.g. two doors either side of a partition wall)."""
    out: list[tuple[int, float, float]] = []
    for i, a, b in gaps:
        w = walls[i]
        cuts = sorted(
            (p.center - p.thickness / 2, p.center + p.thickness / 2)
            for p in walls
            if p.orientation != w.orientation and a < p.center < b and p.end - p.start >= p.thickness
            and p.start - w.thickness / 2 - 2 <= w.center <= p.end + w.thickness / 2 + 2
        )
        pos = a
        for lo, hi in cuts:
            if lo > pos:
                out.append((i, pos, lo))
            pos = max(pos, hi)
        if b > pos:
            out.append((i, pos, b))
    return out


def detect_walls(pre: Preprocessed) -> WallDetection:
    ink = pre.ink
    t_wall, t_max, k, thin = estimate_thickness(ink)
    length = max(2 * k + 1, int(round(1.25 * t_max)) + 2)

    horizontal = open_rect(ink, length, k)
    vertical = open_rect(ink, k, length)
    wall_mask = cv2.bitwise_or(horizontal, vertical)

    h_segs, rej_h = _bands(horizontal, "h", t_max)
    v_segs, rej_v = _bands(vertical, "v", t_max)
    # Anything thick that no wall explains: diagonal/curved walls, filled symbols, bold text.
    thick = open_rect(ink, k, k)
    explained = cv2.dilate(wall_mask, np.ones((3, 3), np.uint8))
    thick_px = max(1, cv2.countNonZero(thick))
    unexplained = (cv2.countNonZero(cv2.bitwise_and(thick, cv2.bitwise_not(explained))) + rej_h + rej_v) / thick_px

    if not h_segs and not v_segs:
        raise Unsupported("No straight horizontal or vertical walls were found.")
    if unexplained > MAX_UNEXPLAINED:
        raise Unsupported(
            "Most of the thick line work is not horizontal/vertical walls (diagonal or curved walls, a rotated "
            "scan, or heavy fills). Only axis-aligned walls are supported."
        )

    merged_h, gaps_h = _merge_collinear(h_segs, k, t_wall)
    merged_v, gaps_v = _merge_collinear(v_segs, k, t_wall)
    all_walls = merged_h + merged_v
    gap_refs = [(i, a, b) for i, a, b in gaps_h] + [(i + len(merged_h), a, b) for i, a, b in gaps_v]

    snapped, connected = _snap_junctions(all_walls)
    # Only walls anchored at one end are bridged: a free-floating mark never grows into a wall.
    anchored = [i for i, c in enumerate(connected) if any(c)]
    bridged, bridged_ends, end_gaps = _bridge_free_ends(
        [snapped[i] for i in anchored], [connected[i] for i in anchored], MAX_GAP_FACTOR * t_wall, max(2 * k, 0.8 * t_wall)
    )
    for j, i in enumerate(anchored):
        snapped[i], connected[i] = bridged[j], bridged_ends[j]
    gap_refs += [(anchored[j], a, b) for j, a, b in end_gaps]
    gap_refs = _split_gaps_at_junctions(snapped, gap_refs)

    # Deterministic ids in reading order: horizontal walls top to bottom, then vertical left to right.
    order = sorted(range(len(snapped)), key=lambda i: (snapped[i].orientation != "h", round(snapped[i].center, 3), snapped[i].start))
    final: list[WallSegment] = []
    new_index: dict[int, int] = {}
    warnings: list[str] = []
    dropped = 0
    for i in order:
        w = snapped[i]
        ends = sum(connected[i]) / 2
        confidence = round(0.4 + 0.35 * ends + 0.25 * w.confidence, 3)
        if not any(connected[i]) and w.length < 4 * w.thickness:
            dropped += 1  # a short free-standing thick mark: likely a symbol or bold text
            continue
        new_index[i] = len(final)
        final.append(replace(w, id=f"w{len(final)}", confidence=confidence))
    if dropped:
        warnings.append(f"{dropped} short isolated thick mark{'s' if dropped > 1 else ''} ignored (not connected to any wall).")

    gaps = tuple(
        Gap(wall_id=final[new_index[i]].id, orientation=final[new_index[i]].orientation, center=final[new_index[i]].center,
            start=a, end=b, thickness=final[new_index[i]].thickness)
        for i, a, b in sorted(gap_refs, key=lambda g: (g[0], g[1]))
        if i in new_index
    )
    if unexplained > 0.2:
        warnings.append(
            f"About {round(unexplained * 100)}% of the thick line work was not recognised as straight walls "
            "(diagonal or curved walls, symbols or fills). Check the result against the plan."
        )
    return WallDetection(
        thickness_px=t_wall, min_thickness_px=k, walls=tuple(final), gaps=gaps, wall_mask=wall_mask,
        unexplained_ratio=float(unexplained), warnings=tuple(warnings), thin_px=thin,
    )
