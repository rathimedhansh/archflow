import pytest
from pydantic import ValidationError

from app.schema import FloorPlan
from app.schema.geometry import polygon_area, polygon_self_intersects


def plan(**overrides) -> dict:
    base = {
        "source": {"floorplan_id": "a" * 32, "width_px": 1000, "height_px": 800},
        "scale": {"meters_per_pixel": 0.01, "calibrated": True},
        "walls": [
            {"id": "wall-1", "start": [0, 0], "end": [5, 0]},
            {"id": "wall-2", "start": [5, 0], "end": [5, 4]},
        ],
        "rooms": [{"id": "room-1", "name": "Living", "polygon": [[0, 0], [5, 0], [5, 4], [0, 4]]}],
        "doors": [{"id": "door-1", "wall_id": "wall-1", "offset": 1.0}],
        "windows": [{"id": "win-1", "wall_id": "wall-1", "offset": 3.0}],
    }
    base.update(overrides)
    return base


def test_valid_plan_and_defaults():
    p = FloorPlan.model_validate(plan())
    assert p.units == "meters" and p.version == 1 and p.provenance == "manual"
    assert p.walls[0].height == 2.8 and p.doors[0].width == 0.9


def test_roundtrip_json():
    p = FloorPlan.model_validate(plan())
    assert FloorPlan.model_validate_json(p.model_dump_json()) == p


@pytest.mark.parametrize(
    "overrides,message",
    [
        ({"walls": [{"id": "w", "start": [0, 0], "end": [0.01, 0]}], "doors": [], "windows": []}, "shorter"),
        ({"walls": [{"id": "wall-1", "start": [0, 0], "end": [5, 0]}] * 2, "doors": [], "windows": []}, "Duplicate"),
        ({"doors": [{"id": "d", "wall_id": "nope", "offset": 0}]}, "unknown wall"),
        ({"doors": [{"id": "d", "wall_id": "wall-1", "offset": 4.5}]}, "past the end"),
        ({"doors": [{"id": "d", "wall_id": "wall-1", "offset": 0, "height": 3.5}]}, "taller"),
        ({"windows": [{"id": "w", "wall_id": "wall-1", "offset": 3, "sill": 2.0, "height": 1.2}]}, "taller"),
        ({"windows": [{"id": "w", "wall_id": "wall-1", "offset": 1.5}]}, "overlap"),
        ({"rooms": [{"id": "r", "name": "Bow", "polygon": [[0, 0], [4, 4], [4, 0], [0, 4]]}]}, "self-intersecting"),
        ({"rooms": [{"id": "r", "name": "Tiny", "polygon": [[0, 0], [0.1, 0], [0.1, 0.1]]}]}, "smaller"),
        ({"rooms": [{"id": "r", "name": "Line", "polygon": [[0, 0], [1, 1]]}]}, "at least 3"),
        ({"walls": [{"id": "w", "start": [0, 0], "end": [99999, 0]}], "doors": [], "windows": []}, "finite"),
    ],
)
def test_invalid_plans_rejected(overrides, message):
    with pytest.raises(ValidationError, match=message):
        FloorPlan.model_validate(plan(**overrides))


def test_rejects_bad_ranges_and_extra_fields():
    bad_wall = [{"id": "w", "start": [0, 0], "end": [5, 0], "height": -1}]
    with pytest.raises(ValidationError):
        FloorPlan.model_validate(plan(walls=bad_wall, doors=[], windows=[]))
    with pytest.raises(ValidationError):
        FloorPlan.model_validate(plan(surprise=1))
    with pytest.raises(ValidationError):
        FloorPlan.model_validate(plan(units="feet"))


def test_geometry_helpers():
    assert polygon_area([(0, 0), (4, 0), (4, 3), (0, 3)]) == 12
    assert not polygon_self_intersects([(0, 0), (4, 0), (4, 3), (0, 3)])
    assert polygon_self_intersects([(0, 0), (4, 4), (4, 0), (0, 4)])
    # L-shaped (concave) rooms are fine.
    assert not polygon_self_intersects([(0, 0), (4, 0), (4, 2), (2, 2), (2, 4), (0, 4)])
