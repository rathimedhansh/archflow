"""The automatic interpretation pipeline (Milestone 6): stages, conversion, failure modes.

Synthetic plans come from `evaluation/synth.py`, which draws a plan and records its exact
ground truth, so these tests can check *what* was detected, not only that nothing crashed.
"""

from pathlib import Path

import cv2
import numpy as np
import pytest

import app.interpretation.opencv.pipeline as pipeline
from app.interpretation.opencv import STAGES, StageEvent, interpret_image, interpret_path, run_stages
from app.interpretation.opencv.assemble import OMIT_BELOW, assemble
from app.interpretation.opencv.preprocess import preprocess
from app.interpretation.opencv.types import (
    Gap, Opening, OpeningDetection, RoomDetection, RoomRegion, ScaleEstimate, WallDetection, WallSegment,
)
from app.interpretation.opencv.walls import detect_walls
from app.schema import FloorPlan
from app.schema.interpretation import Interpretation
from evaluation.metrics import score
from evaluation.synth import Style, generate

SAMPLE = Path(__file__).resolve().parents[2] / "docs" / "samples" / "m2-sample-plan.png"


def run(image: np.ndarray) -> Interpretation:
    h, w = image.shape[:2]
    return interpret_image(image, floorplan_id="t", width_px=w, height_px=h)


def assert_valid(plan: FloorPlan) -> None:
    """The same validation a manually drawn plan goes through on save."""
    FloorPlan.model_validate_json(plan.model_dump_json())
    assert plan.provenance == "opencv"
    assert plan.scale.calibrated is False  # an estimate is never presented as a measurement


# ---- supported plans ------------------------------------------------------------------------

@pytest.mark.parametrize(
    "seed, style",
    [
        (3, Style()),
        (7, Style(ppm=65, ext_t=0.3, int_t=0.1, window_lines=3, furniture=True)),
        (11, Style(ppm=90, noise=6, blur=0.6, jpeg=80)),
        (4, Style(corner_doors=1.0)),  # doors right next to wall junctions
    ],
)
def test_supported_plan_is_interpreted(seed, style):
    sp = generate(seed, style)
    result = run(sp.image)
    assert result.report.supported
    assert_valid(result.plan)
    s = score(sp.truth, result.plan)
    assert s.wall_length_recall >= 0.95 and s.wall_length_precision >= 0.95
    assert s.rooms.matched == s.rooms.truth and s.rooms.detected == s.rooms.truth
    assert s.doors.recall >= 0.8 and s.doors.precision == 1.0
    assert s.windows.recall >= 0.8 and s.windows.precision == 1.0
    assert s.scale_rel_error < 0.15
    assert result.report.scale.source == "doors"


def test_hand_drawn_sample_plan():
    image = cv2.imread(str(SAMPLE), cv2.IMREAD_GRAYSCALE)
    result = run(image)
    assert result.report.supported
    assert len(result.plan.walls) == 7 and len(result.plan.rooms) == 4
    assert result.plan.doors == [] and result.plan.windows == []
    assert result.report.scale.source == "assumed"  # no doors: nothing to estimate the scale from
    assert_valid(result.plan)


def test_rooms_are_snapped_to_wall_centrelines():
    image = cv2.imread(str(SAMPLE), cv2.IMREAD_GRAYSCALE)
    plan = run(image).plan
    mpp = plan.scale.meters_per_pixel
    xs = sorted({round(x / mpp) for r in plan.rooms for x, _ in r.polygon})
    assert xs == pytest.approx([106, 601, 851, 1095], abs=2)  # measured wall centres of the drawing


def test_slightly_rotated_scan_is_straightened():
    sp = generate(21, Style(rotate_deg=2.0))
    result = run(sp.image)
    assert result.report.supported
    assert any("rotated" in w for w in result.report.warnings)
    assert score(sp.truth, result.plan).rooms.matched >= len(sp.truth.rooms) - 1


def test_light_on_dark_drawing_is_inverted():
    sp = generate(3, Style())
    result = run(255 - sp.image)
    assert result.report.supported
    assert any("inverted" in w for w in result.report.warnings)
    assert len(result.plan.rooms) == len(sp.truth.rooms)


# ---- unsupported, empty and corrupted input --------------------------------------------------

def _rejected(result: Interpretation, fragment: str) -> None:
    assert not result.report.supported
    assert fragment in result.report.reason
    assert (result.plan.walls, result.plan.rooms, result.plan.doors, result.plan.windows) == ([], [], [], [])
    assert result.report.overall_confidence == 0.0
    assert_valid(result.plan)


def test_blank_image_is_rejected():
    _rejected(run(np.full((600, 800), 255, np.uint8)), "blank")


def test_almost_empty_image_is_rejected():
    img = np.full((600, 800), 255, np.uint8)
    cv2.circle(img, (400, 300), 4, 0, -1)
    _rejected(run(img), "almost empty")


def test_photo_like_image_is_rejected():
    rng = np.random.default_rng(0)
    _rejected(run(rng.integers(0, 256, (600, 800), dtype=np.uint8)), "Too much of the image is dark")


def test_hollow_walls_are_rejected_with_a_reason():
    _rejected(run(generate(2, Style(wall_style="hollow")).image), "solid, thick lines")


def test_thin_lines_only_is_rejected():
    img = np.full((800, 1000), 255, np.uint8)
    for i in range(10):
        cv2.line(img, (50, 60 + 70 * i), (950, 60 + 70 * i), 0, 1)
        cv2.line(img, (50 + 90 * i, 50), (50 + 90 * i, 750), 0, 1)
    assert not run(img).report.supported


def test_strongly_rotated_drawing_is_rejected():
    sp = generate(3, Style())
    h, w = sp.image.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), 25, 1.0)
    rotated = cv2.warpAffine(sp.image, m, (w, h), borderValue=255)
    assert not run(rotated).report.supported


@pytest.mark.parametrize("content", [b"", b"not an image at all", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64])
def test_corrupted_file_is_rejected_not_raised(tmp_path, content):
    path = tmp_path / "plan.png"
    path.write_bytes(content)
    result = interpret_path(path, floorplan_id="t", width_px=800, height_px=600)
    _rejected(result, "could not be decoded")


def test_truncated_png_never_crashes(tmp_path):
    ok, png = cv2.imencode(".png", generate(3, Style()).image)
    path = tmp_path / "plan.png"
    path.write_bytes(png.tobytes()[: len(png) // 2])
    result = interpret_path(path, floorplan_id="t", width_px=100, height_px=100)
    assert_valid(result.plan)  # decoded partially or rejected: either way a valid plan


def test_a_crashing_stage_degrades_to_an_explained_empty_result(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("bug in a stage")

    monkeypatch.setattr(pipeline, "detect_rooms", boom)
    result = run(generate(3, Style()).image)
    _rejected(result, "could not process")
    assert [s.name for s in result.report.stages] == ["preprocess", "walls"]  # the stages that did run


# ---- stages, events, determinism -------------------------------------------------------------

def test_stage_events_in_order_then_result():
    sp = generate(3, Style())
    h, w = sp.image.shape
    items = list(run_stages(sp.image, floorplan_id="t", width_px=w, height_px=h))
    events = [i for i in items if isinstance(i, StageEvent)]
    assert [(e.stage, e.status) for e in events] == [(s, st) for s in STAGES for st in ("started", "done")]
    assert all(e.summary for e in events if e.status == "done")
    assert isinstance(items[-1], Interpretation)
    assert [s.name for s in items[-1].report.stages] == list(STAGES)


def test_each_stage_produces_structured_data():
    sp = generate(3, Style())
    pre = preprocess(sp.image)
    assert pre.ink.dtype == np.uint8 and pre.ink.shape == pre.gray.shape and 0 < pre.ink_ratio < 0.4
    walls = detect_walls(pre)
    assert walls.thickness_px > 0 and walls.walls and walls.gaps
    assert all(w.orientation in ("h", "v") and w.end > w.start and 0 <= w.confidence <= 1 for w in walls.walls)
    assert len({w.id for w in walls.walls}) == len(walls.walls)
    assert {g.wall_id for g in walls.gaps} <= {w.id for w in walls.walls}


def test_output_is_deterministic():
    image = generate(5, Style(noise=4, jpeg=85)).image
    a, b = run(image), run(image.copy())
    assert a.plan.model_dump_json() == b.plan.model_dump_json()
    strip = lambda r: r.report.model_dump(exclude={"stages"})  # noqa: E731  (stage timings vary)
    assert strip(a) == strip(b)


def test_report_confidence_is_bounded_and_per_element():
    result = run(generate(3, Style()).image)
    ids = {e.id for g in (result.plan.walls, result.plan.rooms, result.plan.doors, result.plan.windows) for e in g}
    assert {e.id for e in result.report.elements} == ids
    assert all(0 <= e.confidence <= 1 and e.needs_review == (e.confidence < 0.7) for e in result.report.elements)
    assert 0 < result.report.overall_confidence <= 1


# ---- conversion to FloorPlan: low confidence and malformed detections ------------------------

def _pre():
    return preprocess(generate(3, Style()).image)


def _wall(id_, o, center, start, end, conf=0.9, t=10.0):
    return WallSegment(id=id_, orientation=o, center=center, start=start, end=end, thickness=t, confidence=conf)


def _assemble(walls, rooms=(), doors=(), windows=(), unknown=()):
    det = WallDetection(thickness_px=10, min_thickness_px=4, walls=tuple(walls), gaps=(), wall_mask=np.zeros((1, 1), np.uint8),
                        unexplained_ratio=0.0)
    return assemble(
        _pre(), det, RoomDetection(rooms=tuple(rooms)), OpeningDetection(tuple(doors), tuple(windows), tuple(unknown)),
        ScaleEstimate(0.01, "assumed", 0.1, ""), floorplan_id="t", width_px=2000, height_px=2000,
    )


def _gap(wall_id, start, end, o="h", center=100.0):
    return Gap(wall_id=wall_id, orientation=o, center=center, start=start, end=end, thickness=10)


def test_low_confidence_elements_are_omitted_not_invented():
    walls = [_wall("w0", "h", 100, 100, 600), _wall("w1", "h", 400, 100, 600, conf=OMIT_BELOW - 0.1)]
    rooms = [RoomRegion("r0", ((100, 100), (600, 100), (600, 400), (100, 400)), 1.0, OMIT_BELOW - 0.05)]
    doors = [Opening("door", _gap("w0", 200, 290), 0.3, "faint arc")]
    windows = [Opening("window", _gap("w0", 400, 500), 0.45, "one faint line")]
    out = _assemble(walls, rooms, doors, windows)
    assert [w.id for w in out.plan.walls] == ["wall-1"]
    assert out.plan.rooms == [] and out.plan.doors == [] and out.plan.windows == []
    assert out.omitted == {"walls": 1, "rooms": 1, "doors": 1, "windows": 1}
    assert len(out.warnings) == 4
    assert_valid(out.plan)


def test_malformed_detections_never_produce_an_invalid_plan():
    walls = [_wall("w0", "h", 100, 100, 600), _wall("w1", "v", 100, 100, 600)]
    rooms = [
        RoomRegion("r0", ((100, 100), (600, 600), (600, 100), (100, 600)), 1.0, 0.9),  # bowtie
        RoomRegion("r1", ((100, 100), (110, 100), (110, 110)), 1.0, 0.9),  # far below the minimum area
        RoomRegion("r2", ((100, 100), (600, 100)), 1.0, 0.9),  # not a polygon
    ]
    doors = [
        Opening("door", _gap("ghost", 200, 290), 0.9, "arc"),  # on a wall that does not exist
        Opening("door", _gap("w0", 550, 700), 0.9, "arc"),  # runs past the end of its wall
        Opening("door", _gap("w0", 200, 290), 0.95, "arc"),
    ]
    windows = [Opening("window", _gap("w0", 250, 350), 0.9, "lines")]  # overlaps the door
    out = _assemble(walls, rooms, doors, windows)
    assert_valid(out.plan)
    assert len(out.plan.walls) == 2 and out.plan.rooms == []
    assert len(out.plan.doors) == 1 and out.plan.windows == []
    assert out.omitted == {"walls": 0, "rooms": 3, "doors": 2, "windows": 1}


def test_unidentified_openings_split_the_wall_instead_of_becoming_doors():
    walls = [_wall("w0", "h", 100, 100, 600)]
    unknown = [Opening("unknown", _gap("w0", 300, 390), 0.2, "no symbol")]
    out = _assemble(walls, unknown=unknown)
    assert len(out.plan.walls) == 2 and out.plan.doors == []
    (a, b) = out.plan.walls
    assert a.end[0] == pytest.approx(3.0) and b.start[0] == pytest.approx(3.9)
