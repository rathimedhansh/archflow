"""Stage 5: estimate the drawing scale.

A 2D drawing has no inherent scale, and this pipeline has no OCR, so it cannot read written
dimensions. The one reliable real-world reference it can see is doors: interior and entrance
doors are close to a standard width (typically 0.8-0.9 m). With detected doors the scale is
estimated from their median width; without doors it falls back to the same assumption as a
manually traced plan.

Either way the result is an *estimate*: the FloorPlan is always saved with
`calibrated = false`, and the editor asks the user to set the real scale.
"""

import statistics

from app.interpretation.opencv.types import OpeningDetection, Preprocessed, ScaleEstimate

STANDARD_DOOR_WIDTH_M = 0.85
ASSUMED_IMAGE_WIDTH_M = 12.0  # same fallback as the manual interpreter
PLAUSIBLE_WALL_M = (0.05, 0.8)
PLAUSIBLE_WALL_ONE_DOOR_M = (0.08, 0.5)  # the drawing's dominant walls; real partitions are at least ~8 cm


def estimate_scale(pre: Preprocessed, openings: OpeningDetection, wall_thickness_px: float, image_width_px: int) -> ScaleEstimate:
    widths = sorted(o.gap.width * pre.factor for o in openings.doors)
    assumed = ScaleEstimate(
        meters_per_pixel=ASSUMED_IMAGE_WIDTH_M / image_width_px,
        source="assumed",
        confidence=0.1,
        detail=f"No doors detected; assumed the image is about {ASSUMED_IMAGE_WIDTH_M:g} m wide.",
    )
    if not widths:
        return assumed

    median = statistics.median(widths)
    mpp = STANDARD_DOOR_WIDTH_M / median
    wall_m = wall_thickness_px * pre.factor * mpp
    # One door is weak evidence (it may itself be a false detection), so it must agree with a normal wall
    # thickness more closely than several doors that agree with each other.
    low, high = PLAUSIBLE_WALL_ONE_DOOR_M if len(widths) == 1 else PLAUSIBLE_WALL_M
    if not (low <= wall_m <= high):
        return ScaleEstimate(
            meters_per_pixel=assumed.meters_per_pixel, source="assumed", confidence=0.1,
            detail=(
                f"The door-based estimate gave implausible {wall_m:.2f} m thick walls, so it was not used; "
                f"assumed the image is about {ASSUMED_IMAGE_WIDTH_M:g} m wide."
            ),
        )
    spread = (widths[-1] - widths[0]) / median if len(widths) > 1 else 0.0
    confidence = max(0.2, min(0.8, 0.35 + 0.1 * min(len(widths), 4) - 0.5 * spread))
    return ScaleEstimate(
        meters_per_pixel=mpp,
        source="doors",
        confidence=round(confidence, 3),
        detail=(
            f"Estimated from {len(widths)} door{'s' if len(widths) > 1 else ''}, assuming a standard "
            f"{STANDARD_DOOR_WIDTH_M} m door width. Set the real scale in the editor to confirm."
        ),
    )
