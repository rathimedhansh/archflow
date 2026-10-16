"""Developer sign-in: one shared password configured by the operator (README "Sign-in").

Sessions are signed cookies (HttpOnly, SameSite=Lax, Secure in production). These routes are public;
attempts are rate limited (per client and overall) and CSRF-checked by the security middleware.

A password check is expensive on purpose (scrypt: ~32 MiB and a worker thread for a fraction of a
second), so at most `max_concurrent_logins` run at once and extra attempts are refused immediately.
The delay after a wrong password is an async sleep: it holds neither a worker thread nor a check slot.
"""

import asyncio

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.config import settings
from app.errors import Conflict, InvalidCredentials, ServerBusy
from app.security import sessions
from app.security.limits import login_slots
from app.security.passwords import MAX_PASSWORD_LENGTH, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

FAILURE_DELAY_S = 0.5  # the same for every wrong password; slows guessing further


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class AuthStatus(BaseModel):
    auth_enabled: bool
    authenticated: bool


def _authenticated(request: Request) -> bool:
    return sessions.verify(settings, request.cookies.get(sessions.COOKIE_NAME)) is not None


@router.get("/me", response_model=AuthStatus)
def me(request: Request, response: Response) -> AuthStatus:
    response.headers["Cache-Control"] = "no-store"
    enabled = settings.auth_enabled
    return AuthStatus(auth_enabled=enabled, authenticated=enabled and _authenticated(request))


@router.post("/login", response_model=AuthStatus)
async def login(body: LoginRequest, response: Response) -> AuthStatus:
    if not settings.auth_enabled:
        raise Conflict("Sign-in is not enabled on this server.")
    slot = login_slots.try_acquire(settings.max_concurrent_logins)
    if slot is None:
        raise ServerBusy("Too many sign-in attempts are being checked right now. Please try again in a moment.", retry_after=2)
    try:
        ok = await run_in_threadpool(verify_password, body.password, settings.admin_password_hash.get_secret_value())
    finally:
        slot.release()
    if not ok:
        await asyncio.sleep(FAILURE_DELAY_S)
        raise InvalidCredentials("That password is not correct.")
    response.headers["Set-Cookie"] = sessions.cookie_header(settings, sessions.issue(settings))
    response.headers["Cache-Control"] = "no-store"
    return AuthStatus(auth_enabled=True, authenticated=True)


@router.post("/logout", status_code=204)
def logout() -> Response:
    # Sessions are stateless: signing out removes this browser's cookie. To end every session,
    # change ARCHFLOW_SESSION_SECRET (or the password hash) and restart.
    return Response(status_code=204, headers={"Set-Cookie": sessions.clear_cookie_header(settings)})
