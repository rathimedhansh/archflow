"""The automatic interpretation pipeline: stages in order, each reporting what it found.

    image -> preprocess -> walls -> rooms -> doors/windows -> scale -> FloorPlan

`run_stages` is a generator: it yields a `StageEvent` when each stage starts and finishes
(so the API can stream real progress) and finally an `Interpretation`. It never raises for
bad input: an unsupported or unreadable drawing yields an explained, empty result.
"""

import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np

from app.interpretation.opencv.assemble import assemble
from app.interpretation.opencv.openings import detect_openings
from app.interpretation.opencv.preprocess import load_image, preprocess
from app.interpretation.opencv.rooms import detect_rooms
from app.interpretation.opencv.scale import ASSUMED_IMAGE_WIDTH_M, estimate_scale
from app.interpretation.opencv.types import Unsupported
from app.interpretation.opencv.walls import detect_walls
from app.schema import FloorPlan, Scale, SourceImage
from app.schema.interpretation import Interpretation, InterpretationReport, ScaleReport, StageReport

PIPELINE_VERSION = "opencv-1"
log = logging.getLogger(__name__)

STAGES: dict[str, str] = {
    "preprocess": "Analyzing floor plan",
    "walls": "Detecting walls",
    "rooms": "Detecting rooms",
    "openings": "Detecting doors & windows",
    "scale": "Estimating scale",
    "assemble": "Building floor plan",
}


@dataclass(frozen=True)
class StageEvent:
    stage: str
    label: str
    status: Literal["started", "done"]
    summary: str = ""
    ms: float = 0.0


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _empty_result(reason: str, stages: list[StageReport], *, floorplan_id: str, width_px: int, height_px: int) -> Interpretation:
    plan = FloorPlan(
        provenance="opencv",
        source=SourceImage(floorplan_id=floorplan_id, width_px=width_px, height_px=height_px),
        scale=Scale(meters_per_pixel=ASSUMED_IMAGE_WIDTH_M / width_px, calibrated=False),
    )
    report = InterpretationReport(
        pipeline_version=PIPELINE_VERSION, supported=False, reason=reason, overall_confidence=0.0, stages=stages,
        warnings=["Nothing was generated automatically. You can still trace the plan by hand in the editor."],
    )
    return Interpretation(plan=plan, report=report)


def run_stages(image: np.ndarray, *, floorplan_id: str, width_px: int, height_px: int) -> Iterator[StageEvent | Interpretation]:
    stages: list[StageReport] = []
    warnings: list[str] = []
    ids = dict(floorplan_id=floorplan_id, width_px=width_px, height_px=height_px)

    def timed(name: str, fn, summarize):  # type: ignore[no-untyped-def]
        t0 = time.perf_counter()
        result = fn()
        ms = round((time.perf_counter() - t0) * 1000, 1)
        summary = summarize(result)
        stages.append(StageReport(name=name, label=STAGES[name], summary=summary, ms=ms))
        warnings.extend(getattr(result, "warnings", ()))
        return result, StageEvent(name, STAGES[name], "done", summary, ms)

    try:
        yield StageEvent("preprocess", STAGES["preprocess"], "started")
        pre, ev = timed("preprocess", lambda: preprocess(image), lambda p: f"{p.gray.shape[1]}×{p.gray.shape[0]} px working image")
        yield ev

        yield StageEvent("walls", STAGES["walls"], "started")
        walls, ev = timed("walls", lambda: detect_walls(pre), lambda w: _plural(len(w.walls), "wall") + f", ~{w.thickness_px:.0f} px thick")
        yield ev

        yield StageEvent("rooms", STAGES["rooms"], "started")
        rooms, ev = timed("rooms", lambda: detect_rooms(pre, walls), lambda r: _plural(len(r.rooms), "room"))
        yield ev

        yield StageEvent("openings", STAGES["openings"], "started")
        openings, ev = timed(
            "openings", lambda: detect_openings(pre, walls),
            lambda o: f"{_plural(len(o.doors), 'door')}, {_plural(len(o.windows), 'window')}"
            + (f", {_plural(len(o.unknown), 'unidentified opening')}" if o.unknown else ""),
        )
        yield ev

        yield StageEvent("scale", STAGES["scale"], "started")
        scale, ev = timed(
            "scale", lambda: estimate_scale(pre, openings, walls.thickness_px, width_px),
            lambda s: f"≈ {1 / s.meters_per_pixel:.0f} px per metre ({'from doors' if s.source == 'doors' else 'assumed'})",
        )
        yield ev

        yield StageEvent("assemble", STAGES["assemble"], "started")
        built, ev = timed(
            "assemble", lambda: assemble(pre, walls, rooms, openings, scale, **ids),
            lambda a: f"{_plural(len(a.plan.walls), 'wall')}, {_plural(len(a.plan.rooms), 'room')}, "
            f"{_plural(len(a.plan.doors), 'door')}, {_plural(len(a.plan.windows), 'window')}",
        )
        yield ev
    except Unsupported as exc:
        yield _empty_result(exc.reason, stages, **ids)
        return
    except Exception:  # a bug must never turn into a 500 or a fake plan
        log.exception("OpenCV interpretation failed")
        yield _empty_result("The automatic detector could not process this image.", stages, **ids)
        return

    confidences = [e.confidence for e in built.elements]
    overall = float(np.mean(confidences)) if confidences else 0.0
    overall *= 1 - 0.5 * walls.unexplained_ratio
    if not built.plan.rooms:
        overall *= 0.6
    report = InterpretationReport(
        pipeline_version=PIPELINE_VERSION,
        supported=True,
        overall_confidence=round(max(0.0, min(1.0, overall)), 3),
        stages=stages,
        elements=built.elements,
        scale=ScaleReport(meters_per_pixel=scale.meters_per_pixel, source=scale.source, confidence=scale.confidence, detail=scale.detail),
        warnings=warnings,  # already includes every stage's warnings, assembly's too (see `timed`)
        omitted={k: v for k, v in built.omitted.items() if v},
    )
    yield Interpretation(plan=built.plan, report=report)


def interpret_image(image: np.ndarray, *, floorplan_id: str, width_px: int, height_px: int) -> Interpretation:
    """Run the whole pipeline and return only the final result."""
    result = None
    for item in run_stages(image, floorplan_id=floorplan_id, width_px=width_px, height_px=height_px):
        if isinstance(item, Interpretation):
            result = item
    assert result is not None
    return result


def run_path_stages(path: Path, *, floorplan_id: str, width_px: int, height_px: int) -> Iterator[StageEvent | Interpretation]:
    """`run_stages` for an image file; an unreadable file yields an explained empty result."""
    try:
        image = load_image(path)
    except Unsupported as exc:
        yield _empty_result(exc.reason, [], floorplan_id=floorplan_id, width_px=width_px, height_px=height_px)
        return
    yield from run_stages(image, floorplan_id=floorplan_id, width_px=width_px, height_px=height_px)


def interpret_path(path: Path, *, floorplan_id: str, width_px: int, height_px: int) -> Interpretation:
    result = None
    for item in run_path_stages(path, floorplan_id=floorplan_id, width_px=width_px, height_px=height_px):
        if isinstance(item, Interpretation):
            result = item
    assert result is not None
    return result
