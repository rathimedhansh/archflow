"""Synthetic floor plans with exact ground truth.

Each plan is a random rectilinear layout (binary space partitioning of a rectangle into
rooms), drawn in a configurable style and returned together with the FloorPlan it was drawn
from. This code shares nothing with the detector: it draws what an architect's drawing
looks like and records what the drawing means.

Limits (be honest when reading results): these are synthetic drawings in a clean CAD-like
style. They are representative of the *supported* input definition, not of the variety of
real-world plans.
"""

from dataclasses import dataclass, field

import cv2
import numpy as np

from app.schema import Door, FloorPlan, Room, Scale, SourceImage, Wall, Window

ROOM_NAMES = ["LIVING", "KITCHEN", "BED 1", "BED 2", "BATH", "DINING", "STUDY", "HALL", "WC", "STORE"]


@dataclass(frozen=True)
class Style:
    ppm: float = 80.0  # pixels per metre
    ext_t: float = 0.25  # exterior wall thickness, m
    int_t: float = 0.12  # interior wall thickness, m
    thin_px: int = 1  # annotation line width
    window_lines: int = 2
    door_symbol: str = "arc"  # "arc" | "none"
    corner_doors: float = 0.0  # share of interior doors placed right next to a wall junction (5-10 cm stub)
    wall_style: str = "solid"  # "solid" | "hollow"
    text: bool = True
    dimensions: bool = True
    furniture: bool = False
    frame: bool = False  # title-block border around the sheet
    diagonal: bool = False  # chamfered corner (a 45° wall)
    noise: float = 0.0  # gaussian noise sigma, grey levels
    blur: float = 0.0  # gaussian blur sigma, px
    jpeg: int | None = None  # re-encode quality
    rotate_deg: float = 0.0


@dataclass
class SynthPlan:
    name: str
    image: np.ndarray  # grayscale uint8
    truth: FloorPlan
    style: Style
    notes: list[str] = field(default_factory=list)


def _q(v: float) -> float:
    return round(v * 20) / 20  # 5 cm grid, like a real drawing


def _layout(rng: np.random.Generator) -> tuple[float, float, list[tuple[float, float, float, float]], list[tuple[str, float, float, float]]]:
    """Building size, room rectangles (x0, y0, x1, y1) and partition walls (orientation, center, a, b)."""
    width, depth = _q(rng.uniform(8, 15)), _q(rng.uniform(6, 11))
    rects = [(0.0, 0.0, width, depth)]
    partitions: list[tuple[str, float, float, float]] = []
    target = int(rng.integers(3, 8))
    min_room = 2.4
    while len(rects) < target:
        rects.sort(key=lambda r: -(r[2] - r[0]) * (r[3] - r[1]))
        for i, (x0, y0, x1, y1) in enumerate(rects):
            w, h = x1 - x0, y1 - y0
            if max(w, h) >= 2 * min_room:
                break
        else:
            break
        rects.pop(i)
        if w >= h:
            cut = _q(rng.uniform(x0 + min_room, x1 - min_room))
            rects += [(x0, y0, cut, y1), (cut, y0, x1, y1)]
            partitions.append(("v", cut, y0, y1))
        else:
            cut = _q(rng.uniform(y0 + min_room, y1 - min_room))
            rects += [(x0, y0, x1, cut), (x0, cut, x1, y1)]
            partitions.append(("h", cut, x0, x1))
    return width, depth, rects, partitions


def generate(seed: int, style: Style = Style(), name: str | None = None) -> SynthPlan:
    rng = np.random.default_rng(seed)
    width, depth, rects, partitions = _layout(rng)
    ppm = style.ppm
    margin = 2.5  # metres around the building (dimension lines live here)
    ox = oy = margin
    img_w, img_h = int(round((width + 2 * margin) * ppm)), int(round((depth + 2 * margin) * ppm))
    img = np.full((img_h, img_w), 255, np.uint8)

    def P(x: float, y: float) -> tuple[int, int]:  # metres (building coords) -> pixel
        return int(round((x + ox) * ppm)), int(round((y + oy) * ppm))

    # ---- ground-truth walls (centrelines, metres in image coordinates) ----
    walls: list[tuple[str, str, float, float, float, float]] = []  # id, orientation, center, a, b, thickness
    ext = [("h", 0.0, 0.0, width), ("h", depth, 0.0, width), ("v", 0.0, 0.0, depth), ("v", width, 0.0, depth)]
    for o, c, a, b in ext:
        walls.append((f"wall-{len(walls) + 1}", o, c, a, b, style.ext_t))
    for o, c, a, b in partitions:
        walls.append((f"wall-{len(walls) + 1}", o, c, a, b, style.int_t))

    # ---- openings: one door per partition, an entrance, windows on exterior walls ----
    def perpendicular_hits(o: str, c: float) -> list[float]:
        """Positions along a wall where perpendicular walls meet it."""
        return [cc for (_, oo, cc, aa, bb, _) in walls if oo != o and aa - 1e-6 <= c <= bb + 1e-6]

    openings: list[tuple[str, str, float, float]] = []  # kind, wall id, offset, width

    def place(wall_idx: int, kind: str, width_m: float, lo: float | None = None, hi: float | None = None) -> bool:
        wid, o, c, a, b, t = walls[wall_idx]
        blocked = [(h - 0.45, h + 0.45) for h in perpendicular_hits(o, c)]
        blocked += [(a + off - 0.4, a + off + w + 0.4) for k, wi, off, w in openings if wi == wid]
        lo = a + 0.5 if lo is None else lo
        hi = b - 0.5 if hi is None else hi
        for _ in range(40):
            start = _q(rng.uniform(lo, hi - width_m)) if hi - width_m > lo else None
            if start is None:
                return False
            if all(start + width_m <= s or start >= e for s, e in blocked):
                openings.append((kind, wid, round(start - a, 4), width_m))
                return True
        return False

    def place_at_corner(wall_idx: int, width_m: float) -> bool:
        """A door starting (or ending) just past the face of a perpendicular wall, as in many real plans."""
        wid, o, c, a, b, t = walls[wall_idx]
        junctions = [(cc, tt) for (_, oo, cc, aa, bb, tt) in walls if oo != o and aa - 1e-6 <= c <= bb + 1e-6 and a - 1e-6 <= cc <= b + 1e-6]
        cc, tt = junctions[int(rng.integers(len(junctions)))]
        stub = float(rng.choice([0.05, 0.1]))
        clear = lambda s: all(s + width_m <= c2 - t2 / 2 - 0.05 or s >= c2 + t2 / 2 + 0.05 for c2, t2 in junctions)  # noqa: E731
        starts = [s for s in (cc + tt / 2 + stub, cc - tt / 2 - stub - width_m) if a <= s and s + width_m <= b and clear(s)]
        if not starts:
            return False
        start = starts[int(rng.integers(len(starts)))]
        if any(not (start + width_m + 0.4 <= a + off or start >= a + off + w + 0.4) for k, wi, off, w in openings if wi == wid):
            return False
        openings.append(("door", wid, round(start - a, 4), width_m))
        return True

    for i in range(4, len(walls)):
        width_m = _q(rng.uniform(0.8, 0.9))
        if not (style.corner_doors and rng.random() < style.corner_doors and place_at_corner(i, width_m)):
            place(i, "door", width_m)
    place(1, "door", _q(rng.uniform(0.9, 1.0)))  # entrance on the bottom wall
    for i in range(4):
        _, o, c, a, b, _ = walls[i]
        hits = sorted(set(perpendicular_hits(o, c)))
        for lo, hi in zip(hits, hits[1:]):
            if hi - lo > 2.2 and rng.random() < 0.85:
                w = _q(min(rng.uniform(0.9, 1.8), hi - lo - 1.2))
                place(i, "window", w, lo + 0.45, hi - 0.45)

    # ---- draw walls ----
    wall_by_id = {w[0]: w for w in walls}
    for wid, o, c, a, b, t in walls:
        if o == "h":
            p0, p1 = P(a - t / 2, c - t / 2), P(b + t / 2, c + t / 2)
        else:
            p0, p1 = P(c - t / 2, a - t / 2), P(c + t / 2, b + t / 2)
        if style.wall_style == "hollow":
            cv2.rectangle(img, p0, (p1[0] - 1, p1[1] - 1), 0, style.thin_px)
        else:
            cv2.rectangle(img, p0, (p1[0] - 1, p1[1] - 1), 0, -1)
    if style.wall_style == "hollow":  # clean the insides of junctions so outlines read as double lines
        for wid, o, c, a, b, t in walls:
            inset = t / 2 - style.thin_px / ppm * 1.5
            if o == "h":
                q0, q1 = P(a + 0.02, c - inset), P(b - 0.02, c + inset)
            else:
                q0, q1 = P(c - inset, a + 0.02), P(c + inset, b - 0.02)
            cv2.rectangle(img, q0, (q1[0] - 1, q1[1] - 1), 255, -1)

    # ---- draw openings ----
    thin = style.thin_px
    for kind, wid, off, w in openings:
        _, o, c, a, b, t = wall_by_id[wid]
        s0, s1 = a + off, a + off + w
        clear = t / 2 + 1.5 / ppm
        if o == "h":
            cv2.rectangle(img, P(s0, c - clear), P(s1, c + clear), 255, -1)
        else:
            cv2.rectangle(img, P(c - clear, s0), P(c + clear, s1), 255, -1)
        if kind == "window":
            n = style.window_lines
            for j in range(n):
                f = -t / 2 + t * (j + 0.5) / n if n > 1 else 0.0
                if o == "h":
                    cv2.line(img, P(s0, c + f), P(s1, c + f), 0, thin)
                else:
                    cv2.line(img, P(c + f, s0), P(c + f, s1), 0, thin)
            for s in (s0, s1):  # end caps
                if o == "h":
                    cv2.line(img, P(s, c - t / 2), P(s, c + t / 2), 0, thin)
                else:
                    cv2.line(img, P(c - t / 2, s), P(c + t / 2, s), 0, thin)
        elif style.door_symbol == "arc":
            hinge_start = rng.random() < 0.5
            side = 1 if rng.random() < 0.5 else -1
            face = c + side * t / 2
            hinge = s0 if hinge_start else s1
            if o == "h":
                hx, hy = P(hinge, face)
                tip = P(hinge, face + side * w)
                cv2.line(img, (hx, hy), tip, 0, thin, cv2.LINE_AA)
                r = int(round(w * ppm))
                # OpenCV angles run clockwise from +x (y points down): arc between closed and open leaf.
                a0 = 0 if (hinge_start and side == 1) else 270 if hinge_start else 90 if side == 1 else 180
                cv2.ellipse(img, (hx, hy), (r, r), 0, a0, a0 + 90, 0, thin, cv2.LINE_AA)
            else:
                hx, hy = P(face, hinge)
                tip = P(face + side * w, hinge)
                cv2.line(img, (hx, hy), tip, 0, thin, cv2.LINE_AA)
                r = int(round(w * ppm))
                a0 = 0 if (hinge_start and side == 1) else 90 if (hinge_start and side == -1) else 270 if side == 1 else 180
                cv2.ellipse(img, (hx, hy), (r, r), 0, a0, a0 + 90, 0, thin, cv2.LINE_AA)

    # ---- annotation clutter ----
    font = cv2.FONT_HERSHEY_SIMPLEX
    fs = ppm / 160
    rooms_truth: list[Room] = []
    order = sorted(rects, key=lambda r: (r[1], r[0]))
    for i, (x0, y0, x1, y1) in enumerate(order):
        rooms_truth.append(Room(id=f"room-{i + 1}", name=ROOM_NAMES[i % len(ROOM_NAMES)],
                                polygon=[(x0 + ox, y0 + oy), (x1 + ox, y0 + oy), (x1 + ox, y1 + oy), (x0 + ox, y1 + oy)]))
        if style.text:
            cx, cy = P((x0 + x1) / 2, (y0 + y1) / 2)
            label = ROOM_NAMES[i % len(ROOM_NAMES)]
            (tw, th), _ = cv2.getTextSize(label, font, fs, max(1, thin))
            cv2.putText(img, label, (cx - tw // 2, cy), font, fs, 0, max(1, thin), cv2.LINE_AA)
            area = f"{(x1 - x0) * (y1 - y0):.1f} m2"
            (aw, _), _ = cv2.getTextSize(area, font, fs * 0.7, 1)
            cv2.putText(img, area, (cx - aw // 2, cy + int(th * 1.6)), font, fs * 0.7, 0, 1, cv2.LINE_AA)
        if style.furniture:
            fx0, fy0 = x0 + 0.5, y0 + 0.5
            if x1 - x0 > 3 and y1 - y0 > 3:
                cv2.rectangle(img, P(fx0, fy0), P(fx0 + 1.4, fy0 + 1.9), 0, thin)  # bed / table
                cv2.circle(img, P(x1 - 0.9, y1 - 0.9), int(0.35 * ppm), 0, thin)

    if style.dimensions:
        y = -1.2
        cv2.line(img, P(0, y), P(width, y), 0, thin)
        for x in (0.0, width):
            cv2.line(img, P(x, y - 0.2), P(x, y + 0.2), 0, thin)
        label = f"{width:.2f}"
        cv2.putText(img, label, (P(width / 2, y - 0.15)[0] - 20, P(0, y - 0.15)[1]), font, fs, 0, 1, cv2.LINE_AA)
        x = -1.2
        cv2.line(img, P(x, 0), P(x, depth), 0, thin)
        for yy in (0.0, depth):
            cv2.line(img, P(x - 0.2, yy), P(x + 0.2, yy), 0, thin)

    if style.frame:
        cv2.rectangle(img, (int(0.3 * ppm), int(0.3 * ppm)), (img_w - int(0.3 * ppm), img_h - int(0.3 * ppm)), 0, max(2, int(0.06 * ppm)))

    notes: list[str] = []
    truth_walls = [
        Wall(id=wid, start=((a + ox, c + oy) if o == "h" else (c + ox, a + oy)),
             end=((b + ox, c + oy) if o == "h" else (c + ox, b + oy)), height=2.8, thickness=t)
        for wid, o, c, a, b, t in walls
    ]
    if style.diagonal:
        # Chamfer the top-right corner with a 45° wall of 2.5 m legs.
        leg = 2.5
        cv2.rectangle(img, P(width - leg, -style.ext_t), P(width + style.ext_t, leg), 255, -1)
        pts = np.array([P(width - leg, 0), P(width, leg)], np.int32)
        cv2.line(img, tuple(pts[0]), tuple(pts[1]), 0, max(2, int(round(style.ext_t * ppm))))
        notes.append("top-right corner chamfered with a diagonal wall (not in the truth walls; partition geometry near it is approximate)")
        tw = truth_walls[0]
        truth_walls[0] = tw.model_copy(update={"end": (width - leg + ox, oy)})
        rw = truth_walls[3]
        truth_walls[3] = rw.model_copy(update={"start": (width + ox, leg + oy)})
        truth_walls.append(Wall(id=f"wall-{len(truth_walls) + 1}", start=(width - leg + ox, oy), end=(width + ox, leg + oy), height=2.8, thickness=style.ext_t))
        openings = [op for op in openings if op[1] not in ("wall-1", "wall-4")]

    truth_doors = [Door(id=f"door-{i + 1}", wall_id=wid, offset=off, width=w, height=2.1)
                   for i, (k, wid, off, w) in enumerate([o for o in openings if o[0] == "door"])]
    truth_windows = [Window(id=f"window-{i + 1}", wall_id=wid, offset=off, width=w, height=1.2, sill=0.9)
                     for i, (k, wid, off, w) in enumerate([o for o in openings if o[0] == "window"])]

    # ---- degradations ----
    if style.rotate_deg:
        m = cv2.getRotationMatrix2D((img_w / 2, img_h / 2), style.rotate_deg, 1.0)
        img = cv2.warpAffine(img, m, (img_w, img_h), flags=cv2.INTER_LINEAR, borderValue=255)
        notes.append(f"image rotated {style.rotate_deg}° (truth coordinates rotated to match)")

        def rot(p: tuple[float, float]) -> tuple[float, float]:
            x, y = p[0] * ppm, p[1] * ppm
            return ((m[0, 0] * x + m[0, 1] * y + m[0, 2]) / ppm, (m[1, 0] * x + m[1, 1] * y + m[1, 2]) / ppm)

        truth_walls = [w.model_copy(update={"start": rot(w.start), "end": rot(w.end)}) for w in truth_walls]
        rooms_truth = [r.model_copy(update={"polygon": [rot(p) for p in r.polygon]}) for r in rooms_truth]
    if style.blur:
        img = cv2.GaussianBlur(img, (0, 0), style.blur)
    if style.noise:
        noise = np.random.default_rng(seed + 1000).normal(0, style.noise, img.shape)
        img = np.clip(img.astype(float) + noise, 0, 255).astype(np.uint8)
    if style.jpeg:
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, style.jpeg])
        img = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)

    truth = FloorPlan(
        provenance="manual",
        source=SourceImage(floorplan_id=f"synth-{seed}", width_px=img_w, height_px=img_h),
        scale=Scale(meters_per_pixel=1 / ppm, calibrated=True),
        walls=truth_walls,
        rooms=rooms_truth if not style.diagonal else [r for r in rooms_truth if max(x for x, _ in r.polygon) < width + ox - 2.6 or min(y for _, y in r.polygon) > oy + 2.6],
        doors=truth_doors,
        windows=truth_windows,
    )
    return SynthPlan(name=name or f"synth-{seed}", image=img, truth=truth, style=style, notes=notes)
