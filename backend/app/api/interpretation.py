"""Automatic interpretation of an uploaded plan (Milestone 6).

POST streams real progress as NDJSON (one JSON object per line) while the CV pipeline runs:

    {"type": "stage", "stage": "walls", "label": "Detecting walls", "status": "started", ...}
    {"type": "stage", "stage": "walls", "label": "Detecting walls", "status": "done", "summary": "9 walls", "ms": 41.2}
    ...
    {"type": "result", "interpretation": {"plan": FloorPlan, "report": InterpretationReport}}

The result is stored as a *proposal* (`interpretation.json`). It never overwrites the plan the
user saved: the user reviews it in the editor and saves it like any hand-made plan.
"""

import json
import logging
from collections.abc import Iterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from starlette.background import BackgroundTask

from app.api.floorplans import get_store
from app.config import settings
from app.errors import InvalidStructure, NotFound, ServerBusy
from app.interpretation.opencv import StageEvent, run_path_stages
from app.processing.image_intake import too_large
from app.schema.interpretation import Interpretation
from app.security.limits import enforce, interpretation_slots
from app.storage.floorplans import FloorPlanStore

router = APIRouter(prefix="/floorplans", tags=["interpretation"])
log = logging.getLogger(__name__)


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


@router.post("/{plan_id}/interpret")
def interpret(plan_id: str, request: Request, store: FloorPlanStore = Depends(get_store)) -> StreamingResponse:
    # Cheapest refusals first; none of them uses the detection budget or a detection slot.
    record = store.get(plan_id)  # 404 before the stream starts
    path = store.image_path(plan_id)
    if record.width * record.height > settings.max_image_pixels:  # e.g. a plan stored before the 20 MP limit
        raise too_large(record.width * record.height, (record.width, record.height))
    if settings.rate_limits_enabled:
        client = request.client.host if request.client else "unknown"
        enforce("interpret", client, settings.rate_interpret_per_minute, 60.0, "automatic detections")
    # The CV pipeline is CPU- and memory-heavy: answer 503 now rather than queue runs that could exhaust memory.
    slot = interpretation_slots.try_acquire(settings.max_concurrent_interpretations)
    if slot is None:
        raise ServerBusy("Automatic detection is busy with another plan. Please try again in a few seconds.", retry_after=10)

    def events() -> Iterator[bytes]:
        try:
            for item in run_path_stages(path, floorplan_id=record.id, width_px=record.width, height_px=record.height):
                if isinstance(item, StageEvent):
                    yield _line({"type": "stage", "stage": item.stage, "label": item.label, "status": item.status,
                                 "summary": item.summary, "ms": item.ms})
                else:
                    store.save_interpretation(plan_id, item.model_dump_json())
                    yield _line({"type": "result", "interpretation": item.model_dump(mode="json")})
        except Exception:  # headers are already sent: report in-band instead of a broken stream
            log.exception("Interpretation stream failed")
            yield _line({"type": "error", "message": "Automatic detection failed unexpectedly. You can still trace the plan by hand."})
        finally:
            slot.release()

    # no-transform/no-buffering: proxies must pass progress lines through as they are produced.
    # The background task frees the slot too if the stream never starts (client gone); release is idempotent.
    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
                             background=BackgroundTask(slot.release))


@router.get("/{plan_id}/interpretation", response_model=Interpretation)
def get_interpretation(plan_id: str, store: FloorPlanStore = Depends(get_store)) -> Interpretation:
    """The last automatic result for this plan (proposal + report)."""
    store.get(plan_id)
    raw = store.load_interpretation(plan_id)
    if raw is None:
        raise NotFound("This plan has not been analysed automatically yet.")
    try:
        return Interpretation.model_validate_json(raw)
    except ValidationError:
        raise InvalidStructure("The stored automatic result is damaged or from an older version. Run Auto Generate again.") from None
