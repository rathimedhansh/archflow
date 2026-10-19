"""Two ASGI middlewares that guard every request. Order in the app (outermost first):
LocalOnlyMiddleware -> CORSMiddleware -> SecurityMiddleware -> routes.

0. Local only in development (LocalOnlyMiddleware, outermost): with ARCHFLOW_ENV=development (the
   default) the server answers only loopback clients (127.0.0.0/8, ::1) and refuses everyone else with
   403 on every path and method, CORS preflights included, whatever the sign-in settings. A server
   started without its production settings therefore exposes nothing to the network. Local browsers,
   and a Quest using `adb reverse` (which arrives over loopback), work as before.
Then, for /api requests (SecurityMiddleware, inside CORS):
1. CSRF: when sign-in is on, a state-changing request (POST/PUT/PATCH/DELETE) must carry
   `X-ARCHFLOW-CSRF: 1`. A form or script on another site cannot add that header without a CORS
   preflight, which the API refuses for origins it does not list.
2. Login attempts are limited whenever sign-in is on: per client, then for all clients together.
3. Sign-in: everything under /api needs a valid session cookie except the PUBLIC routes below.
   Routes are protected by default, so a route added later cannot be exposed by accident.
4. Request limits (uploads, other writes) per client, when enabled. Automatic detection has its own
   limit, applied by its route after the cheaper refusals (unknown plan, image too large).

Settings are read on every request (not at import), so tests can switch modes with monkeypatch.

Which address is "the client": `scope["client"]`, as set by the ASGI server. Under uvicorn this is
the TCP peer, EXCEPT that uvicorn by default (proxy_headers on, FORWARDED_ALLOW_IPS="127.0.0.1,::1")
replaces it with the X-Forwarded-For value whenever the connection comes from loopback. So:
- clients connecting directly from another machine cannot choose their address;
- anything that reaches uvicorn through loopback can claim any address (a local reverse proxy must
  therefore overwrite X-Forwarded-For with the real client address, as Caddy does by default, and
  must be the only way in; otherwise run uvicorn with --forwarded-allow-ips="" to trust no one);
- behind a proxy that does not set X-Forwarded-For at all, every client appears as loopback.
This app never reads X-Forwarded-For itself.
"""

import ipaddress
import re
from http.cookies import CookieError, SimpleCookie

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import settings
from app.errors import ArchflowError, CsrfRejected, LocalOnly, Unauthorized, error_response
from app.security import sessions
from app.security.limits import enforce

CSRF_HEADER = b"x-archflow-csrf"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
LOGIN_PATH = "/api/auth/login"

# (method, path) pairs anyone may call. HEAD is treated like GET.
PUBLIC_ROUTES = frozenset({
    ("GET", "/api/health"),
    ("GET", "/api/auth/me"),
    ("POST", LOGIN_PATH),
    ("POST", "/api/auth/logout"),
})
# The buyer page's data: the published, read-only snapshot behind an unguessable link.
PUBLIC_SHARE = re.compile(r"^/api/share/[^/]+$")
UPLOAD_PATH = "/api/floorplans"
# Automatic detection is limited by its route (api/interpretation.py), after the 404 and image-size checks,
# so requests that are refused anyway do not use up the detection budget.

MINUTE, DAY = 60.0, 86_400.0


def is_loopback(host: str | None) -> bool:
    """127.0.0.0/8, ::1 and IPv4-mapped loopback. Anything that is not an IP address is not loopback."""
    try:
        ip = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return ip.is_loopback or (mapped is not None and mapped.is_loopback)


def is_public(method: str, path: str) -> bool:
    method = "GET" if method == "HEAD" else method
    return (method, path) in PUBLIC_ROUTES or (method == "GET" and PUBLIC_SHARE.match(path) is not None)


def session_token(scope: Scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"cookie":
            try:
                morsel = SimpleCookie(value.decode("latin-1")).get(sessions.COOKIE_NAME)
            except CookieError:
                return None
            return morsel.value if morsel else None
    return None


def _header(scope: Scope, wanted: bytes) -> bytes | None:
    for name, value in scope.get("headers", []):
        if name == wanted:
            return value
    return None


def _limit(bucket: str, client: str, capacity: int, period_s: float, what: str) -> None:
    enforce(bucket, client, capacity, period_s, what)


class LocalOnlyMiddleware:
    """Step 0. Must be the OUTERMOST middleware (registered last in main.py), so nothing else, in
    particular CORSMiddleware answering preflight (OPTIONS) requests, can respond to another machine first."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not settings.is_production and not is_loopback((scope.get("client") or (None, 0))[0]):
            # Every path and method, including /docs and CORS preflights: a development server is for this computer only.
            await error_response(LocalOnly(
                "This ARCHFLOW server runs in development mode and only answers this computer. "
                "Set ARCHFLOW_ENV=production (with sign-in configured) to serve a network."))(scope, receive, send)
            return
        await self.app(scope, receive, send)


class SecurityMiddleware:
    """Steps 1-4 for /api requests. Runs inside CORS, so its refusals carry CORS headers for allowed origins."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/") or scope["method"] == "OPTIONS":
            await self.app(scope, receive, send)
            return
        try:
            claims = self._check(scope)
        except ArchflowError as exc:
            await error_response(exc)(scope, receive, send)
            return
        if claims is None or not sessions.needs_renewal(settings, claims):
            await self.app(scope, receive, send)
            return

        renewed = sessions.cookie_header(settings, sessions.issue(settings)).encode("latin-1")

        async def send_with_renewal(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), (b"set-cookie", renewed)]}
            await send(message)

        await self.app(scope, receive, send_with_renewal)

    def _check(self, scope: Scope) -> dict | None:
        """Raise for a refused request; return the session claims (or None) for an allowed one."""
        method, path = scope["method"], scope["path"]
        unsafe = method in UNSAFE_METHODS
        client = (scope.get("client") or ("unknown", 0))[0]
        auth_on = settings.auth_enabled

        if auth_on and unsafe and _header(scope, CSRF_HEADER) != b"1":
            raise CsrfRejected("This request is missing its security header. Reload the page and try again.")

        if auth_on and method == "POST" and path == LOGIN_PATH:
            # Per client first, so a client that is already refused does not use up the overall budget.
            _limit("login", client, settings.rate_login_per_minute, MINUTE, "sign-in attempts")
            # Overall cap: bounds password guessing (and hashing work) however many addresses are used.
            _limit("login-all", "*", settings.rate_login_global_per_minute, MINUTE, "sign-in attempts on this server")

        claims = None
        if auth_on and not is_public(method, path):
            claims = sessions.verify(settings, session_token(scope))
            if claims is None:
                raise Unauthorized("Please sign in to continue.")

        if settings.rate_limits_enabled and unsafe and path != LOGIN_PATH:
            route = path.rstrip("/")
            if method == "POST" and route == UPLOAD_PATH:
                _limit("upload", client, settings.rate_upload_per_minute, MINUTE, "uploads")
                _limit("upload-day", client, settings.rate_upload_per_day, DAY, "uploads today")
            _limit("write", client, settings.rate_write_per_minute, MINUTE, "changes")
        return claims
