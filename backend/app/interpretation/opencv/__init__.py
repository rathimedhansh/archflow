"""Automatic floor-plan interpretation with classical computer vision (OpenCV).

Stages (one module each, each returning typed intermediate data from `types.py`):
preprocess -> walls -> rooms -> openings -> scale -> assemble. See `pipeline.py`.
"""

from pathlib import Path

from app.interpretation.opencv.pipeline import (
    PIPELINE_VERSION, STAGES, StageEvent, interpret_image, interpret_path, run_path_stages, run_stages,
)
from app.schema import FloorPlan
from app.storage.floorplans import FloorPlanRecord


class OpenCVInterpreter:
    """`Interpreter` implementation: returns the detected plan (the report is available via `interpret_path`)."""

    name = "opencv"

    def interpret(self, image_path: Path, record: FloorPlanRecord) -> FloorPlan:
        return interpret_path(image_path, floorplan_id=record.id, width_px=record.width, height_px=record.height).plan


__all__ = [
    "OpenCVInterpreter", "PIPELINE_VERSION", "STAGES", "StageEvent", "interpret_image", "interpret_path",
    "run_path_stages", "run_stages",
]
