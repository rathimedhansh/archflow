"""Local-disk storage for property projects and their public share snapshots (Milestone 7).

Layout:
    <storage_dir>/projects/<id>/project.json   the project record (name, address, linked floor plan, share token)
    <storage_dir>/shares/<token>.json          the published, read-only snapshot a buyer's link opens

A share is a *snapshot*: publishing copies the saved floor plan into the share file, so later edits in
the editor never reach buyers until the developer publishes again. The public file holds only what a
buyer should see (no floor-plan id, no image, no project id), so a share link grants no access to
anything editable. Revoking deletes the file; the link then stops working.

Ids are server-generated (uuid4 hex) and share tokens are random (`secrets.token_urlsafe`); both are
strictly validated on lookup, so a client can never influence a filesystem path.
"""

import json
import re
import secrets
import shutil
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

from app.errors import InvalidStructure, NotFound

_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ShareInfo:
    token: str
    published_at: str


@dataclass(frozen=True)
class ProjectRecord:
    id: str
    name: str
    address: str = ""
    description: str = ""
    floorplan_id: str | None = None
    share: ShareInfo | None = None
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)


def _record_from_json(text: str) -> ProjectRecord:
    data = json.loads(text)
    share = data.pop("share", None)
    return ProjectRecord(**data, share=ShareInfo(**share) if share else None)


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)  # never leaves a half-written file


class ProjectStore:
    def __init__(self, root: Path):
        self._projects = root / "projects"
        self._shares = root / "shares"
        self._projects.mkdir(parents=True, exist_ok=True)
        self._shares.mkdir(parents=True, exist_ok=True)

    # ---- projects ---------------------------------------------------------------------------

    def _dir(self, project_id: str) -> Path:
        if not _ID_RE.fullmatch(project_id):
            raise NotFound("Project not found.")
        return self._projects / project_id

    def create(self, *, name: str, address: str = "", description: str = "") -> ProjectRecord:
        record = ProjectRecord(id=uuid.uuid4().hex, name=name, address=address, description=description)
        directory = self._dir(record.id)
        directory.mkdir()
        self._save(record)
        return record

    def _save(self, record: ProjectRecord) -> None:
        _write_atomic(self._dir(record.id) / "project.json", json.dumps(asdict(record)))

    def get(self, project_id: str) -> ProjectRecord:
        path = self._dir(project_id) / "project.json"
        if not path.is_file():
            raise NotFound("Project not found.")
        try:
            return _record_from_json(path.read_text(encoding="utf-8"))
        except (ValueError, TypeError):
            raise InvalidStructure("This project's saved data is damaged and cannot be opened.") from None

    def list(self) -> list[ProjectRecord]:
        """All readable projects, most recently updated first. Damaged records are skipped."""
        out: list[ProjectRecord] = []
        for directory in self._projects.iterdir():
            if not directory.is_dir() or not _ID_RE.fullmatch(directory.name):
                continue
            try:
                out.append(self.get(directory.name))
            except (NotFound, InvalidStructure):
                continue
        return sorted(out, key=lambda r: (r.updated_at, r.id), reverse=True)

    def update(self, project_id: str, **changes: object) -> ProjectRecord:
        record = replace(self.get(project_id), **changes, updated_at=now_iso())  # type: ignore[arg-type]
        self._save(record)
        return record

    def delete(self, project_id: str) -> ProjectRecord:
        record = self.get(project_id)
        if record.share:
            self._share_path(record.share.token).unlink(missing_ok=True)
        shutil.rmtree(self._dir(project_id))
        return record

    # ---- shares -----------------------------------------------------------------------------

    def _share_path(self, token: str) -> Path:
        if not _TOKEN_RE.fullmatch(token):
            raise NotFound("This property link does not exist or has been switched off.")
        return self._shares / f"{token}.json"

    def publish(self, project_id: str, snapshot: dict) -> ProjectRecord:
        """Write the public snapshot. Keeps the existing link when republishing."""
        record = self.get(project_id)
        token = record.share.token if record.share else secrets.token_urlsafe(18)
        published_at = now_iso()
        _write_atomic(self._share_path(token), json.dumps({**snapshot, "published_at": published_at}))
        return self.update(project_id, share=ShareInfo(token=token, published_at=published_at))

    def unpublish(self, project_id: str) -> ProjectRecord:
        record = self.get(project_id)
        if record.share:
            self._share_path(record.share.token).unlink(missing_ok=True)
        return self.update(project_id, share=None)

    def load_share(self, token: str) -> dict:
        path = self._share_path(token)
        if not path.is_file():
            raise NotFound("This property link does not exist or has been switched off.")
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            raise InvalidStructure("This shared property is damaged and cannot be shown.") from None
