from __future__ import annotations

import importlib.util
import json
import sys
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image
from pydantic import SecretStr

from naryadai.ai import ReviewResult, manual_review_result
from naryadai.config import Settings
from naryadai.domain.lifecycle import AiAssessment

SCRIPT = Path(__file__).parents[2] / "scripts" / "eval_ai.py"
SPEC = importlib.util.spec_from_file_location("eval_ai", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ai_eval = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ai_eval
SPEC.loader.exec_module(ai_eval)


def _report(checks: list[dict[str, str]]) -> dict[str, object]:
    return {
        "schema_version": 1,
        "source": "openai",
        "confidence": 0.9,
        "checks": checks,
        "timing": {},
        "limitations": [],
        "model_assessment": "synthetic",
    }


@pytest.mark.asyncio
async def test_dry_run_never_calls_analyzer_and_writes_unexecuted_result(tmp_path: Path) -> None:
    calls = 0

    async def analyzer(*_args: object) -> ReviewResult:
        nonlocal calls
        calls += 1
        raise AssertionError("dry run must not call the provider")

    code, report, path = await ai_eval.run_evaluation(output_root=tmp_path, analyzer=analyzer)

    assert code == 0
    assert calls == 0
    assert report["executed"] is False
    assert report["stop_reason"] == "dry_run"
    assert report["fixture_source"] == (
        "generated in scripts/eval_ai.py; no seed or user photos are used"
    )
    assert json.loads(path.read_text(encoding="utf-8"))["executed"] is False


@pytest.mark.asyncio
async def test_live_mode_stops_before_calling_analyzer_when_key_is_missing(tmp_path: Path) -> None:
    calls = 0

    async def analyzer(*_args: object) -> ReviewResult:
        nonlocal calls
        calls += 1
        raise AssertionError("missing key must stop before calling the provider")

    code, report, _path = await ai_eval.run_evaluation(
        live=True,
        output_root=tmp_path,
        settings=Settings(ai_api_key=None),
        analyzer=analyzer,
    )

    assert code == 2
    assert calls == 0
    assert report["executed"] is False
    assert report["stop_reason"] == "missing_api_key"


@pytest.mark.asyncio
async def test_quota_error_aborts_after_one_synthetic_call(tmp_path: Path) -> None:
    calls = 0

    async def quota(*_args: object) -> ReviewResult:
        nonlocal calls
        calls += 1
        raise ai_eval.ProviderError("quota_exhausted", retryable=False)

    code, report, _path = await ai_eval.run_evaluation(
        live=True,
        output_root=tmp_path,
        settings=Settings(ai_api_key=SecretStr("synthetic-unit-key")),
        analyzer=quota,
    )

    assert code == 1
    assert calls == 1
    assert report["executed"] is True
    assert report["stop_reason"] == "quota_exhausted"
    assert len(report["cases"]) == 1


def test_grade_rejects_accepted_result_for_rework_case() -> None:
    case = next(case for case in ai_eval.build_cases() if case.name == "not_repaired")
    result = ReviewResult(
        verdict=AiAssessment.ACCEPTED,
        score=5,
        needs_master_review=True,
        explanation="Рекомендация модели: Принято.",
        model_name="gpt-5.4",
        report=_report(
            [
                {"code": "photo_pairs", "status": "fail", "detail": "missing"},
                {"code": "semantic_review", "status": "pass", "detail": "wrong"},
            ]
        ),
    )

    grade = ai_eval.grade_case(case, result, "gpt-5.4")

    assert grade["actual_outcome"] == "accepted"
    assert grade["outcome_ok"] is False
    assert grade["passed"] is False


def test_grade_accepts_exact_positive_preliminary_result() -> None:
    source = next(
        case for case in ai_eval.build_cases() if case.name == "complete_guard_installation"
    )
    case = ai_eval.EvalCase(
        "unit_accepted",
        source.review,
        "accepted",
        (("photo_pairs", "pass"), ("same_equipment", "pass")),
        "calibration",
    )
    result = ReviewResult(
        verdict=AiAssessment.ACCEPTED,
        score=5,
        needs_master_review=True,
        explanation="Рекомендация модели: Принято.",
        model_name="gpt-5.4",
        report=_report(
            [
                {"code": "photo_pairs", "status": "pass", "detail": "after"},
                {"code": "same_equipment", "status": "pass", "detail": "same"},
                {"code": "semantic_review", "status": "pass", "detail": "complete"},
            ]
        ),
    )

    grade = ai_eval.grade_case(case, result, "gpt-5.4")

    assert grade["required_checks_ok"] is True
    assert grade["score_and_gate_ok"] is True
    assert grade["passed"] is True


def test_generated_vision_cases_are_distinct_clear_synthetic_jpegs() -> None:
    cases = {case.name: case for case in ai_eval.build_cases()}
    vision_cases = [case for case in cases.values() if case.vision]

    assert {case.name for case in vision_cases} == {
        "complete_guard_installation",
        "old_photo",
        "duplicate_photo",
        "similar_photo",
        "missing_time_norm",
        "vision_guard_fitted",
        "vision_different_machine",
        "fresh_holdout_visible_warning_sign",
    }
    before, after = cases["vision_guard_fitted"].review.photos
    different_after = cases["vision_different_machine"].review.photos[1]
    assert before.image_bytes is not None and after.image_bytes is not None
    assert after.image_bytes != different_after.image_bytes
    with Image.open(BytesIO(before.image_bytes)) as image:
        assert image.format == "JPEG"
        assert image.size == (360, 220)


def test_synthetic_safety_cases_cover_local_evidence_failures() -> None:
    cases = {case.name: case for case in ai_eval.build_cases()}
    expected = {
        "missing_after_unplanned": ("photo_pairs", "fail"),
        "old_photo": ("capture_provenance", "warning"),
        "duplicate_photo": ("exact_photo_reuse", "fail"),
        "similar_photo": ("perceptual_photo_similarity", "warning"),
        "missing_time_norm": ("repair_time", "unknown"),
        "excessive_historical_consumption": ("materials", "warning"),
    }

    for name, (code, status) in expected.items():
        result = manual_review_result(cases[name].review, source="rules")
        check = next(item for item in result.report["checks"] if item["code"] == code)
        assert check["status"] == status, name


def test_all_cases_are_calibration_after_two_live_repair_cycles() -> None:
    cases = ai_eval.build_cases()
    calibration = {case.name for case in cases if case.partition == "calibration"}

    assert len(cases) == 15
    assert len(calibration) == 15
    assert all("seed" not in case.name for case in cases)


def test_metrics_count_abstention_as_a_failure() -> None:
    cases = ai_eval.build_cases()
    positive = next(case for case in cases if case.name == "complete_guard_installation")
    negative = next(case for case in cases if case.name == "not_repaired")
    records = [
        {
            "name": positive.name,
            "grade": {
                "passed": False,
                "expected_outcome": "accepted",
                "actual_outcome": "abstain",
            },
        },
        {
            "name": negative.name,
            "grade": {
                "passed": False,
                "expected_outcome": "rework_required",
                "actual_outcome": "accepted",
            },
        },
    ]

    metrics = ai_eval._metrics(records, cases)

    overall = metrics["overall"]
    assert overall["passed"] == 0
    assert overall["abstentions"] == 1
    assert overall["unsafe_acceptances"] == 1
    assert metrics["by_partition"]["calibration"]["expected_cases"] == 15


def test_key_file_settings_override_an_ambient_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key_file = tmp_path / "fresh-key"
    key_file.write_text("fresh-test-key\n", encoding="utf-8")
    monkeypatch.setenv("NARYADAI_AI_API_KEY", "old-key-must-not-be-used")

    settings = ai_eval._settings_from_key_file(key_file)

    assert settings.ai_api_key is not None
    assert settings.ai_api_key.get_secret_value() == "fresh-test-key"
