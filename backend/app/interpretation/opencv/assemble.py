"""Stage 6: CV detections -> a FloorPlan that passes the same validation as a hand-made plan.

Rules:
* Pixel coordinates become metres with the estimated scale; the plan is never `calibrated`.
* Unidentified openings stay open: the wall is split there instead of inventing a door.
* Every element is checked against the schema rules; anything that would not validate, or
  whose confidence is below `OMIT_BELOW`, is left out and counted in the report.
* The final FloorPlan is validated by the real pydantic model. If that ever fails (a bug,
  not an expected path), the plan degrades step by step instead of erroring.
"""

from dataclasses import dataclass

from pydantic import ValidationError

from app.interpretation.opencv.types import (
    OpeningDetection, Preprocessed, RoomDetection, ScaleEstimate, WallDetection, WallSegment,
)
from app.schema import Door, FloorPlan, Room, Scale, SourceImage, Wall, Window
from app.schema.floorplan import MIN_ROOM_AREA_M2, MIN_WALL_LENGTH_M
from app.schema.geometry import polygon_area, polygon_self_intersects
from app.schema.interpretation import ElementConfidence

OMIT_BELOW = 0.5
REVIEW_BELOW = 0.7
WALL_HEIGHT_M = 2.8
DOOR_HEIGHT_M = 2.1
WINDOW_HEIGHT_M = 1.2
WINDOW_SILL_M = 0.9


@dataclass
class Assembled:
    plan: FloorPlan
    elements: list[ElementConfidence]
    warnings: list[str]
    omitted: dict[str, int]


def _conf(id_: str, kind: str, confidence: float, evidence: str = "") -> ElementConfidence:
    c = round(max(0.0, min(1.0, confidence)), 3)
    return ElementConfidence(id=id_, kind=kind, confidence=c, evidence=evidence, needs_review=c < REVIEW_BELOW)  # type: ignore[arg-type]


def _split_at_unknown(w: WallSegment, openings: OpeningDetection) -> list[tuple[float, float]]:
    """Wall extents along its axis after cutting out unidentified openings."""
    cuts = sorted((o.gap.start, o.gap.end) for o in openings.unknown if o.gap.wall_id == w.id)
    pieces, pos = [], w.start
    for a, b in cuts:
        pieces.append((pos, a))
        pos = b
    pieces.append((pos, w.end))
    return pieces


def assemble(
    pre: Preprocessed, walls: WallDetection, rooms: RoomDetection, openings: OpeningDetection,
    scale: ScaleEstimate, *, floorplan_id: str, width_px: int, height_px: int,
) -> Assembled:
    s = pre.factor * scale.meters_per_pixel  # metres per working pixel, for lengths (rotation preserves them)
    elements: list[ElementConfidence] = []
    warnings: list[str] = []
    omitted = {"walls": 0, "rooms": 0, "doors": 0, "windows": 0}

    def pt(x: float, y: float) -> tuple[float, float]:
        sx, sy = pre.to_source(x, y)  # undo deskew and downscaling: the plan must overlay the uploaded image
        return (round(sx * scale.meters_per_pixel, 4), round(sy * scale.meters_per_pixel, 4))

    # ---- walls ----
    out_walls: list[Wall] = []
    pieces: list[tuple[str, float, float, Wall]] = []  # (segment id, piece start, piece end, wall), working px
    for seg in walls.walls:
        if seg.confidence < OMIT_BELOW:
            omitted["walls"] += 1
            continue
        thickness = min(1.0, max(0.05, seg.thickness * s))
        for a, b in _split_at_unknown(seg, openings):
            if (b - a) * s < MIN_WALL_LENGTH_M:
                continue
            start, end = ((a, seg.center), (b, seg.center)) if seg.orientation == "h" else ((seg.center, a), (seg.center, b))
            wall = Wall(id=f"wall-{len(out_walls) + 1}", start=pt(*start), end=pt(*end), height=WALL_HEIGHT_M, thickness=round(thickness, 4))
            out_walls.append(wall)
            pieces.append((seg.id, a, b, wall))
            elements.append(_conf(wall.id, "wall", seg.confidence))

    def host_for(seg_id: str, g_start: float, g_end: float) -> tuple[Wall, float] | None:
        """The output wall (and its start along the axis) that contains a gap."""
        for sid, a, b, wall in pieces:
            if sid == seg_id and a - 1e-6 <= g_start and g_end <= b + 1e-6:
                return wall, a
        return None

    # ---- doors and windows ----
    out_doors: list[Door] = []
    out_windows: list[Window] = []
    spans: dict[str, list[tuple[float, float]]] = {}
    for kind, items in (("door", openings.doors), ("window", openings.windows)):
        for o in sorted(items, key=lambda o: -o.confidence):
            if o.confidence < OMIT_BELOW:
                omitted[f"{kind}s"] += 1
                continue
            found = host_for(o.gap.wall_id, o.gap.start, o.gap.end)
            if not found:
                omitted[f"{kind}s"] += 1
                continue
            wall, piece_start = found
            offset = round((o.gap.start - piece_start) * s, 4)
            width = round(o.gap.width * s, 4)
            wall_len = ((wall.end[0] - wall.start[0]) ** 2 + (wall.end[1] - wall.start[1]) ** 2) ** 0.5
            if offset < 0 or offset + width > wall_len + 1e-6 or width <= 0:
                omitted[f"{kind}s"] += 1
                continue
            taken = spans.setdefault(wall.id, [])
            if any(offset < e and offset + width > b for b, e in taken):
                omitted[f"{kind}s"] += 1
                continue
            taken.append((offset, offset + width))
            if kind == "door":
                door = Door(id=f"door-{len(out_doors) + 1}", wall_id=wall.id, offset=offset, width=min(width, 5.0),
                            height=min(DOOR_HEIGHT_M, wall.height))
                out_doors.append(door)
                elements.append(_conf(door.id, "door", o.confidence, o.evidence))
            else:
                win = Window(id=f"window-{len(out_windows) + 1}", wall_id=wall.id, offset=offset, width=min(width, 10.0),
                             height=WINDOW_HEIGHT_M, sill=WINDOW_SILL_M)
                out_windows.append(win)
                elements.append(_conf(win.id, "window", o.confidence, o.evidence))

    # ---- rooms ----
    out_rooms: list[Room] = []
    for r in rooms.rooms:
        poly = [pt(x, y) for x, y in r.polygon]
        if r.confidence < OMIT_BELOW or len(poly) < 3 or polygon_self_intersects(poly) or polygon_area(poly) < MIN_ROOM_AREA_M2:
            omitted["rooms"] += 1
            continue
        room = Room(id=f"room-{len(out_rooms) + 1}", name=f"Room {len(out_rooms) + 1}", polygon=poly)
        out_rooms.append(room)
        elements.append(_conf(room.id, "room", r.confidence, "enclosed by detected walls"))

    for key, label in (("walls", "wall"), ("rooms", "room"), ("doors", "door"), ("windows", "window")):
        if omitted[key]:
            n = omitted[key]
            warnings.append(f"{n} possible {label}{'s' if n > 1 else ''} left out: not enough evidence to add {'them' if n > 1 else 'it'} reliably.")

    base = dict(
        provenance="opencv",
        source=SourceImage(floorplan_id=floorplan_id, width_px=width_px, height_px=height_px),
        scale=Scale(meters_per_pixel=scale.meters_per_pixel, calibrated=False),
    )
    attempts = [
        dict(walls=out_walls, rooms=out_rooms, doors=out_doors, windows=out_windows),
        dict(walls=out_walls, rooms=out_rooms),
        dict(walls=out_walls),
        dict(),
    ]
    for i, parts in enumerate(attempts):
        try:
            plan = FloorPlan(**base, **parts)
        except ValidationError as exc:
            warnings.append(f"Internal consistency check failed ({exc.errors()[0]['msg']}); some elements were dropped.")
            continue
        if i:
            kept = {e.id for group in (plan.walls, plan.rooms, plan.doors, plan.windows) for e in group}
            elements = [e for e in elements if e.id in kept]
        return Assembled(plan=plan, elements=elements, warnings=warnings, omitted=omitted)
    raise AssertionError("unreachable: an empty plan always validates")
