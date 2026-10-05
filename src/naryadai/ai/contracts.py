"""Typed contracts for conservative repair-review analysis."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from pydantic import SecretStr

from naryadai.domain.lifecycle import AiAssessment

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
PhotoKind = Literal["before", "after", "other"]
_ERROR_CODES = frozenset(
    {
        "http_error",
        "response_too_large",
        "missing_api_key",
        "http_client_unavailable",
        "timeout",
        "transport_error",
        "http_400",
        "http_401",
        "http_403",
        "http_422",
        "http_429",
        "quota_exhausted",
        "http_5xx",
        "invalid_provider_response",
        "missing_output_text",
        "invalid_structured_output",
    }
)


class ProviderError(RuntimeError):
    """A secret-safe provider failure the worker can classify for retry."""

    def __init__(self, code: str, *, retryable: bool) -> None:
        if code not in _ERROR_CODES:
            raise ValueError("unsupported provider error code")
        super().__init__(code)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class ReviewMaterial:
    name: str
    unit: str | None
    quantity: str

    def __post_init__(self) -> None:
        _text(self.name, "name", 200)
        if self.unit is not None:
            _text(self.unit, "unit", 40)
        _text(self.quantity, "quantity", 40)


@dataclass(frozen=True, slots=True)
class ReviewPhoto:
    kind: PhotoKind
    sha256: str
    reused_exact: bool
    captured_at: datetime | None
    uploaded_at: datetime
    image_bytes: bytes | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.kind not in {"before", "after", "other"}:
            raise ValueError("photo kind must be before, after, or other")
        if not isinstance(self.sha256, str) or not _SHA256.fullmatch(self.sha256):
            raise ValueError("photo sha256 must be a lowercase SHA-256 hex digest")
        if not isinstance(self.reused_exact, bool):
            raise TypeError("reused_exact must be a bool")
        if self.captured_at is not None:
            _aware(self.captured_at, "captured_at")
        _aware(self.uploaded_at, "uploaded_at")
        if self.image_bytes is not None and not isinstance(self.image_bytes, bytes):
            raise TypeError("image_bytes must be bytes or None")


@dataclass(frozen=True, slots=True)
class ReviewInput:
    """Allowlisted technical facts; known identifiers are local only."""

    work_description: str
    completion_description: str
    equipment_type: str
    fault_name: str
    materials: tuple[ReviewMaterial, ...]
    no_materials_reason: str | None
    active_minutes: float | None
    paused_minutes: float | None
    elapsed_minutes: float | None
    norm_minutes: float | None
    issued_at: datetime
    completed_at: datetime
    photos: tuple[ReviewPhoto, ...]
    attempt_started_at: datetime | None = None
    known_identifiers: tuple[str, ...] = field(default=(), repr=False)

    def __post_init__(self) -> None:
        for name in ("work_description", "completion_description", "equipment_type", "fault_name"):
            _text(getattr(self, name), name, 10_000)
        if not isinstance(self.materials, tuple) or len(self.materials) > 100:
            raise ValueError("materials must contain at most 100 values")
        if any(not isinstance(value, ReviewMaterial) for value in self.materials):
            raise TypeError("materials must contain ReviewMaterial values")
        if self.no_materials_reason is not None:
            _text(self.no_materials_reason, "no_materials_reason", 1_000)
        if self.materials and self.no_materials_reason is not None:
            raise ValueError("no_materials_reason is only allowed when materials are empty")
        for name in ("active_minutes", "paused_minutes", "elapsed_minutes", "norm_minutes"):
            value = getattr(self, name)
            if value is not None and (
                not isinstance(value, (int, float)) or isinstance(value, bool)
            ):
                raise TypeError(f"{name} must be a number or None")
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError(f"{name} is outside the supported range")
        _aware(self.issued_at, "issued_at")
        _aware(self.completed_at, "completed_at")
        if self.completed_at.astimezone(UTC) < self.issued_at.astimezone(UTC):
            raise ValueError("completed_at must not precede issued_at")
        if self.attempt_started_at is not None:
            _aware(self.attempt_started_at, "attempt_started_at")
            if self.attempt_started_at.astimezone(UTC) > self.completed_at.astimezone(UTC):
                raise ValueError("attempt_started_at must not follow completed_at")
        if not isinstance(self.photos, tuple) or any(
            not isinstance(value, ReviewPhoto) for value in self.photos
        ):
            raise TypeError("photos must be a tuple of ReviewPhoto values")
        if any(not isinstance(value, str) for value in self.known_identifiers):
            raise TypeError("known_identifiers must contain strings")


@dataclass(frozen=True, slots=True)
class OpenAIReviewConfig:
    api_key: SecretStr | None
    model: str = "gpt-6.1-sol"
    reasoning_effort: Literal["low", "medium", "high"] = "medium"
    vision_enabled: bool = False
    request_timeout_seconds: float = 30.0
    total_timeout_seconds: float = 45.0
    max_output_tokens: int = 8_192
    confidence_threshold: float = 0.78
    max_images: int = 3
    max_image_bytes: int = 1_500_000

    def __post_init__(self) -> None:
        _text(self.model, "model", 128)
        if not isinstance(self.vision_enabled, bool):
            raise TypeError("vision_enabled must be a bool")
        if not 1 <= self.request_timeout_seconds <= 40:
            raise ValueError("request_timeout_seconds must be from 1 to 40")
        if not self.request_timeout_seconds <= self.total_timeout_seconds <= 45:
            raise ValueError("total_timeout_seconds must be from request timeout to 45")
        if self.reasoning_effort not in {"low", "medium", "high"}:
            raise ValueError("reasoning_effort must be low, medium or high")
        if not 128 <= self.max_output_tokens <= 8_192:
            raise ValueError("max_output_tokens must be from 128 to 8192")
        if not 0.5 <= self.confidence_threshold <= 0.99:
            raise ValueError("confidence_threshold must be from 0.5 to 0.99")
        if not 1 <= self.max_images <= 3:
            raise ValueError("max_images must be from 1 to 3")
        if not 32_768 <= self.max_image_bytes <= 1_500_000:
            raise ValueError("max_image_bytes must be from 32768 to 1500000")


@dataclass(frozen=True, slots=True)
class ReviewResult:
    verdict: AiAssessment | None
    score: int | None
    needs_master_review: bool
    explanation: str
    model_name: str
    report: dict[str, object]

    def __post_init__(self) -> None:
        if self.verdict is not None and not isinstance(self.verdict, AiAssessment):
            raise TypeError("verdict must be an AiAssessment or None")
        if self.score is not None and (
            not isinstance(self.score, int)
            or isinstance(self.score, bool)
            or not 1 <= self.score <= 5
        ):
            raise ValueError("score must be an int from 1 to 5 or None")
        if not isinstance(self.needs_master_review, bool):
            raise TypeError("needs_master_review must be a bool")
        _text(self.explanation, "explanation", 2_000)
        _text(self.model_name, "model_name", 128)
        expected = {
            "schema_version",
            "source",
            "confidence",
            "checks",
            "timing",
            "limitations",
            "model_assessment",
        }
        if (
            not isinstance(self.report, dict)
            or set(self.report) != expected
            or self.report.get("schema_version") != 1
        ):
            raise ValueError("report must use repair review schema version 1")


def _text(value: object, name: str, maximum: int) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must contain 1 to {maximum} characters")


def _aware(value: object, name: str) -> None:
    if not isinstance(value, datetime):
        raise TypeError(f"{name} must be a datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")
