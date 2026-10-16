"""Local-disk storage for uploaded floor plans.

Layout:  <storage_dir>/floorplans/<id>/{plan.png, meta.json, structure.json?, interpretation.json?}

`structure.json` is the plan the user saved; `interpretation.json` is the last automatic
result (a proposal plus its report). The automatic result never overwrites a saved plan.

Ids are server-generated (uuid4 hex) and strictly validated on lookup, so a
client can never influence a filesystem path. Swap this class for an object
store (S3, etc.) later without touching the API layer.
"""

import json
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

from app.errors import NotFound

_ID_RE = re.compile(r"^[0-9a-f]{32}$")


@dataclass(frozen=True)
class FloorPlanRecord:
    id: str
    original_filename: str
    source_format: str
    width: int
    height: int
    size_bytes: int
    status: str  # "ready" for now; "processing"/"failed" once async CV lands
    created_at: str
    # The property project this plan belongs to (Milestone 7). None for plans uploaded on their own.
    project_id: str | None = None


class FloorPlanStore:
    def __init__(self, root: Path):
        self._root = root / "floorplans"
        self._root.mkdir(parents=True, exist_ok=True)

    def _dir(self, plan_id: str) -> Path:
        if not _ID_RE.fullmatch(plan_id):
            raise NotFound("Floor plan not found.")
        return self._root / plan_id

    def create(
        self,
        *,
        png_bytes: bytes,
        original_filename: str,
        source_format: str,
        width: int,
        height: int,
    ) -> FloorPlanRecord:
        plan_id = uuid.uuid4().hex
        record = FloorPlanRecord(
            id=plan_id,
            original_filename=_safe_display_name(original_filename),
            source_format=source_format,
            width=width,
            height=height,
            size_bytes=len(png_bytes),
            status="ready",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        directory = self._dir(plan_id)
        directory.mkdir()
        (directory / "plan.png").write_bytes(png_bytes)
        (directory / "meta.json").write_text(json.dumps(asdict(record)), encoding="utf-8")
        return record

    def get(self, plan_id: str) -> FloorPlanRecord:
        meta = self._dir(plan_id) / "meta.json"
        if not meta.is_file():
            raise NotFound("Floor plan not found.")
        return FloorPlanRecord(**json.loads(meta.read_text(encoding="utf-8")))

    def set_project(self, plan_id: str, project_id: str | None) -> FloorPlanRecord:
        record = replace(self.get(plan_id), project_id=project_id)
        meta = self._dir(plan_id) / "meta.json"
        tmp = meta.with_name("meta.json.tmp")
        tmp.write_text(json.dumps(asdict(record)), encoding="utf-8")
        tmp.replace(meta)
        return record

    def delete(self, plan_id: str) -> None:
        directory = self._dir(plan_id)
        if directory.is_dir():
            shutil.rmtree(directory)

    def structure_saved_at(self, plan_id: str) -> str | None:
        path = self._dir(plan_id) / "structure.json"
        if not path.is_file():
            return None
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()

    def load_structure(self, plan_id: str) -> str | None:
        """Raw JSON of the saved structured plan, or None. Storage stays schema-agnostic."""
        path = self._dir(plan_id) / "structure.json"
        return path.read_text(encoding="utf-8") if path.is_file() else None

    def save_structure(self, plan_id: str, json_text: str) -> None:
        directory = self._dir(plan_id)
        if not directory.is_dir():
            raise NotFound("Floor plan not found.")
        tmp = directory / "structure.json.tmp"
        tmp.write_text(json_text, encoding="utf-8")
        tmp.replace(directory / "structure.json")  # atomic: never leaves a half-written file

    def load_interpretation(self, plan_id: str) -> str | None:
        """Raw JSON of the last automatic interpretation (plan + report), or None."""
        path = self._dir(plan_id) / "interpretation.json"
        return path.read_text(encoding="utf-8") if path.is_file() else None

    def save_interpretation(self, plan_id: str, json_text: str) -> None:
        directory = self._dir(plan_id)
        if not directory.is_dir():
            raise NotFound("Floor plan not found.")
        tmp = directory / "interpretation.json.tmp"
        tmp.write_text(json_text, encoding="utf-8")
        tmp.replace(directory / "interpretation.json")

    def image_path(self, plan_id: str) -> Path:
        path = self._dir(plan_id) / "plan.png"
        if not path.is_file():
            raise NotFound("Floor plan not found.")
        return path


def _safe_display_name(name: str) -> str:
    """Keep only a short, printable basename for display; never used as a path."""
    base = Path(name.replace("\\", "/")).name
    cleaned = "".join(c for c in base if c.isprintable())[:120]
    return cleaned or "floorplan"
