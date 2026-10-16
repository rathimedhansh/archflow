"""Signed, stateless developer sessions.

A session is `<payload>.<signature>` (both base64url), where the payload holds the issue and expiry
times and the signature is HMAC-SHA256. The signing key is derived from ARCHFLOW_SESSION_SECRET *and*
the configured password hash, so changing either one invalidates every existing session.
"""

import base64
import hashlib
import hmac
import json
import secrets
import time

from app.config import Settings

COOKIE_NAME = "archflow_session"
_CLOCK_SKEW_S = 60


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _key(settings: Settings) -> bytes:
    secret = settings.session_secret.get_secret_value().encode("utf-8")
    password_hash = settings.admin_password_hash.get_secret_value().encode("utf-8")
    return hmac.new(secret, b"archflow-session-v1|" + hashlib.sha256(password_hash).digest(), hashlib.sha256).digest()


def ttl_seconds(settings: Settings) -> int:
    return settings.session_hours * 3600


def issue(settings: Settings, now: float | None = None) -> str:
    now = int(time.time() if now is None else now)
    payload = _b64(json.dumps({"v": 1, "iat": now, "exp": now + ttl_seconds(settings), "n": secrets.token_hex(8)},
                              separators=(",", ":")).encode("ascii"))
    signature = _b64(hmac.new(_key(settings), payload.encode("ascii"), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def verify(settings: Settings, token: str | None, now: float | None = None) -> dict | None:
    """The session's claims if the token is authentic and current, else None."""
    if not token or len(token) > 512 or not settings.session_secret.get_secret_value():
        return None
    payload, _, signature = token.partition(".")
    expected = _b64(hmac.new(_key(settings), payload.encode("ascii", "replace"), hashlib.sha256).digest())
    if not signature or not hmac.compare_digest(signature, expected):
        return None
    try:
        claims = json.loads(_unb64(payload))
        iat, exp = int(claims["iat"]), int(claims["exp"])
    except (ValueError, KeyError, TypeError):
        return None
    now = time.time() if now is None else now
    if claims.get("v") != 1 or exp <= now or iat > now + _CLOCK_SKEW_S:
        return None
    return claims


def needs_renewal(settings: Settings, claims: dict, now: float | None = None) -> bool:
    """Sliding expiry: re-issue once more than half the lifetime has passed."""
    now = time.time() if now is None else now
    return now - claims["iat"] > ttl_seconds(settings) / 2


def cookie_header(settings: Settings, token: str) -> str:
    secure = "; Secure" if settings.cookie_secure_enabled else ""
    return f"{COOKIE_NAME}={token}; Max-Age={ttl_seconds(settings)}; Path=/; HttpOnly; SameSite=Lax{secure}"


def clear_cookie_header(settings: Settings) -> str:
    secure = "; Secure" if settings.cookie_secure_enabled else ""
    return f"{COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax{secure}"
