"""Domain errors that map to clean, machine-readable API responses."""

from fastapi import Request
from fastapi.responses import JSONResponse


class ArchflowError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class UnsupportedFileType(ArchflowError):
    status_code = 415
    code = "unsupported_file_type"


class FileTooLarge(ArchflowError):
    status_code = 413
    code = "file_too_large"


class InvalidImage(ArchflowError):
    status_code = 422
    code = "invalid_image"


class InvalidStructure(ArchflowError):
    """A stored structured plan that no longer passes the schema (corrupt or edited on disk)."""

    status_code = 422
    code = "invalid_structure"


class Conflict(ArchflowError):
    """The request is valid but the resource is not in a state that allows it (e.g. sharing an unsaved plan)."""

    status_code = 409
    code = "conflict"


class NotFound(ArchflowError):
    status_code = 404
    code = "not_found"


async def archflow_error_handler(_: Request, exc: ArchflowError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )
