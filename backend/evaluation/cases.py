"""The evaluation set: which plans are measured, and what their ground truth is."""

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.schema import Door, FloorPlan, Room, Scale, SourceImage, Wall, Window
from evaluation.synth import Style, generate


@dataclass
class Case:
    name: str
    group: str  # "supported" | "out-of-scope" | "hand-drawn" | "real"
    description: str
    image: np.ndarray
    truth: FloorPlan
    scale_known: bool = True
    notes: list[str] = field(default_factory=list)


def supported_style(seed: int) -> Style:
    """Random variation *inside* the supported definition (see docs/SUPPORTED_FLOOR_PLANS.md)."""
    rng = np.random.default_rng(10_000 + seed)
    return Style(
        ppm=float(rng.uniform(55, 110)),
        ext_t=float(rng.choice([0.2, 0.25, 0.3])),
        int_t=float(rng.choice([0.1, 0.12, 0.15])),
        thin_px=int(rng.choice([1, 2])),
        window_lines=int(rng.choice([2, 3])),
        text=bool(rng.random() < 0.9),
        dimensions=bool(rng.random() < 0.7),
        furniture=bool(rng.random() < 0.5),
        noise=float(rng.choice([0.0, 0.0, 4.0, 8.0])),
        blur=float(rng.choice([0.0, 0.0, 0.6])),
        jpeg=int(rng.choice([0, 0, 85, 70])) or None,
        corner_doors=float(rng.choice([0.0, 0.6])),
    )


OUT_OF_SCOPE: list[tuple[str, str, Style]] = [
    ("hollow-walls", "Walls drawn as two thin outlines instead of solid strokes", Style(wall_style="hollow")),
    ("plain-openings", "Doors drawn as plain gaps, without a swing arc", Style(door_symbol="none")),
    ("rotated-3deg", "Scan rotated by 3 degrees", Style(rotate_deg=3.0)),
    ("low-resolution", "28 px per metre: interior walls under 4 px", Style(ppm=28)),
    ("heavy-degradation", "Strong blur, noise and JPEG artefacts", Style(blur=1.6, noise=22, jpeg=20)),
    ("diagonal-wall", "One 45-degree wall (chamfered corner)", Style(diagonal=True)),
    ("drawing-frame", "A thick title-block frame around the sheet", Style(frame=True)),
]


def _hand_sample(path: str) -> Case | None:
    """The plain 4-room drawing used since Milestone 2, with ground truth traced by hand.

    Line centres measured on the image (pixel-edge coordinates): exterior walls 12 px thick,
    interior 8 px. The drawing has no doors, windows or scale, so scale error is not measured.
    """
    import cv2

    image = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        return None
    mpp = 0.01
    xs, ys = (106, 601, 851, 1095), (106, 451, 695)

    def p(x: float, y: float) -> tuple[float, float]:
        return (x * mpp, y * mpp)

    def wall(i: int, a: tuple[float, float], b: tuple[float, float], t: float) -> Wall:
        return Wall(id=f"wall-{i}", start=p(*a), end=p(*b), thickness=t * mpp)

    walls = [
        wall(1, (xs[0], ys[0]), (xs[3], ys[0]), 12), wall(2, (xs[0], ys[2]), (xs[3], ys[2]), 12),
        wall(3, (xs[0], ys[0]), (xs[0], ys[2]), 12), wall(4, (xs[3], ys[0]), (xs[3], ys[2]), 12),
        wall(5, (xs[0], ys[1]), (xs[3], ys[1]), 8), wall(6, (xs[1], ys[0]), (xs[1], ys[1]), 8),
        wall(7, (xs[2], ys[1]), (xs[2], ys[2]), 8),
    ]
    rect = lambda x0, y0, x1, y1: [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]  # noqa: E731
    rooms = [
        Room(id="room-1", name="A", polygon=rect(xs[0], ys[0], xs[1], ys[1])),
        Room(id="room-2", name="B", polygon=rect(xs[1], ys[0], xs[3], ys[1])),
        Room(id="room-3", name="C", polygon=rect(xs[0], ys[1], xs[2], ys[2])),
        Room(id="room-4", name="D", polygon=rect(xs[2], ys[1], xs[3], ys[2])),
    ]
    truth = FloorPlan(
        source=SourceImage(floorplan_id="hand", width_px=image.shape[1], height_px=image.shape[0]),
        scale=Scale(meters_per_pixel=mpp, calibrated=True), walls=walls, rooms=rooms,
    )
    return Case("m2-sample", "hand-drawn", "The plain 4-room test drawing from Milestone 2 (hand-authored truth)",
                image, truth, scale_known=False)


REAL_DIR = Path(__file__).parent / "real"


def _px_plan(image: np.ndarray, mpp: float, walls_px: list, rooms_px: list, doors_px: list, windows_px: list) -> FloorPlan:
    """Ground truth written in image pixels (easy to check against the picture) -> FloorPlan in metres."""
    m = lambda p: (p[0] * mpp, p[1] * mpp)  # noqa: E731
    walls = [Wall(id=f"wall-{i + 1}", start=m(a), end=m(b), thickness=t * mpp) for i, (a, b, t) in enumerate(walls_px)]
    rooms = [Room(id=f"room-{i + 1}", name=n, polygon=[m(p) for p in poly]) for i, (n, poly) in enumerate(rooms_px)]
    doors = [Door(id=f"door-{i + 1}", wall_id=f"wall-{w}", offset=o * mpp, width=wd * mpp) for i, (w, o, wd) in enumerate(doors_px)]
    windows = [Window(id=f"window-{i + 1}", wall_id=f"wall-{w}", offset=o * mpp, width=wd * mpp)
               for i, (w, o, wd) in enumerate(windows_px)]
    return FloorPlan(source=SourceImage(floorplan_id="real", width_px=image.shape[1], height_px=image.shape[0]),
                     scale=Scale(meters_per_pixel=mpp, calibrated=True), walls=walls, rooms=rooms, doors=doors, windows=windows)


def _real_apartment() -> Case | None:
    """A real marketing-style apartment plan (638×480), traced by hand.

    Wall centrelines and opening extents were measured on the pixel grid (zoomed crops). The
    balcony is bounded by a thin railing, not walls, so it is not a room here. The hallway is
    open to the living room; its boundary is the line joining the bathroom and bedroom walls.
    Scale: the written dimensions (18'3", 17'9", 12'3", 6'2") give 0.0193-0.0199 m/px; 0.0196 is used.
    """
    import cv2

    path = REAL_DIR / "apartment-1.png"
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE) if path.is_file() else None
    if image is None:
        return None
    walls = [
        ((141.5, 65), (515.5, 65), 5),  # 1 top
        ((515.5, 148.5), (604, 148.5), 5.5),  # 2 hallway top
        ((423, 209), (515.5, 209), 5),  # 3 bathroom bottom
        ((416, 276), (604, 276), 5),  # 4 bedroom top
        ((141.5, 419), (604, 419), 5),  # 5 bottom
        ((141.5, 65), (141.5, 419), 4),  # 6 left (balcony side)
        ((423, 65), (423, 209), 11),  # 7 kitchen / bathroom
        ((515.5, 65), (515.5, 209), 5.5),  # 8 bathroom right
        ((604, 148.5), (604, 419), 5),  # 9 right
        ((416, 276), (416, 419), 5),  # 10 bedroom left
    ]
    rooms = [
        ("Living Room and Kitchen", [(141.5, 65), (423, 65), (423, 276), (416, 276), (416, 419), (141.5, 419)]),
        ("Bathroom", [(423, 65), (515.5, 65), (515.5, 209), (423, 209)]),
        ("Hallway", [(515.5, 148.5), (604, 148.5), (604, 276), (423, 276), (423, 209), (515.5, 209)]),
        ("Bedroom", [(416, 276), (604, 276), (604, 419), (416, 419)]),
    ]
    doors = [(3, 42, 43), (4, 12, 42), (9, 73.5, 47), (6, 147, 101)]  # (wall, offset px, width px); last = bifold
    windows = [(6, 24, 81), (6, 258, 81), (5, 40.5, 83), (5, 165.5, 82), (9, 53.5, 20), (9, 162.5, 84)]
    truth = _px_plan(image, 0.0196, walls, rooms, doors, windows)
    return Case("real-apartment", "real", "Real 638×480 apartment plan: thin walls, furniture, feet/inch dimensions, "
                "bifold balcony door (hand-traced truth)", image, truth,
                notes=["balcony (railing, no walls) is not a truth room", "bifold door is not a supported door symbol"])


def _real_render() -> Case | None:
    import cv2

    path = REAL_DIR / "render-3d.png"
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE) if path.is_file() else None
    if image is None:
        return None
    truth = FloorPlan(source=SourceImage(floorplan_id="real", width_px=image.shape[1], height_px=image.shape[0]),
                      scale=Scale(meters_per_pixel=0.01, calibrated=True))
    return Case("real-3d-render", "real", "A 3D rendering of a house, not a floor plan (correct result: rejected)",
                image, truth, scale_known=False)


def build_cases(n_supported: int = 30, hand_sample_path: str | None = None) -> list[Case]:
    cases: list[Case] = []
    for seed in range(1, n_supported + 1):
        style = supported_style(seed)
        sp = generate(seed, style)
        desc = (f"{style.ppm:.0f} px/m, walls {style.ext_t}/{style.int_t} m, {style.window_lines}-line windows"
                + (", furniture" if style.furniture else "") + (f", noise {style.noise:g}" if style.noise else "")
                + (f", blur {style.blur:g}" if style.blur else "") + (f", JPEG q{style.jpeg}" if style.jpeg else "")
                + (", doors next to corners" if style.corner_doors else ""))
        cases.append(Case(f"supported-{seed:02d}", "supported", desc, sp.image, sp.truth, notes=sp.notes))
    for i, (name, desc, style) in enumerate(OUT_OF_SCOPE):
        sp = generate(500 + i, style)
        cases.append(Case(name, "out-of-scope", desc, sp.image, sp.truth, notes=sp.notes))
    if hand_sample_path:
        hand = _hand_sample(hand_sample_path)
        if hand:
            cases.append(hand)
    cases += [c for c in (_real_apartment(), _real_render()) if c]
    return cases
