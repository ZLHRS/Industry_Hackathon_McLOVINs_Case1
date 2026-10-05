"""Validated runtime settings, read when the application factory is called."""

from enum import StrEnum
from pathlib import Path
from typing import Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NARYADAI_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    environment: Environment = Environment.DEVELOPMENT
    log_level: str = "INFO"
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "[::1]")
    cors_origins: tuple[str, ...] = ()
    database_url: SecretStr | None = None
    session_ttl_seconds: int = Field(default=28800, ge=60, le=86400)
    login_window_seconds: int = Field(default=900, ge=60, le=3600)
    login_account_limit: int = Field(default=5, ge=1, le=20)
    login_peer_limit: int = Field(default=50, ge=1, le=200)

    worker_interval_seconds: float = Field(default=2.0, ge=0.1, le=60)
    reminder_minutes: int = Field(default=30, ge=1, le=1440)
    acceptance_minutes: int = Field(default=10, ge=1, le=120)
    emergency_acceptance_minutes: int = Field(default=3, ge=1, le=30)
    overdue_repeat_minutes: int = Field(default=30, ge=1, le=1440)
    manager_escalation_minutes: int = Field(default=60, ge=1, le=10080)
    web_push_private_key_file: Path | None = None
    web_push_subject: str | None = None
    push_timeout_seconds: int = Field(default=10, ge=1, le=20)
    push_max_attempts: int = Field(default=5, ge=1, le=10)
    push_lease_seconds: int = Field(default=60, ge=30, le=300)
    realtime_poll_seconds: float = Field(default=1.0, ge=0.1, le=2)

    @field_validator("web_push_subject")
    @classmethod
    def validate_push_subject(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        if any(character.isspace() for character in value) or len(value) > 512:
            raise ValueError("Invalid Web Push contact URI")
        if parsed.scheme == "mailto" and "@" in parsed.path and not parsed.query:
            return value
        if (
            parsed.scheme == "https"
            and parsed.hostname
            and not parsed.username
            and not parsed.password
            and not parsed.fragment
        ):
            return value
        raise ValueError("Web Push subject must be a mailto or HTTPS contact URI")

    photo_root: Path = Path("var/photos")
    photo_max_bytes: int = Field(default=10 * 1024 * 1024, ge=1024, le=20 * 1024 * 1024)
    photo_max_pixels: int = Field(default=24_000_000, ge=100_000, le=40_000_000)
    photo_max_dimension: int = Field(default=2048, ge=320, le=4096)
    photo_output_max_bytes: int = Field(default=2 * 1024 * 1024, ge=1024, le=5 * 1024 * 1024)

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        try:
            parsed = make_url(value.get_secret_value())
        except Exception:
            raise ValueError("Invalid PostgreSQL URL") from None
        if parsed.drivername != "postgresql+psycopg" or not parsed.database:
            raise ValueError("Use postgresql+psycopg with an explicit database")
        return value

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        value = value.upper()
        if value not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("Unsupported log level")
        return value

    @field_validator("allowed_hosts")
    @classmethod
    def validate_hosts(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if not values:
            raise ValueError("At least one allowed host is required")
        for host in values:
            if not host or host != host.strip() or any(c in host for c in "/?#@ "):
                raise ValueError("Allowed hosts must be hostnames, without URL paths")
            if "*" in host:
                raise ValueError("List explicit hosts; wildcards are not allowed")
            if ":" in host and host != "[::1]":
                raise ValueError("Allowed hosts must not include a scheme or port")
        return values

    @field_validator("cors_origins")
    @classmethod
    def validate_origins(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        for origin in values:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
                or "*" in origin
                or any(c.isspace() for c in origin)
            ):
                raise ValueError("CORS origins must be exact HTTP(S) origins without a path")
            # Accessing port validates malformed and out-of-range ports.
            _ = parsed.port
        return values

    @model_validator(mode="after")
    def validate_production(self) -> Self:
        if self.environment == Environment.PRODUCTION:
            if self.log_level == "DEBUG":
                raise ValueError("DEBUG logging is not permitted in production")
            if any(not origin.startswith("https://") for origin in self.cors_origins):
                raise ValueError("Production CORS origins must use HTTPS")
        return self
