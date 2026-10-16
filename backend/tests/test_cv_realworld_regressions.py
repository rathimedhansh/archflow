"""Regression tests for bugs found by the real-world validation of the M6 pipeline (2026-09-27).

Each test reproduces, on a small synthetic drawing, the situation a real plan exposed:
* a plan cropped tightly so its outer walls lie on the image border (Berlin P2 apartment plan);
* two doors either side of a partition wall that meets the wall they sit in (Indian 2BHK plan);
* doors drawn with a threshold line across the gap (same plan);
* every assembly warning reported twice (Berlin plan).
"""

from pathlib import Path

import cv2
import numpy as np

import app.interpretation.opencv.pipeline as pipeline
from app.interpretation.opencv import interpret_image
from app.interpretation.opencv.preprocess import preprocess
from app.interpretation.opencv.walls import detect_walls

SAMPLE = Path(__file__).resolve().parents[2] / "docs" / "samples" / "m2-sample-plan.png"


def run(image: np.ndarray):
    h, w = image.shape[:2]
    return interpret_image(image, floorplan_id="t", width_px=w, height_px=h)


def px(plan, value: float) -> float:
    return value / plan.scale.meters_per_pixel


def opening_span_px(plan, o) -> tuple[float, float, str, float]:
    """(start, end) along the host wall's axis in image px, the axis, and the wall's centre line."""
    w = next(w for w in plan.walls if w.id == o.wall_id)
    horizontal = abs(w.end[1] - w.start[1]) < 1e-9
    axis0 = w.start[0] if horizontal else w.start[1]
    return px(plan, axis0 + o.offset), px(plan, axis0 + o.offset + o.width), "h" if horizontal else "v", px(plan, w.start[1] if horizontal else w.start[0])


# ---- walls on the image border -----------------------------------------------------------------

def test_walls_lying_on_the_image_border_are_detected():
    """Erosion treated outside the image as ink, so a wall along the border survived the opening
    *across* it and fused the walls at its ends into one U-shaped blob, which was then dropped."""
    image = cv2.imread(str(SAMPLE), cv2.IMREAD_GRAYSCALE)
    # The sample's exterior walls are 12 px thick, centred at x=106/1095 and y=106/695.
    cropped = np.ascontiguousarray(image[100:701, 100:1101])  # outer wall faces now on all four borders
    walls = detect_walls(preprocess(cropped)).walls
    assert len(walls) == 7
    result = run(cropped)
    assert len(result.plan.walls) == 7 and len(result.plan.rooms) == 4


def test_a_wall_along_one_border_keeps_its_perpendicular_walls():
    img = np.full((500, 800), 255, np.uint8)
    img[0:10, 200:800] = 0  # top wall on the border
    img[0:400, 200:210] = 0  # left wall hanging down from it
    img[0:400, 790:800] = 0  # right wall, on the right border too
    img[390:400, 200:800] = 0  # bottom wall
    walls = detect_walls(preprocess(img)).walls
    vertical = sorted(round(w.center) for w in walls if w.orientation == "v")
    horizontal = sorted(round(w.center) for w in walls if w.orientation == "h")
    assert vertical == [205, 795] and horizontal == [5, 395]


# ---- openings next to wall junctions -----------------------------------------------------------

def _two_doors_either_side_of_a_partition(threshold_lines: bool = False) -> np.ndarray:
    """Two rooms below a corridor wall; a partition meets that wall between two doors."""
    img = np.full((800, 1000), 255, np.uint8)
    cv2.rectangle(img, (100, 100), (900, 700), 0, 14)  # exterior
    img[395:406, 100:900] = 0  # corridor wall, 10-11 px thick
    img[400:700, 495:506] = 0  # partition between the two rooms
    img[395:406, 405:495] = 255  # door 1: from x=405 up to the partition's face
    img[395:406, 506:596] = 255  # door 2: from the partition's other face to x=596
    for hinge, start in (((405, 405), 0), ((596, 405), 90)):
        cv2.line(img, hinge, (hinge[0], hinge[1] + 90), 0, 2)  # door leaf, open
        cv2.ellipse(img, hinge, (90, 90), 0, start, start + 90, 0, 2)  # swing arc
    if threshold_lines:
        cv2.line(img, (405, 396), (494, 396), 0, 1)
        cv2.line(img, (507, 396), (595, 396), 0, 1)
    # A window drawn as a single sash line (no arc) in the top wall: must stay a window.
    img[93:108, 300:400] = 255
    cv2.line(img, (300, 100), (399, 100), 0, 1)
    return img


def test_an_opening_never_spans_a_wall_junction():
    """The collinear merge used to record 405..596 as one gap, straight through the partition."""
    result = run(_two_doors_either_side_of_a_partition())
    plan = result.plan
    spans = [opening_span_px(plan, o) for o in [*plan.doors, *plan.windows]]
    on_corridor = sorted((round(a), round(b)) for a, b, axis, c in spans if axis == "h" and abs(c - 400) < 4)
    assert len(on_corridor) == 2
    assert all(not (a < 500 < b) for a, b in on_corridor)  # no opening contains the partition
    assert len([d for d in plan.doors if abs(opening_span_px(plan, d)[3] - 400) < 4]) == 2


def test_gaps_are_split_at_junctions_in_the_wall_stage():
    walls = detect_walls(preprocess(_two_doors_either_side_of_a_partition()))
    corridor = next(w for w in walls.walls if w.orientation == "h" and abs(w.center - 400) < 4)
    gaps = sorted((g.start, g.end) for g in walls.gaps if g.wall_id == corridor.id)
    assert len(gaps) == 2
    assert gaps[0][1] <= 496 and gaps[1][0] >= 505


def test_a_door_with_a_threshold_line_is_a_door_not_a_window():
    """CAD drawings often close a door gap with one line; with a clear swing arc it is a door."""
    plan = run(_two_doors_either_side_of_a_partition(threshold_lines=True)).plan
    corridor_doors = [d for d in plan.doors if abs(opening_span_px(plan, d)[3] - 400) < 4]
    corridor_windows = [w for w in plan.windows if abs(opening_span_px(plan, w)[3] - 400) < 4]
    assert len(corridor_doors) == 2 and corridor_windows == []
    # A single line *without* a door arc is still read as a window.
    top_windows = [w for w in plan.windows if abs(opening_span_px(plan, w)[3] - 100) < 4]
    assert len(top_windows) == 1


# ---- report ------------------------------------------------------------------------------------

def test_assembly_warnings_are_reported_once(monkeypatch):
    real_assemble = pipeline.assemble

    def assemble_with_warning(*args, **kwargs):
        out = real_assemble(*args, **kwargs)
        out.warnings.append("1 possible room left out: not enough evidence to add it reliably.")
        return out

    monkeypatch.setattr(pipeline, "assemble", assemble_with_warning)
    image = cv2.imread(str(SAMPLE), cv2.IMREAD_GRAYSCALE)
    warnings = run(image).report.warnings
    assert warnings.count("1 possible room left out: not enough evidence to add it reliably.") == 1
    assert len(warnings) == len(set(warnings))
