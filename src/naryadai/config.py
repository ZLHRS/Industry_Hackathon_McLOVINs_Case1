"""Validated runtime settings, read when the application factory is called."""

from enum import StrEnum
from typing import Self
from urllib.parse import urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
