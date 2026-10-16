"""Runtime configuration, read from environment variables (see .env.example)."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ARCHFLOW_", env_file=".env", extra="ignore")

    app_name: str = "ARCHFLOW API"
    version: str = "0.1.0"
    # Comma-separated list of allowed browser origins.
    cors_origins: str = "http://localhost:3000"
    storage_dir: Path = BACKEND_ROOT / "storage"
    max_upload_mb: int = 15

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
