from fastapi import APIRouter, Depends
from pydantic import ValidationError

from app.api.floorplans import get_store
from app.errors import InvalidImage, InvalidStructure
from app.interpretation import Interpreter, get_interpreter
from app.schema import FloorPlan
from app.storage.floorplans import FloorPlanStore

router = APIRouter(prefix="/floorplans", tags=["structure"])


@router.get("/{plan_id}/structure", response_model=FloorPlan)
def get_structure(
    plan_id: str,
    store: FloorPlanStore = Depends(get_store),
    interpreter: Interpreter = Depends(get_interpreter),
) -> FloorPlan:
    """The saved structured plan, or a fresh one from the active interpreter."""
    record = store.get(plan_id)
    saved = store.load_structure(plan_id)
    if saved is not None:
        try:
            return FloorPlan.model_validate_json(saved)
        except ValidationError:
            # A readable 422 instead of a 500, so the editor/viewer can explain what happened.
            raise InvalidStructure(
                "The saved floor plan is damaged or in an unsupported format, so it cannot be opened."
            ) from None
    return interpreter.interpret(store.image_path(plan_id), record)


@router.put("/{plan_id}/structure", response_model=FloorPlan)
def put_structure(
    plan_id: str, plan: FloorPlan, store: FloorPlanStore = Depends(get_store)
) -> FloorPlan:
    record = store.get(plan_id)
    src = plan.source
    if (src.floorplan_id, src.width_px, src.height_px) != (plan_id, record.width, record.height):
        raise InvalidImage("Structured plan does not match the uploaded image.")
    store.save_structure(plan_id, plan.model_dump_json())
    return plan
