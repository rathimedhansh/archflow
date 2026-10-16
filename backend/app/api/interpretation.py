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

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from app.api.floorplans import get_store
from app.errors import InvalidStructure, NotFound
from app.interpretation.opencv import StageEvent, run_path_stages
from app.schema.interpretation import Interpretation
from app.storage.floorplans import FloorPlanStore

router = APIRouter(prefix="/floorplans", tags=["interpretation"])
log = logging.getLogger(__name__)


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


@router.post("/{plan_id}/interpret")
def interpret(plan_id: str, store: FloorPlanStore = Depends(get_store)) -> StreamingResponse:
    record = store.get(plan_id)  # 404 before the stream starts
    path = store.image_path(plan_id)

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

    # no-transform/no-buffering: proxies must pass progress lines through as they are produced.
    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


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
