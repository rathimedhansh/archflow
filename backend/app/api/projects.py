"""Property projects (Milestone 7): a named property with one floor plan, and a public share link.

A project wraps the existing floor-plan pipeline without changing it: the plan is still uploaded,
detected, edited and saved through the `/api/floorplans/...` endpoints. The project adds a name, an
address and a description, remembers which floor plan belongs to it, summarises the saved plan for
the dashboard, and publishes a read-only snapshot for buyers (`/api/share/{token}`).
"""

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, ValidationError, field_validator

from app.api.floorplans import get_store
from app.config import settings
from app.errors import Conflict, InvalidStructure, NotFound
from app.schema import FloorPlan
from app.schema.geometry import polygon_area
from app.storage.floorplans import FloorPlanStore
from app.storage.projects import ProjectRecord, ProjectStore

router = APIRouter(tags=["projects"])

SHARED_SOURCE_ID = "shared"  # replaces the floor-plan id in public snapshots: a link grants no edit access


def get_project_store() -> ProjectStore:
    return ProjectStore(settings.storage_dir)


# ---- request / response models ---------------------------------------------------------------

class _ProjectFields(BaseModel):
    model_config = {"extra": "forbid"}

    @field_validator("name", "address", mode="before", check_fields=False)
    @classmethod
    def _one_line(cls, v: object) -> object:
        return " ".join(v.split()) if isinstance(v, str) else v  # collapse whitespace, no line breaks

    @field_validator("description", mode="before", check_fields=False)
    @classmethod
    def _strip(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v


class ProjectCreate(_ProjectFields):
    name: str = Field(min_length=1, max_length=120)
    address: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=2000)


class ProjectUpdate(_ProjectFields):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    address: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class AttachFloorPlan(BaseModel):
    model_config = {"extra": "forbid"}
    floorplan_id: str


class FloorPlanInfo(BaseModel):
    id: str
    original_filename: str
    width: int
    height: int
    image_url: str


class PlanSummary(BaseModel):
    """Facts about the saved plan, for the dashboard and the project page."""

    saved: bool
    saved_at: str | None = None
    damaged: bool = False
    auto_detected: bool = False  # an automatic result exists for this image
    provenance: str | None = None
    calibrated: bool = False
    walls: int = 0
    rooms: int = 0
    doors: int = 0
    windows: int = 0
    floor_area_m2: float = 0.0


class ShareSummary(BaseModel):
    token: str
    url_path: str
    published_at: str
    up_to_date: bool  # the published snapshot equals the currently saved plan


class ProjectResponse(BaseModel):
    id: str
    name: str
    address: str
    description: str
    created_at: str
    updated_at: str
    floorplan: FloorPlanInfo | None
    plan: PlanSummary | None
    share: ShareSummary | None


class SharedProperty(BaseModel):
    name: str
    address: str
    description: str


class SharedPropertyResponse(BaseModel):
    """What a buyer's link returns: the property and its plan, nothing editable."""

    property: SharedProperty
    plan: FloorPlan
    published_at: str


# ---- helpers ---------------------------------------------------------------------------------

def _saved_plan(plans: FloorPlanStore, floorplan_id: str) -> FloorPlan | None:
    raw = plans.load_structure(floorplan_id)
    if raw is None:
        return None
    try:
        return FloorPlan.model_validate_json(raw)
    except ValidationError:
        raise InvalidStructure("The saved floor plan is damaged or in an unsupported format.") from None


def _public_plan(plan: FloorPlan) -> dict:
    data = plan.model_dump(mode="json")
    data["source"]["floorplan_id"] = SHARED_SOURCE_ID
    return data


def _public_property(record: ProjectRecord) -> dict:
    return {"name": record.name, "address": record.address, "description": record.description}


def _summary(plans: FloorPlanStore, floorplan_id: str) -> tuple[PlanSummary, FloorPlan | None]:
    auto = plans.load_interpretation(floorplan_id) is not None
    try:
        plan = _saved_plan(plans, floorplan_id)
    except InvalidStructure:
        return PlanSummary(saved=True, damaged=True, auto_detected=auto, saved_at=plans.structure_saved_at(floorplan_id)), None
    if plan is None:
        return PlanSummary(saved=False, auto_detected=auto), None
    return PlanSummary(
        saved=True, saved_at=plans.structure_saved_at(floorplan_id), auto_detected=auto, provenance=plan.provenance,
        calibrated=plan.scale.calibrated, walls=len(plan.walls), rooms=len(plan.rooms), doors=len(plan.doors),
        windows=len(plan.windows), floor_area_m2=round(sum(polygon_area(r.polygon) for r in plan.rooms), 2),
    ), plan


def _response(record: ProjectRecord, plans: FloorPlanStore, projects: ProjectStore) -> ProjectResponse:
    floorplan = summary = None
    current: FloorPlan | None = None
    if record.floorplan_id:
        try:
            fp = plans.get(record.floorplan_id)
            floorplan = FloorPlanInfo(id=fp.id, original_filename=fp.original_filename, width=fp.width, height=fp.height,
                                      image_url=f"/api/floorplans/{fp.id}/image")
            summary, current = _summary(plans, fp.id)
        except NotFound:
            pass  # the plan's files are gone: show the project as having no plan
    share = None
    if record.share:
        try:
            published = projects.load_share(record.share.token)
            up_to_date = (current is not None and published.get("plan") == _public_plan(current)
                          and published.get("property") == _public_property(record))
        except (NotFound, InvalidStructure):
            up_to_date = False
        share = ShareSummary(token=record.share.token, url_path=f"/share/{record.share.token}",
                             published_at=record.share.published_at, up_to_date=up_to_date)
    return ProjectResponse(
        id=record.id, name=record.name, address=record.address, description=record.description,
        created_at=record.created_at, updated_at=record.updated_at, floorplan=floorplan, plan=summary, share=share,
    )


# ---- endpoints -------------------------------------------------------------------------------

@router.post("/projects", response_model=ProjectResponse, status_code=201)
def create_project(
    body: ProjectCreate, projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> ProjectResponse:
    record = projects.create(name=body.name, address=body.address, description=body.description)
    return _response(record, plans, projects)


@router.get("/projects", response_model=list[ProjectResponse])
def list_projects(
    projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> list[ProjectResponse]:
    return [_response(r, plans, projects) for r in projects.list()]


@router.get("/projects/{project_id}", response_model=ProjectResponse)
def get_project(
    project_id: str, projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> ProjectResponse:
    return _response(projects.get(project_id), plans, projects)


@router.patch("/projects/{project_id}", response_model=ProjectResponse)
def update_project(
    project_id: str, body: ProjectUpdate,
    projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> ProjectResponse:
    changes = body.model_dump(exclude_none=True)
    record = projects.update(project_id, **changes) if changes else projects.get(project_id)
    return _response(record, plans, projects)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str, projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> Response:
    record = projects.delete(project_id)  # also switches off its share link
    if record.floorplan_id:
        plans.delete(record.floorplan_id)
    return Response(status_code=204)


@router.put("/projects/{project_id}/floorplan", response_model=ProjectResponse)
def attach_floorplan(
    project_id: str, body: AttachFloorPlan,
    projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> ProjectResponse:
    record = projects.get(project_id)
    fp = plans.get(body.floorplan_id)
    if fp.project_id not in (None, project_id):
        raise Conflict("This floor plan already belongs to another project.")
    if record.floorplan_id and record.floorplan_id != fp.id:
        try:
            plans.set_project(record.floorplan_id, None)  # the replaced plan stays on disk, unlinked
        except NotFound:
            pass
    plans.set_project(fp.id, project_id)
    return _response(projects.update(project_id, floorplan_id=fp.id), plans, projects)


@router.post("/projects/{project_id}/share", response_model=ProjectResponse)
def publish_share(
    project_id: str, projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> ProjectResponse:
    """Publish (or update) the buyer page with the currently saved plan. The link stays the same."""
    record = projects.get(project_id)
    if not record.floorplan_id:
        raise Conflict("Upload a floor plan before sharing this property.")
    plans.get(record.floorplan_id)
    plan = _saved_plan(plans, record.floorplan_id)
    if plan is None:
        raise Conflict("Save the floor plan in the editor before sharing it.")
    if not plan.walls and not plan.rooms:
        raise Conflict("The saved floor plan is empty. Add walls and rooms before sharing it.")
    snapshot = {"property": _public_property(record), "plan": _public_plan(plan)}
    return _response(projects.publish(project_id, snapshot), plans, projects)


@router.delete("/projects/{project_id}/share", response_model=ProjectResponse)
def unpublish_share(
    project_id: str, projects: ProjectStore = Depends(get_project_store), plans: FloorPlanStore = Depends(get_store),
) -> ProjectResponse:
    return _response(projects.unpublish(project_id), plans, projects)


@router.get("/share/{token}", response_model=SharedPropertyResponse)
def get_shared_property(token: str, projects: ProjectStore = Depends(get_project_store)) -> SharedPropertyResponse:
    """Public, read-only. Anyone with the link can view; nothing here can change a project."""
    data = projects.load_share(token)
    try:
        return SharedPropertyResponse.model_validate(data)
    except ValidationError:
        raise InvalidStructure("This shared property is damaged and cannot be shown.") from None
