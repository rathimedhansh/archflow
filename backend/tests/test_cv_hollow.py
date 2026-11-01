"""Walls drawn as double outlines (pipeline `opencv-2`, `hollow.py`).

The double-line reading is a fallback: it only runs when no solid reading works, it must never
turn other parallel-line drawings (hatching, furniture, dimension chains, stairs, tables, graph
paper, sheet frames) into walls, and its results are always reported with reduced confidence.
"""

from dataclasses import replace

import cv2
import numpy as np
import pytest

import app.interpretation.opencv.resolution as resolution
from app.interpretation.opencv import interpret_image
from app.interpretation.opencv.hollow import _bands, _bridge, _drop_frames, _drop_stacked, _pairs, fill_hollow_walls
from app.interpretation.opencv.types import Gap, Preprocessed, Unsupported, WallDetection, WallSegment
from app.schema import FloorPlan
from evaluation.metrics import score
from evaluation.synth import Style, generate

HOLLOW = Style(wall_style="hollow", ppm=80, thin_px=1, noise=0.0, jpeg=None, blur=0.0)


def run(image: np.ndarray):
    h, w = image.shape[:2]
    return interpret_image(image, floorplan_id="t", width_px=w, height_px=h)


def assert_valid(plan: FloorPlan) -> None:
    FloorPlan.model_validate_json(plan.model_dump_json())
    assert plan.scale.calibrated is False


def assert_nothing_built(result) -> None:
    assert not result.report.supported
    assert (result.plan.walls, result.plan.rooms, result.plan.doors, result.plan.windows) == ([], [], [], [])


def hatch_walls(img: np.ndarray, truth: FloorPlan, spacing: int = 6) -> np.ndarray:
    """Diagonal hatch (CAD poché) between the outlines of every wall, openings left clear."""
    mpp = truth.scale.meters_per_pixel
    band = np.zeros_like(img)
    walls = {w.id: w for w in truth.walls}
    for w in truth.walls:
        (x0, y0), (x1, y1) = w.start, w.end
        t = w.thickness / 2
        band[int((min(y0, y1) - t) / mpp) + 2:int((max(y0, y1) + t) / mpp) - 2,
             int((min(x0, x1) - t) / mpp) + 2:int((max(x0, x1) + t) / mpp) - 2] = 255
    for o in list(truth.doors) + list(truth.windows):
        w = walls[o.wall_id]
        (x0, y0), (x1, y1) = w.start, w.end
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        a = (x0 + ux * o.offset, y0 + uy * o.offset)
        b = (x0 + ux * (o.offset + o.width), y0 + uy * (o.offset + o.width))
        t = w.thickness / 2 + 2 * mpp
        xs, ys = sorted((a[0], b[0])), sorted((a[1], b[1]))
        band[int((ys[0] - t * abs(ux)) / mpp):int((ys[1] + t * abs(ux)) / mpp) + 1,
             int((xs[0] - t * abs(uy)) / mpp):int((xs[1] + t * abs(uy)) / mpp) + 1] = 0
    hatch = np.zeros_like(img)
    h, w = img.shape
    for c in range(-h, w, spacing):
        cv2.line(hatch, (c, 0), (c + h, h), 255, 1)
    out = img.copy()
    out[cv2.bitwise_and(hatch, band) > 0] = 0
    return out


def hatch_floors(img: np.ndarray, truth: FloorPlan, spacing: int, vertical: bool) -> np.ndarray:
    """Parallel floor hatching in every room, right up to the walls (like a measured survey drawing)."""
    mpp = truth.scale.meters_per_pixel
    out = img.copy()
    k = int(max(w.thickness for w in truth.walls) / 2 / mpp) + 3
    h, w = img.shape
    lines = np.zeros_like(img)
    for i in range(0, w if vertical else h, spacing):
        cv2.line(lines, (i, 0) if vertical else (0, i), (i, h) if vertical else (w, i), 255, 1)
    for r in truth.rooms:
        m = np.zeros_like(img)
        cv2.fillPoly(m, [np.array([[x / mpp, y / mpp] for x, y in r.polygon], np.int32)], 255)
        m = cv2.erode(m, np.ones((2 * k + 1,) * 2, np.uint8))
        out[(cv2.bitwise_and(lines, m) > 0) & (out > 128)] = 0
    return out


# ---- double-line walls are read --------------------------------------------------------------------

@pytest.mark.parametrize("seed, style", [
    (3, HOLLOW),
    (5, HOLLOW),
    (7, Style(wall_style="hollow", ppm=95, thin_px=2, noise=0.0, jpeg=None, blur=0.0)),
    (12, Style(wall_style="hollow", ppm=70, thin_px=1, furniture=True, noise=0.0, jpeg=None, blur=0.0)),
])
def test_double_line_walls_become_walls_and_rooms(seed, style):
    sp = generate(seed, style)
    result = run(sp.image)
    assert result.report.supported
    assert_valid(result.plan)
    s = score(sp.truth, result.plan)
    assert s.wall_length_recall >= 0.9 and s.wall_length_precision >= 0.97
    assert s.rooms.matched == s.rooms.truth and s.rooms.detected == s.rooms.truth


def assert_read_completely(sp, result) -> None:
    assert result.report.supported
    s = score(sp.truth, result.plan)
    assert s.wall_length_recall >= 0.9 and s.wall_length_precision >= 0.97
    assert s.rooms.matched == s.rooms.truth == s.rooms.detected


@pytest.mark.parametrize("seed, style", [
    (2, Style(wall_style="hollow", blur=0.6)),  # blur fuses room labels into blobs inside the building
    (3, Style(wall_style="hollow", ppm=110)),
    (7, Style(wall_style="hollow", ext_t=0.3, int_t=0.15)),
])
def test_a_building_around_stray_marks_is_not_dropped_as_a_sheet_frame(seed, style):
    """The whole building was removed as a "frame" when it enclosed small marks that it did not touch."""
    sp = generate(seed, style)
    assert_read_completely(sp, run(sp.image))


@pytest.mark.parametrize("seed", [2, 4, 6, 7])
def test_doors_next_to_junctions_keep_their_walls(seed):
    """At a door beside a junction the door symbol starts at the jamb and an open leaf lies along the next
    wall, one gap from its outline; such walls were rejected as furniture or as part of a periodic series."""
    sp = generate(seed, Style(wall_style="hollow", corner_doors=0.6))
    assert_read_completely(sp, run(sp.image))


def drop_out(img: np.ndarray, seed: int, n: int = 40, size: int = 6) -> np.ndarray:
    """Erase small squares of line work at random, like dropouts in a scan or a thresholded JPEG."""
    out = img.copy()
    ys, xs = np.nonzero(img < 128)
    for k in np.random.default_rng(seed).choice(len(ys), n, replace=False):
        y, x = ys[k], xs[k]
        out[max(0, y - size // 2):y + size // 2, max(0, x - size // 2):x + size // 2] = 255
    return out


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_broken_outlines_are_read_as_continuous_walls(seed):
    """A break in one outline split a wall into pieces that were each rejected (one outline running on beside
    open paper), notched it (false openings), or left it short of the junction (rooms leaked into each other)."""
    sp = generate(seed, Style(wall_style="hollow"))
    assert_read_completely(sp, run(drop_out(sp.image, seed)))


def resized(sp, f: float):
    """A generated plan scaled by `f` (an online thumbnail), with its ground truth scaled to match."""
    img = cv2.resize(sp.image, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    scale = sp.truth.scale.model_copy(update={"meters_per_pixel": sp.truth.scale.meters_per_pixel / f})
    return replace(sp, image=img, truth=sp.truth.model_copy(update={"scale": scale}))


@pytest.mark.parametrize("seed", [2, 3])
def test_half_size_outlines_are_not_paired_with_dimension_lines(seed):
    """At half size a dimension line lies within MAX_GAP of the building's outer outline; the pair became a
    thick wall outside the building (wall precision ~0.6) that the end rules let through."""
    sp = resized(generate(seed, Style(wall_style="hollow")), 0.5)
    assert_read_completely(sp, run(sp.image))


@pytest.mark.parametrize("seed", [1, 4])
def test_thick_walls_beside_dimension_lines_are_kept_at_half_size(seed):
    sp = resized(generate(seed, Style(wall_style="hollow", ppm=110, ext_t=0.3, int_t=0.15)), 0.5)
    assert_read_completely(sp, run(sp.image))


@pytest.mark.parametrize("style", [
    Style(wall_style="hollow", furniture=True),
    Style(wall_style="hollow", noise=4, jpeg=85, blur=0.6, furniture=True, thin_px=2),
])
def test_furniture_along_a_wall_is_not_read_as_a_thick_wall(style):
    """The strip between a wall and a row of furniture became a wall, or the reading was rejected."""
    sp = generate(103, style)
    assert_read_completely(sp, run(sp.image))


def test_double_line_result_is_never_reported_as_confident():
    result = run(generate(3, HOLLOW).image)
    assert result.report.overall_confidence <= resolution.HOLLOW_CONFIDENCE
    assert any("drawn as double outlines" in w for w in result.report.warnings)


def test_incomplete_double_line_reading_is_reported_as_uncertain(monkeypatch):
    """When rooms cover too little of the building (or walls end in mid-air), the result is flagged, not hidden."""
    monkeypatch.setattr(resolution, "HOLLOW_MIN_COVERAGE", 1.01)  # force the incomplete case on a good plan
    result = run(generate(3, HOLLOW).image)
    assert result.report.supported
    assert result.report.overall_confidence <= resolution.HOLLOW_UNCERTAIN_CONFIDENCE < 0.6  # the UI's "uncertain" band
    note = next(w for w in result.report.warnings if "double outlines" in w)
    assert "rooms enclose only about" in note and "may be merged or missing" in note


def test_hatched_poche_walls_are_read():
    sp = generate(6, HOLLOW)
    result = run(hatch_walls(sp.image, sp.truth))
    assert result.report.supported
    s = score(sp.truth, result.plan)
    assert s.wall_length_recall >= 0.9 and s.wall_length_precision >= 0.97
    assert s.rooms.matched >= s.rooms.truth - 1


def _off(pre):
    raise Unsupported("double-line reading switched off")


def test_double_line_reading_was_rejected_before(monkeypatch):
    """Guards the tests above: without the double-line reading these drawings are rejected."""
    monkeypatch.setattr(resolution, "_hollow_reading", _off)
    assert not run(generate(3, HOLLOW).image).report.supported


def test_double_line_reading_is_deterministic():
    img = generate(5, HOLLOW).image
    a, b = run(img), run(img)
    assert a.plan == b.plan and a.report.elements == b.report.elements and a.report.warnings == b.report.warnings


# ---- never at the expense of drawings that already work ------------------------------------------

@pytest.mark.parametrize("seed, style", [
    (3, Style()),
    (7, Style(ppm=65, ext_t=0.3, int_t=0.1, window_lines=3, furniture=True)),
    (9, Style(furniture=True, noise=4)),
])
def test_solid_wall_plans_never_reach_the_double_line_reading(monkeypatch, seed, style):
    calls = []
    monkeypatch.setattr(resolution, "_hollow_reading", lambda pre: calls.append(1) or _off(pre))
    result = run(generate(seed, style).image)
    assert result.report.supported and calls == []


def test_solid_walls_with_hatched_floors_are_unchanged(monkeypatch):
    sp = generate(61, Style(noise=0.0, jpeg=None, blur=0.0))
    img = hatch_floors(sp.image, sp.truth, 10, vertical=True)
    new = run(img)
    monkeypatch.setattr(resolution, "_hollow_reading", _off)
    assert run(img).plan == new.plan


def test_double_lines_with_hatched_floors_never_invent_walls():
    """Floor hatching right up to the walls: the result may be partial or rejected, but not made up."""
    for seed, vertical in ((41, True), (42, False), (43, True)):
        sp = generate(seed, HOLLOW)
        result = run(hatch_floors(sp.image, sp.truth, 8, vertical))
        if result.report.supported:
            assert score(sp.truth, result.plan).wall_length_precision >= 0.9
            assert result.report.overall_confidence <= resolution.HOLLOW_CONFIDENCE


@pytest.mark.parametrize("hatched", [False, True])
def test_accepted_double_line_readings_do_not_invent_walls(hatched):
    """Over a range of drawings a double-line reading may be rejected, but an accepted one is not made up."""
    style = Style(wall_style="hollow", ppm=70, thin_px=1, furniture=not hatched, noise=0.0, jpeg=None, blur=0.0)
    accepted = 0
    for seed in range(1, 7):
        sp = generate(seed, style)
        result = run(hatch_walls(sp.image, sp.truth) if hatched else sp.image)
        if result.report.supported:
            accepted += 1
            assert score(sp.truth, result.plan).wall_length_precision >= 0.97, seed
    assert accepted >= 3


def test_furniture_next_to_walls_is_not_a_wall():
    sp = generate(12, Style(wall_style="hollow", ppm=70, thin_px=1, furniture=True, noise=0.0, jpeg=None, blur=0.0))
    s = score(sp.truth, run(sp.image).plan)
    assert s.walls.detected - (s.walls.correct or s.walls.matched) == 0  # no wall that matches nothing


# ---- look-alikes: parallel lines that are not walls --------------------------------------------

def _blank(h=900, w=1200):
    return np.full((h, w), 255, np.uint8)


def look_alike(kind: str) -> np.ndarray:
    img = _blank()
    rng = np.random.default_rng(3)
    if kind == "furniture":
        for _ in range(14):
            x, y, w, h = int(rng.integers(50, 1000)), int(rng.integers(50, 700)), int(rng.integers(80, 200)), int(rng.integers(60, 150))
            cv2.rectangle(img, (x, y), (x + w, y + h), 0, 1)
            cv2.rectangle(img, (x + 10, y + 10), (x + w - 10, y + h - 10), 0, 1)
    elif kind == "dimensions":
        for k, y in enumerate((100, 112, 700, 712)):
            cv2.line(img, (100, y), (1100, y), 0, 1)
            for x in range(100, 1101, 125 + 25 * k):
                cv2.line(img, (x, y - 8), (x, y + 8), 0, 1)
                cv2.putText(img, "3'-6\"", (x + 20, y - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, 0, 1)
    elif kind == "stairs":
        for y in range(100, 800, 14):
            cv2.line(img, (300, y), (700, y), 0, 1)
        for x in (300, 310, 690, 700):
            cv2.line(img, (x, 100), (x, 800), 0, 1)
    elif kind == "table":
        for y in range(80, 760, 40):
            cv2.line(img, (60, y), (1040, y), 0, 1)
        for x in (60, 300, 550, 800, 1040):
            cv2.line(img, (x, 80), (x, 720), 0, 1)
        cv2.rectangle(img, (50, 70), (1050, 730), 0, 1)
    elif kind == "graph":
        for i in range(0, 1200, 24):
            cv2.line(img, (i, 0), (i, 899), 0, 1)
            cv2.line(img, (0, i), (1199, i), 0, 1)
    elif kind == "frame":
        cv2.rectangle(img, (30, 30), (1170, 870), 0, 1)
        cv2.rectangle(img, (40, 40), (1160, 860), 0, 1)
        cv2.rectangle(img, (700, 720), (1160, 860), 0, 1)
        cv2.putText(img, "TITLE BLOCK", (720, 820), cv2.FONT_HERSHEY_SIMPLEX, 1.0, 0, 1)
    elif kind == "text":
        for i in range(18):
            cv2.putText(img, "Lorem ipsum dolor sit amet 12'-6\" x 10'-0\"", (40, 50 + 45 * i), cv2.FONT_HERSHEY_SIMPLEX, 1.0, 0, 2)
    return img


@pytest.mark.parametrize("kind", ["furniture", "dimensions", "stairs", "table", "graph", "frame", "text"])
def test_parallel_line_look_alikes_build_nothing(kind):
    assert_nothing_built(run(look_alike(kind)))


def test_rejection_says_double_lines_were_tried():
    result = run(look_alike("furniture"))
    assert "solid, thick lines" in result.report.reason and "double outlines" in result.report.reason


def test_plan_inside_a_double_line_sheet_frame_ignores_the_frame():
    sp = generate(3, HOLLOW)
    img = sp.image.copy()
    h, w = img.shape
    cv2.rectangle(img, (8, 8), (w - 9, h - 9), 0, 1)
    cv2.rectangle(img, (20, 20), (w - 21, h - 21), 0, 1)
    result = run(img)
    assert result.report.supported
    assert score(sp.truth, result.plan).wall_length_precision >= 0.97


# ---- building blocks -------------------------------------------------------------------------------

def test_periodic_lines_are_not_pairs():
    lines = np.zeros((200, 50), np.uint8)
    for y in range(20, 180, 12):  # hatching: equal spacing
        lines[y, :] = 255
    assert len(_pairs(lines)) == 0
    lines[:] = 0
    lines[50, :] = lines[62, :] = 255  # one isolated pair: a wall's two outlines
    pairs = _pairs(lines)
    assert len(pairs) == 50 and set(pairs[:, 3] - pairs[:, 2]) == {11}


def test_sheet_frames_are_dropped_but_not_buildings():
    fill = np.zeros((300, 400), np.uint8)
    cv2.rectangle(fill, (5, 5), (394, 294), 255, 6)  # frame around everything
    cv2.rectangle(fill, (100, 80), (300, 220), 255, 10)  # building outline
    cv2.line(fill, (200, 80), (200, 220), 255, 6)  # partition
    out = _drop_frames(fill)
    assert out[5, 200] == 0 and out[80, 150] == 255 and out[150, 200] == 255


def test_a_building_around_room_labels_is_not_a_sheet_frame():
    fill = np.zeros((300, 400), np.uint8)
    cv2.rectangle(fill, (20, 20), (380, 280), 255, 6)  # a one-room building: a bare ring, thin like a frame
    fill[140:150, 150:170] = 255  # its label, fused into a blob by blur
    assert _drop_frames(fill, 12)[20, 200] == 255  # what it encloses is no drawing
    fill[20:280, 95:105] = 255  # a partition joined to the outline, away from its bounding box
    cv2.rectangle(fill, (230, 90), (330, 210), 255, 8)  # and a substantial structure that does not touch it
    assert _drop_frames(fill, 12)[20, 200] == 255  # not a bare ring


def test_a_break_in_one_outline_is_bridged_but_an_opening_is_not():
    lines = np.zeros((60, 300), np.uint8)
    lines[20, :] = lines[32, :] = 255  # a wall's two outlines
    lines[20, 100:125] = 0  # the top one is broken for 25 px (a fragment shorter than MIN_LINE was lost)
    bands = _bands(_pairs(lines))
    assert len(bands) == 2
    bridged = _bridge(bands, lines)
    assert len(bridged) == 1 and sorted(bridged[0][:, 0].tolist()) == list(range(300))  # no notch is left
    lines[32, 100:125] = 0  # both outlines stop: a door or window opening
    assert len(_bridge(_bands(_pairs(lines)), lines)) == 2
    lines[32, 100:125] = 255
    lines[20, 100:170] = 0  # a 70 px stretch with one outline missing is no dropout
    assert len(_bridge(_bands(_pairs(lines)), lines)) == 2


def band(x0: int, x1: int, a0: int, b0: int, line: int = 2) -> np.ndarray:
    """A band of outline pairs (x, top start, top end, bottom start, bottom end), one per column."""
    xs = np.arange(x0, x1)
    return np.stack([xs] + [np.full(xs.size, v) for v in (a0, a0 + line, b0, b0 + line)], axis=1)


def test_a_line_is_the_face_of_one_wall_only():
    def class_of(b: np.ndarray):
        g = float(np.median(b[:, 3] - b[:, 2]))
        return next((c for c in ((4, 8), (12, 20), (30, 52)) if c[0] <= g <= c[1]), None)

    wall = band(0, 300, 100, 108)  # gap 6, its first outline at rows 100-102
    dimension = band(0, 300, 60, 100)  # gap 38: a dimension line paired with that outline
    partition = band(0, 200, 300, 308)  # gap 6, free-standing: the drawing's real wall class
    h, _ = _drop_stacked([dimension, wall, partition], [], class_of)
    assert len(h) == 2 and all(class_of(b) == (4, 8) for b in h)
    # No free-standing evidence for either class: both are kept, as before the guard.
    h, _ = _drop_stacked([dimension, wall], [], class_of)
    assert len(h) == 2
    # A door leaf along a thick exterior wall: both classes stand alone elsewhere, both are kept.
    leaf, exterior = band(0, 60, 86, 94), band(0, 400, 94, 110)
    h, _ = _drop_stacked([leaf, exterior, partition, band(0, 400, 500, 516)], [], class_of)
    assert len(h) == 4


def test_a_long_gap_without_a_door_or_window_splits_the_wall():
    """Collinear walls far apart (a corner of the building, a wall across the room) are not one wall with an opening."""
    blank = np.full((400, 600), 255, np.uint8)
    empty = np.zeros_like(blank)
    pre = Preprocessed(gray=blank, ink=empty, symbols=empty, factor=1.0, ink_ratio=0.0, inverted=False)
    walls = WallDetection(
        thickness_px=10.0, min_thickness_px=4, walls=(WallSegment("w0", "h", 200.0, 50.0, 550.0, 10.0, 0.9),),
        gaps=(Gap("w0", "h", 200.0, 150.0, 450.0, 10.0),), wall_mask=empty, unexplained_ratio=0.0,
    )
    out = resolution._split_unexplained_gaps(pre, walls)
    assert [(w.id, w.start, w.end) for w in out.walls] == [("w0", 50.0, 150.0), ("w1", 450.0, 550.0)]
    assert out.gaps == () and all(w.confidence < 0.9 for w in out.walls)  # each piece now has a free end
    door_wide = replace(walls, gaps=(Gap("w0", "h", 200.0, 260.0, 330.0, 10.0),))
    assert resolution._split_unexplained_gaps(pre, door_wide) is door_wide  # a plain doorway stays an opening


def test_no_double_lines_raises():
    with pytest.raises(Unsupported):
        fill_hollow_walls(np.zeros((300, 300), np.uint8))
