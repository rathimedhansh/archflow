"""Compare a detected FloorPlan with a ground-truth FloorPlan.

Geometry is compared in *source-image pixels* (each plan's metres divided by its own
metres-per-pixel), so a wrong scale estimate does not distort the wall/room/opening scores;
scale accuracy is measured separately.

* Walls: length-based. A point on a truth wall is "found" if a detected wall runs parallel
  (within 10°) within half the truth wall's thickness + 2 px. Recall = found truth length /
  truth length; precision = detected length near a truth wall / detected length. A truth
  wall counts as detected when at least 80% of its length is found.
* Rooms: polygon IoU (rasterised), one-to-one greedy matching, match if IoU >= 0.7.
* Doors / windows: opening centre points, one-to-one greedy matching of the same kind within
  max(half the truth width, 0.3 m); width error reported for matches.
* Scale: relative error of metres-per-pixel.
"""

import math
from dataclasses import asdict, dataclass

import cv2
import numpy as np

from app.schema import FloorPlan, Wall

PARALLEL_DEG = 10.0
ROOM_IOU = 0.7
WALL_FOUND_SHARE = 0.8


@dataclass
class PR:
    truth: int
    detected: int
    matched: int  # truth elements found
    # Detected elements that are correct. Equals `matched` for one-to-one matching; differs for
    # walls, where one detected wall may cover two collinear truth walls (or the reverse).
    correct: int | None = None

    @property
    def precision(self) -> float | None:
        good = self.matched if self.correct is None else self.correct
        return good / self.detected if self.detected else None

    @property
    def recall(self) -> float | None:
        return self.matched / self.truth if self.truth else None


@dataclass
class PlanScores:
    wall_length_recall: float | None
    wall_length_precision: float | None
    walls: PR
    rooms: PR
    room_mean_iou: float | None
    doors: PR
    door_width_error: float | None
    windows: PR
    window_width_error: float | None
    scale_rel_error: float | None

    def as_dict(self) -> dict:
        d = asdict(self)
        for k in ("walls", "rooms", "doors", "windows"):
            pr: PR = getattr(self, k)
            d[k].update(precision=pr.precision, recall=pr.recall)
        return d


def _px(p: tuple[float, float], mpp: float) -> np.ndarray:
    return np.array(p, float) / mpp


def _segments(plan: FloorPlan) -> list[tuple[np.ndarray, np.ndarray, float]]:
    mpp = plan.scale.meters_per_pixel
    return [(_px(w.start, mpp), _px(w.end, mpp), w.thickness / mpp) for w in plan.walls]


def _point_seg_dist(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    ab = b - a
    denom = float(ab @ ab)
    t = 0.0 if denom == 0 else max(0.0, min(1.0, float((p - a) @ ab) / denom))
    return float(np.linalg.norm(p - (a + t * ab)))


def _angle(a: np.ndarray, b: np.ndarray) -> float:
    d = b - a
    return math.degrees(math.atan2(d[1], d[0])) % 180


def _parallel(a1: float, a2: float) -> bool:
    diff = abs(a1 - a2) % 180
    return min(diff, 180 - diff) <= PARALLEL_DEG


def _covered(src: list, dst: list, tol_from: str) -> tuple[float, float, list[float]]:
    """(covered length, total length, per-segment covered share) of `src` by `dst`."""
    covered = total = 0.0
    shares = []
    for a, b, t in src:
        length = float(np.linalg.norm(b - a))
        n = max(2, int(length / 2))
        ang = _angle(a, b)
        hits = 0
        for i in range(n):
            p = a + (b - a) * ((i + 0.5) / n)
            for c, d, t2 in dst:
                tol = (t if tol_from == "src" else t2) / 2 + 2
                if _parallel(ang, _angle(c, d)) and _point_seg_dist(p, c, d) <= tol:
                    hits += 1
                    break
        covered += length * hits / n
        total += length
        shares.append(hits / n)
    return covered, total, shares


def _room_mask(poly: list[tuple[float, float]], mpp: float, shape: tuple[int, int]) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    pts = np.round(np.array(poly, float) / mpp * 4).astype(np.int32)  # quarter-pixel precision
    cv2.fillPoly(m, [pts], 1, shift=2)
    return m.astype(bool)


def _opening_centres(plan: FloorPlan, kind: str) -> list[tuple[np.ndarray, float]]:
    mpp = plan.scale.meters_per_pixel
    walls: dict[str, Wall] = {w.id: w for w in plan.walls}
    out = []
    for o in (plan.doors if kind == "door" else plan.windows):
        w = walls[o.wall_id]
        a, b = np.array(w.start, float), np.array(w.end, float)
        u = (b - a) / max(1e-9, float(np.linalg.norm(b - a)))
        out.append(((a + u * (o.offset + o.width / 2)) / mpp, o.width / mpp))
    return out


def _match_points(truth: list, det: list, tol_min_px: float) -> tuple[int, list[float]]:
    pairs = []
    for i, (pt, wt) in enumerate(truth):
        for j, (pd, wd) in enumerate(det):
            d = float(np.linalg.norm(pt - pd))
            if d <= max(wt / 2, tol_min_px):
                pairs.append((d, i, j))
    pairs.sort()
    used_t, used_d, errors = set(), set(), []
    for d, i, j in pairs:
        if i in used_t or j in used_d:
            continue
        used_t.add(i)
        used_d.add(j)
        errors.append(abs(det[j][1] - truth[i][1]) / truth[i][1])
    return len(used_t), errors


def score(truth: FloorPlan, detected: FloorPlan) -> PlanScores:
    ts, ds = _segments(truth), _segments(detected)
    t_cov, t_total, shares = _covered(ts, ds, "src")
    d_cov, d_total, d_shares = _covered(ds, ts, "dst")
    walls = PR(truth=len(ts), detected=len(ds), matched=sum(1 for s in shares if s >= WALL_FOUND_SHARE),
               correct=sum(1 for s in d_shares if s >= WALL_FOUND_SHARE))

    shape = (truth.source.height_px, truth.source.width_px)
    t_masks = [_room_mask(r.polygon, truth.scale.meters_per_pixel, shape) for r in truth.rooms]
    d_masks = [_room_mask(r.polygon, detected.scale.meters_per_pixel, shape) for r in detected.rooms]
    pairs = []
    for i, tm in enumerate(t_masks):
        for j, dm in enumerate(d_masks):
            inter = np.logical_and(tm, dm).sum()
            if inter:
                pairs.append((inter / np.logical_or(tm, dm).sum(), i, j))
    pairs.sort(reverse=True)
    used_t, used_d, ious = set(), set(), []
    for iou, i, j in pairs:
        if iou < ROOM_IOU or i in used_t or j in used_d:
            continue
        used_t.add(i)
        used_d.add(j)
        ious.append(float(iou))
    rooms = PR(truth=len(t_masks), detected=len(d_masks), matched=len(ious))

    tol_px = 0.3 / truth.scale.meters_per_pixel
    td, dd = _opening_centres(truth, "door"), _opening_centres(detected, "door")
    tw, dw = _opening_centres(truth, "window"), _opening_centres(detected, "window")
    door_m, door_err = _match_points(td, dd, tol_px)
    win_m, win_err = _match_points(tw, dw, tol_px)

    return PlanScores(
        wall_length_recall=t_cov / t_total if t_total else None,
        wall_length_precision=d_cov / d_total if d_total else None,
        walls=walls,
        rooms=rooms,
        room_mean_iou=float(np.mean(ious)) if ious else None,
        doors=PR(len(td), len(dd), door_m),
        door_width_error=float(np.mean(door_err)) if door_err else None,
        windows=PR(len(tw), len(dw), win_m),
        window_width_error=float(np.mean(win_err)) if win_err else None,
        scale_rel_error=abs(detected.scale.meters_per_pixel - truth.scale.meters_per_pixel) / truth.scale.meters_per_pixel,
    )
