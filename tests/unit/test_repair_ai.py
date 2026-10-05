import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import SecretStr

import naryadai.ai.repair_review as repair_review
from naryadai.ai import (
    OpenAIReviewConfig,
    ProviderError,
    ReviewInput,
    ReviewPhoto,
    analyze_review,
    manual_review_result,
)

NOW = datetime(2026, 10, 6, 12, tzinfo=UTC)


def _photo(kind: str, index: str, *, captured: datetime | None = NOW) -> ReviewPhoto:
    return ReviewPhoto(
        kind=kind,
        sha256=index * 64,
        reused_exact=False,
        captured_at=captured,
        uploaded_at=NOW + timedelta(minutes=1),
        image_bytes=b"image",
    )


def _input(**changes: object) -> ReviewInput:
    values: dict[str, object] = {
        "work_description": "Replace bearing for operator Ivan Petrov +7 777 123 4567",
        "completion_description": "Bearing replaced; email worker@example.test",
        "equipment_type": "Conveyor",
        "fault_name": "Bearing wear",
        "materials": (),
        "no_materials_reason": "Part was supplied from an approved prior issue.",
        "active_minutes": 30.0,
        "paused_minutes": 0.0,
        "elapsed_minutes": 35.0,
        "norm_minutes": 40.0,
        "issued_at": NOW - timedelta(days=1),
        "completed_at": NOW,
        "photos": (_photo("before", "a", captured=NOW - timedelta(hours=1)), _photo("after", "b")),
        "attempt_started_at": NOW - timedelta(hours=2),
        "known_identifiers": ("Ivan Petrov",),
    }
    values.update(changes)
    return ReviewInput(**values)  # type: ignore[arg-type]


def _config(**changes: object) -> OpenAIReviewConfig:
    values: dict[str, object] = {
        "api_key": SecretStr("unit-test-key"),
        "vision_enabled": True,
    }
    values.update(changes)
    return OpenAIReviewConfig(**values)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_structured_model_result_is_bounded_and_never_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_request(
        payload: dict[str, object], config: OpenAIReviewConfig
    ) -> dict[str, object]:
        assert payload["store"] is False
        return {
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": json.dumps(
                                {
                                    "verdict": "accepted",
                                    "score": 5,
                                    "confidence": 0.93,
                                    "summary": "Report is consistent.",
                                    "findings": [],
                                    "same_equipment": "yes",
                                }
                            ),
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr(repair_review, "_request", fake_request)
    result = await analyze_review(_input(), _config())

    assert result.verdict is None
    assert result.score is None
    assert result.needs_master_review is True
    assert "Принято" in result.explanation
    assert result.model_name == "gpt-4.1-mini-2025-04-14"
    assert result.report["source"] == "openai"


@pytest.mark.asyncio
async def test_deterministic_evidence_failure_still_runs_semantic_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    async def fake_request(
        payload: dict[str, object], config: OpenAIReviewConfig
    ) -> dict[str, object]:
        nonlocal called
        called = True
        return _response("accepted", 0.93)

    duplicate = _photo("after", "a")
    review = _input(photos=(_photo("before", "a", captured=NOW - timedelta(hours=1)), duplicate))
    monkeypatch.setattr(repair_review, "_request", fake_request)

    result = await analyze_review(review, _config())

    assert called is True
    assert result.verdict is None
    assert result.needs_master_review is True
    assert result.report["source"] == "openai"
    reuse = next(item for item in result.report["checks"] if item["code"] == "exact_photo_reuse")
    assert reuse["status"] == "fail"


def test_payload_redacts_identifiers_and_uses_balanced_images() -> None:
    review = _input(
        photos=(
            _photo("before", "a", captured=NOW - timedelta(hours=1)),
            _photo("before", "b", captured=NOW - timedelta(hours=1)),
            _photo("after", "c"),
            _photo("other", "d"),
        )
    )
    payload = repair_review._payload(review, _config(max_images=3))
    user = payload["input"][1]
    assert isinstance(user, dict)
    content = user["content"]
    assert isinstance(content, list)
    facts = content[0]
    assert isinstance(facts, dict)
    serialized = facts["text"]
    assert isinstance(serialized, str)
    assert "Ivan Petrov" not in serialized
    assert "worker@example.test" not in serialized
    assert "+7 777 123 4567" not in serialized
    assert "a" * 64 not in serialized
    assert len([item for item in content if item["type"] == "input_image"]) == 3


def test_low_confidence_and_vision_off_require_master() -> None:
    review = _input()
    raw = _response("rework_required", 0.2)
    result = repair_review._model_result(
        review,
        _config(vision_enabled=False),
        *repair_review._rule_checks(review)[:2],
        repair_review._parse_output(raw),
        False,
    )
    assert result.verdict is None
    assert result.score is None
    assert result.needs_master_review is True


def test_provider_error_is_whitelisted_and_manual_fallback_has_no_verdict() -> None:
    with pytest.raises(ValueError, match="unsupported"):
        ProviderError("raw sensitive error", retryable=True)
    result = manual_review_result(_input(), source="unavailable", limitation="timeout")
    assert result.model_name == "openai-unavailable"
    assert result.verdict is None
    assert result.report["source"] == "unavailable"


def test_attempt_start_marks_old_after_photo_manual() -> None:
    old_after = _photo("after", "b", captured=NOW - timedelta(days=2))
    result = manual_review_result(
        _input(photos=(_photo("before", "a", captured=NOW - timedelta(days=3)), old_after)),
        source="rules",
    )
    capture = next(item for item in result.report["checks"] if item["code"] == "capture_provenance")
    assert capture["status"] == "warning"


def _response(verdict, confidence):
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": json.dumps(
                            {
                                "verdict": verdict,
                                "score": 4,
                                "confidence": confidence,
                                "summary": "Evidence reviewed.",
                                "findings": [],
                                "same_equipment": "yes",
                            }
                        ),
                    }
                ],
            }
        ],
    }
