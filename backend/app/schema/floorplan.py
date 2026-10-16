"""The FloorPlan schema: the central contract between interpretation (manual / CV / AI)
and the 3D engine.

Conventions
-----------
* All geometry is in metres on the ground plane. x points right and y points DOWN
  (same orientation as the source image), so a traced plan lines up with the picture.
  The 3D layer maps (x, y) -> (x, z).
* A door/window sits on a wall. `offset` is the distance in metres from the wall's
  `start` point to the opening's near edge; the opening spans [offset, offset + width].
* Bump `version` on any breaking change.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schema.geometry import Point, distance, polygon_area, polygon_self_intersects

MIN_WALL_LENGTH_M = 0.05
MIN_ROOM_AREA_M2 = 0.5
COORD_LIMIT_M = 10_000
EPS = 1e-6


class _Base(BaseModel):
    model_config = {"extra": "forbid"}


class SourceImage(_Base):
    floorplan_id: str
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)


class Scale(_Base):
    meters_per_pixel: float = Field(gt=0, lt=100, allow_inf_nan=False)
    # False until the user sets a real-world reference distance.
    calibrated: bool = False


class Wall(_Base):
    id: str = Field(min_length=1, max_length=40)
    start: Point
    end: Point
    height: float = Field(default=2.8, gt=0, le=10)
    thickness: float = Field(default=0.15, gt=0, le=2)


class Room(_Base):
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=60)
    polygon: list[Point] = Field(min_length=3, max_length=200)


class Door(_Base):
    id: str = Field(min_length=1, max_length=40)
    wall_id: str
    offset: float = Field(ge=0, allow_inf_nan=False)
    width: float = Field(default=0.9, gt=0, le=5)
    height: float = Field(default=2.1, gt=0, le=10)


class Window(_Base):
    id: str = Field(min_length=1, max_length=40)
    wall_id: str
    offset: float = Field(ge=0, allow_inf_nan=False)
    width: float = Field(default=1.2, gt=0, le=10)
    height: float = Field(default=1.2, gt=0, le=10)
    sill: float = Field(default=0.9, ge=0, le=10)


class FloorPlan(_Base):
    version: Literal[1] = 1
    units: Literal["meters"] = "meters"
    # Who produced this plan. Lets the UI flag machine output for human review.
    provenance: Literal["manual", "opencv", "ai"] = "manual"
    source: SourceImage
    scale: Scale
    walls: list[Wall] = Field(default_factory=list, max_length=2000)
    rooms: list[Room] = Field(default_factory=list, max_length=200)
    doors: list[Door] = Field(default_factory=list, max_length=1000)
    windows: list[Window] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def _check_consistency(self) -> "FloorPlan":
        self._check_points()
        self._check_unique_ids()
        walls = {w.id: w for w in self.walls}
        for w in self.walls:
            if distance(w.start, w.end) < MIN_WALL_LENGTH_M:
                raise ValueError(f"Wall {w.id} is shorter than {MIN_WALL_LENGTH_M} m.")
        for r in self.rooms:
            # Intersection first: a bowtie's signed areas cancel and would read as "too small".
            if polygon_self_intersects(r.polygon):
                raise ValueError(f"Room '{r.name}' has a self-intersecting outline.")
            if polygon_area(r.polygon) < MIN_ROOM_AREA_M2:
                raise ValueError(f"Room '{r.name}' is smaller than {MIN_ROOM_AREA_M2} m².")
        self._check_openings(walls)
        return self

    def _check_points(self) -> None:
        pts = [p for w in self.walls for p in (w.start, w.end)]
        pts += [p for r in self.rooms for p in r.polygon]
        for x, y in pts:
            if not (abs(x) <= COORD_LIMIT_M and abs(y) <= COORD_LIMIT_M):  # also false for NaN
                raise ValueError("Coordinates must be finite and within ±10 km.")

    def _check_unique_ids(self) -> None:
        ids = [e.id for group in (self.walls, self.rooms, self.doors, self.windows) for e in group]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"Duplicate element ids: {', '.join(sorted(dupes))}.")

    def _check_openings(self, walls: dict[str, Wall]) -> None:
        spans: dict[str, list[tuple[float, float, str]]] = {}
        for kind, items in (("Door", self.doors), ("Window", self.windows)):
            for o in items:
                wall = walls.get(o.wall_id)
                if wall is None:
                    raise ValueError(f"{kind} {o.id} references unknown wall {o.wall_id}.")
                length = distance(wall.start, wall.end)
                if o.offset + o.width > length + EPS:
                    raise ValueError(f"{kind} {o.id} extends past the end of wall {wall.id}.")
                top = o.height if kind == "Door" else o.sill + o.height  # type: ignore[union-attr]
                if top > wall.height + EPS:
                    raise ValueError(f"{kind} {o.id} is taller than wall {wall.id}.")
                spans.setdefault(wall.id, []).append((o.offset, o.offset + o.width, o.id))
        for wall_id, wall_spans in spans.items():
            wall_spans.sort()
            for (_, end_a, id_a), (start_b, _, id_b) in zip(wall_spans, wall_spans[1:]):
                if start_b < end_a - EPS:
                    raise ValueError(f"{id_a} and {id_b} overlap on wall {wall_id}.")
