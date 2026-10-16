from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings
from app.errors import FileTooLarge, InvalidImage
from app.processing.image_intake import normalize_upload
from app.storage.floorplans import FloorPlanRecord, FloorPlanStore

router = APIRouter(prefix="/floorplans", tags=["floorplans"])

_CHUNK = 1024 * 1024


def get_store() -> FloorPlanStore:
    return FloorPlanStore(settings.storage_dir)


class FloorPlanResponse(BaseModel):
    id: str
    original_filename: str
    source_format: str
    width: int
    height: int
    size_bytes: int
    status: str
    created_at: str
    project_id: str | None = None
    image_url: str

    @classmethod
    def from_record(cls, r: FloorPlanRecord) -> "FloorPlanResponse":
        return cls(**r.__dict__, image_url=f"/api/floorplans/{r.id}/image")


async def _read_limited(file: UploadFile, limit_bytes: int) -> bytes:
    """Read the upload in chunks, aborting as soon as the limit is exceeded."""
    buf = bytearray()
    while chunk := await file.read(_CHUNK):
        buf.extend(chunk)
        if len(buf) > limit_bytes:
            raise FileTooLarge(f"File exceeds the {settings.max_upload_mb} MB limit.")
    return bytes(buf)


@router.post("", response_model=FloorPlanResponse, status_code=201)
async def upload_floorplan(
    file: UploadFile, store: FloorPlanStore = Depends(get_store)
) -> FloorPlanResponse:
    data = await _read_limited(file, settings.max_upload_mb * 1024 * 1024)
    if not data:
        raise InvalidImage("The uploaded file is empty.")
    image = normalize_upload(data)
    record = store.create(
        png_bytes=image.png_bytes,
        original_filename=file.filename or "floorplan",
        source_format=image.source_format,
        width=image.width,
        height=image.height,
    )
    return FloorPlanResponse.from_record(record)


@router.get("/{plan_id}", response_model=FloorPlanResponse)
def get_floorplan(plan_id: str, store: FloorPlanStore = Depends(get_store)) -> FloorPlanResponse:
    return FloorPlanResponse.from_record(store.get(plan_id))


@router.get("/{plan_id}/image")
def get_floorplan_image(plan_id: str, store: FloorPlanStore = Depends(get_store)) -> FileResponse:
    return FileResponse(store.image_path(plan_id), media_type="image/png")
