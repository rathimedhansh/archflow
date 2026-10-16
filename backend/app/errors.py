"""Domain errors that map to clean, machine-readable API responses."""

from fastapi import Request
from fastapi.responses import JSONResponse


class ArchflowError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, retry_after: int | None = None):
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after


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


class Unauthorized(ArchflowError):
    """No valid developer session (sign-in is on and the request is not public)."""

    status_code = 401
    code = "unauthorized"


class InvalidCredentials(ArchflowError):
    status_code = 401
    code = "invalid_credentials"


class CsrfRejected(ArchflowError):
    """A state-changing request without the X-ARCHFLOW-CSRF header (possible cross-site request)."""

    status_code = 403
    code = "csrf_failed"


class LocalOnly(ArchflowError):
    """A development-mode server was reached from another machine (or through a proxy)."""

    status_code = 403
    code = "local_only"


class RateLimited(ArchflowError):
    status_code = 429
    code = "rate_limited"


class ServerBusy(ArchflowError):
    """All processing slots for this kind of work are taken; retry shortly."""

    status_code = 503
    code = "busy"


def error_response(exc: ArchflowError) -> JSONResponse:
    headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else None
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers=headers,
    )


async def archflow_error_handler(_: Request, exc: ArchflowError) -> JSONResponse:
    return error_response(exc)
