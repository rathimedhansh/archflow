"""Small, low-resolution floor plans (pipeline `opencv-2`, `resolution.py`).

Plans found online are often 300-1000 px wide, so walls are only 2-3 px thick. At that size the
native reading either rejected the plan or silently lost the thin interior walls (rooms merged).
These tests pin the fix (reading small images enlarged when that is clearly more coherent) and its
guard rails: images that already worked are unchanged, thumbnails and single-line-weight images are
refused with an actionable reason instead of being turned into invented walls.
"""

import cv2
import numpy as np
import pytest

import app.interpretation.opencv.resolution as resolution
from app.interpretation.opencv import interpret_image
from app.schema import FloorPlan, Scale, SourceImage
from evaluation.metrics import score
from evaluation.synth import Style, generate


def run(image: np.ndarray):
    h, w = image.shape[:2]
    return interpret_image(image, floorplan_id="t", width_px=w, height_px=h)


def downscaled(seed: int, target_ppm: float, style: Style = Style()):
    """A clean synthetic plan shrunk like a web image (anti-aliased), with its truth rescaled."""
    sp = generate(seed, style)
    f = target_ppm / style.ppm
    img = cv2.resize(sp.image, (round(sp.image.shape[1] * f), round(sp.image.shape[0] * f)), interpolation=cv2.INTER_AREA)
    truth = sp.truth.model_copy(update=dict(
        scale=Scale(meters_per_pixel=sp.truth.scale.meters_per_pixel / f, calibrated=True),
        source=SourceImage(floorplan_id="t", width_px=img.shape[1], height_px=img.shape[0]),
    ))
    return img, truth


def assert_valid(plan: FloorPlan) -> None:
    FloorPlan.model_validate_json(plan.model_dump_json())
    assert plan.scale.calibrated is False


# ---- the failure that was fixed -----------------------------------------------------------------

@pytest.mark.parametrize("seed, ppm", [(1, 22), (1, 25), (2, 22), (2, 25)])
def test_low_resolution_plan_finds_its_thin_interior_walls(seed, ppm):
    style = Style(ext_t=0.25, int_t=0.12, furniture=False)
    img, truth = downscaled(seed, ppm, style)
    assert max(img.shape) < 1000
    result = run(img)
    assert result.report.supported
    assert_valid(result.plan)
    s = score(truth, result.plan)  # compared in uploaded-image pixels: coordinates map back correctly
    assert s.wall_length_recall >= 0.9 and s.wall_length_precision >= 0.95
    assert s.rooms.matched == s.rooms.truth and s.rooms.detected == s.rooms.truth
    assert any("analysed at" in w for w in result.report.warnings)  # the user is told it was read enlarged
    assert "read at" in next(st.summary for st in result.report.stages if st.name == "walls")


def test_low_resolution_plan_was_wrong_without_the_enlarged_reading(monkeypatch):
    """Guards the test above: with only the native reading, interior walls are lost and rooms merge."""
    monkeypatch.setattr(resolution, "UPSCALES", ())
    img, truth = downscaled(1, 22, Style(ext_t=0.25, int_t=0.12, furniture=False))
    s = score(truth, run(img).plan)
    assert s.rooms.matched < s.rooms.truth


def test_solid_wall_plan_rejected_at_native_size_is_rescued(monkeypatch):
    """Walls ~2.5 px with 1 px annotation: natively "no thick walls"; enlarged it reads as a plan."""
    img, truth = downscaled(4, 21, Style(ext_t=0.12, int_t=0.12, thin_px=1, dimensions=False, furniture=False))
    monkeypatch.setattr(resolution, "UPSCALES", ())
    assert not run(img).report.supported
    monkeypatch.undo()
    result = run(img)
    assert result.report.supported
    s = score(truth, result.plan)
    assert s.wall_length_precision >= 0.95 and s.rooms.matched >= s.rooms.truth - 1


# ---- guard rails ----------------------------------------------------------------------------------

@pytest.mark.parametrize("seed, ppm", [(1, 50), (2, 45), (3, 50)])
def test_small_plans_that_already_worked_are_unchanged(monkeypatch, seed, ppm):
    sp = generate(seed, Style(ppm=ppm, furniture=True))
    assert max(sp.image.shape) <= resolution.UPSCALE_MAX_SIDE  # the enlarged readings are tried
    new = run(sp.image)
    monkeypatch.setattr(resolution, "UPSCALES", ())
    old = run(sp.image)
    assert new.plan == old.plan
    assert not any("analysed at" in w for w in new.report.warnings)


def test_large_images_are_never_read_enlarged(monkeypatch):
    calls = []
    real = resolution._read
    monkeypatch.setattr(resolution, "_read", lambda image, s, pre=None: calls.append(s) or real(image, s, pre))
    sp = generate(3, Style(ppm=120))
    assert max(sp.image.shape) > resolution.UPSCALE_MAX_SIDE
    assert run(sp.image).report.supported
    assert calls == [1.0]


def test_thumbnail_is_refused_with_an_actionable_reason():
    """A thumbnail whose native reading fails is not enlarged (that read text as walls): it is refused."""
    img, _ = downscaled(4, 14, Style(ext_t=0.12, int_t=0.12, thin_px=1, dimensions=False, furniture=False))
    assert max(img.shape) < resolution.MIN_DETECT_SIDE
    result = run(img)
    assert not result.report.supported
    assert "too small" in result.report.reason and "larger version" in result.report.reason
    assert (result.plan.walls, result.plan.rooms) == ([], [])


def test_graph_paper_is_not_turned_into_walls_when_enlarged():
    """One line weight everywhere: enlarging thickens every line, which must not make them walls."""
    img = np.full((800, 800), 255, np.uint8)
    for i in range(0, 800, 40):
        cv2.line(img, (i, 0), (i, 799), 0, 1)
        cv2.line(img, (0, i), (799, i), 0, 1)
    result = run(img)
    assert not result.report.supported
    assert result.plan.walls == [] and result.plan.rooms == []


def test_small_rejected_image_suggests_a_larger_version():
    img = np.full((500, 700), 255, np.uint8)
    for i in range(12):
        cv2.line(img, (30, 30 + 38 * i), (670, 30 + 38 * i), 0, 1)
    result = run(img)
    assert not result.report.supported
    assert "larger version" in result.report.reason


def test_enlarged_reading_is_deterministic():
    img, _ = downscaled(1, 22, Style(ext_t=0.25, int_t=0.12, furniture=False))
    a, b = run(img), run(img)
    assert any("analysed at" in w for w in a.report.warnings)
    assert a.plan == b.plan and a.report.elements == b.report.elements


def test_enlarged_reading_keeps_scale_in_uploaded_pixels():
    """The scale estimate is per uploaded pixel whatever the working size (doors measured in source px)."""
    style = Style(ext_t=0.25, int_t=0.12, furniture=False)
    img, truth = downscaled(1, 25, style)
    result = run(img)
    assert any("analysed at" in w for w in result.report.warnings)
    assert result.report.scale.source == "doors"
    assert abs(result.plan.scale.meters_per_pixel / truth.scale.meters_per_pixel - 1) < 0.2
    assert all(0 <= x <= img.shape[1] * result.plan.scale.meters_per_pixel + 1e-6
               for w in result.plan.walls for x in (w.start[0], w.end[0]))


def test_preprocess_upscale_is_bounded():
    from app.interpretation.opencv.preprocess import MAX_WORKING_SIDE, preprocess
    sp = generate(3, Style(ppm=60))
    pre = preprocess(sp.image, upscale=3.0)
    assert max(pre.gray.shape) <= MAX_WORKING_SIDE
    assert pre.factor < 1.0
    x, y = pre.to_source(pre.gray.shape[1], pre.gray.shape[0])
    assert x == pytest.approx(sp.image.shape[1], abs=1) and y == pytest.approx(sp.image.shape[0], abs=1)
