"""Runtime configuration, read from environment variables (see .env.example)."""

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent
# Largest image (width x height) that is decoded at all. The setting may lower it, never raise it.
MAX_IMAGE_PIXELS_CEILING = 20_000_000


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ARCHFLOW_", env_file=".env", extra="ignore")

    app_name: str = "ARCHFLOW API"
    version: str = "0.1.0"
    # "development" (the default): answers only this computer (loopback), sign-in optional.
    # "production": answers the network; sign-in, request limits and a Secure cookie are required.
    env: Literal["development", "production"] = "development"
    # Comma-separated list of allowed browser origins.
    cors_origins: str = "http://localhost:3000"
    storage_dir: Path = BACKEND_ROOT / "storage"
    max_upload_mb: int = 15
    # Image size limit in pixels (20 MP = e.g. 5000 x 4000). Values above the ceiling stop startup.
    max_image_pixels: int = Field(MAX_IMAGE_PIXELS_CEILING, ge=1, le=MAX_IMAGE_PIXELS_CEILING)

    # ---- developer sign-in (README "Sign-in") ----
    # scrypt hash of the developer password, made with `python -m app.security.passwd`.
    # Empty: sign-in is off, which is only allowed in development.
    admin_password_hash: SecretStr = SecretStr("")
    # Random key (32+ characters) that signs session cookies. Changing it signs everyone out.
    session_secret: SecretStr = SecretStr("")
    session_hours: int = 12
    # Send the session cookie over HTTPS only. Unset: on in production (where false is refused), off in development.
    cookie_secure: bool | None = None

    # ---- abuse and resource limits ----
    # Per-client request limits. Unset: on in production (where false is refused), off in development.
    rate_limits: bool | None = None
    rate_upload_per_minute: int = 10
    rate_upload_per_day: int = 60
    rate_interpret_per_minute: int = 6
    rate_write_per_minute: int = 120
    # Sign-in attempts, whenever sign-in is on: per client, and for all clients together.
    rate_login_per_minute: int = 5
    rate_login_global_per_minute: int = 30
    # How many uploads / automatic detections / password checks may run at the same time (memory guard).
    max_concurrent_uploads: int = 2
    max_concurrent_interpretations: int = 1
    max_concurrent_logins: int = 2

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def auth_enabled(self) -> bool:
        return self.is_production or bool(self.admin_password_hash.get_secret_value())

    @property
    def rate_limits_enabled(self) -> bool:
        return self.is_production if self.rate_limits is None else self.rate_limits

    @property
    def cookie_secure_enabled(self) -> bool:
        return self.is_production if self.cookie_secure is None else self.cookie_secure


settings = Settings()
