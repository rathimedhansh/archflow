"""Door-based scale estimate (`scale.py`).

Real-world validation (Berlin P2 plan, docs/REAL_WORLD_VALIDATION.md) found a scale resting on a
single door that was itself a false detection: the model came out ~2.8× too small, yet the implied
7 cm walls passed the general 5-80 cm plausibility check. One door must agree with a normal wall
thickness more closely; several doors that agree with each other keep the wider range.
"""

import numpy as np
import pytest

from app.interpretation.opencv.scale import ASSUMED_IMAGE_WIDTH_M, STANDARD_DOOR_WIDTH_M, estimate_scale
from app.interpretation.opencv.types import Gap, Opening, OpeningDetection, Preprocessed

IMAGE_WIDTH = 651


def _pre() -> Preprocessed:
    blank = np.zeros((10, 10), np.uint8)
    return Preprocessed(gray=blank, ink=blank, symbols=blank, factor=1.0, ink_ratio=0.1, inverted=False)


def _doors(*widths_px: float) -> OpeningDetection:
    doors = tuple(Opening("door", Gap("w0", "h", 10.0, 0.0, w, 9.0), 0.8, "arc") for w in widths_px)
    return OpeningDetection(doors=doors, windows=(), unknown=())


def test_one_door_implying_implausibly_thin_walls_is_not_used():
    # The Berlin numbers: 9 px walls, one (false) 111 px door -> 130.5 px/m -> 6.9 cm walls.
    s = estimate_scale(_pre(), _doors(111.0), 9.0, IMAGE_WIDTH)
    assert s.source == "assumed"
    assert s.meters_per_pixel == pytest.approx(ASSUMED_IMAGE_WIDTH_M / IMAGE_WIDTH)
    assert "implausible" in s.detail


def test_one_door_with_plausible_walls_is_still_used():
    s = estimate_scale(_pre(), _doors(43.0), 6.0, IMAGE_WIDTH)  # real-apartment: ~13 cm walls
    assert s.source == "doors"
    assert s.meters_per_pixel == pytest.approx(STANDARD_DOOR_WIDTH_M / 43.0)


def test_several_agreeing_doors_keep_the_wider_plausibility_range():
    s = estimate_scale(_pre(), _doors(110.0, 111.0, 112.0), 9.0, IMAGE_WIDTH)  # same 6.9 cm walls, three doors
    assert s.source == "doors"
