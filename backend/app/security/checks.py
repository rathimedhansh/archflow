"""Startup checks: refuse to run with sign-in half configured, or production without its protections.

Development mode cannot reach the network at all (the middleware answers loopback clients only), so
the only checks there are for sign-in that was configured but is broken.
"""

import logging

from app.config import Settings
from app.security.passwords import is_valid_hash

log = logging.getLogger("archflow.security")
MIN_SECRET_LENGTH = 32


class InsecureConfiguration(RuntimeError):
    pass


def problems(settings: Settings) -> list[str]:
    """What is wrong with the sign-in settings (setting names only, never their values)."""
    if not settings.auth_enabled:
        return []
    found = []
    password_hash = settings.admin_password_hash.get_secret_value()
    if not password_hash:
        found.append("ARCHFLOW_ADMIN_PASSWORD_HASH is not set (create one with `python -m app.security.passwd`).")
    elif not is_valid_hash(password_hash):
        found.append("ARCHFLOW_ADMIN_PASSWORD_HASH is not a valid hash from `python -m app.security.passwd`.")
    if len(settings.session_secret.get_secret_value()) < MIN_SECRET_LENGTH:
        found.append(f"ARCHFLOW_SESSION_SECRET must be set to a random value of at least {MIN_SECRET_LENGTH} characters.")
    if settings.session_hours < 1:
        found.append("ARCHFLOW_SESSION_HOURS must be at least 1.")
    # With credentials allowed, a wildcard would let any website send signed-in requests.
    if "*" in settings.cors_origin_list:
        found.append("ARCHFLOW_CORS_ORIGINS must list exact origins, not '*', while sign-in is on.")
    if settings.is_production:
        # Protections that production must not run without, even when switched off on purpose.
        if settings.rate_limits is False:
            found.append("ARCHFLOW_RATE_LIMITS=false is not allowed in production.")
        if settings.cookie_secure is False:
            found.append("ARCHFLOW_COOKIE_SECURE=false is not allowed in production (the session cookie must be HTTPS-only).")
    return found


def check_or_raise(settings: Settings) -> None:
    found = problems(settings)
    if found:
        raise InsecureConfiguration("ARCHFLOW will not start: " + " ".join(found))
    if not settings.is_production:
        log.warning("Development mode: this server answers only this computer (loopback); requests from other "
                    "machines get 403. Developer sign-in is %s. Use ARCHFLOW_ENV=production to serve a network.",
                    "ON" if settings.auth_enabled else "OFF")
