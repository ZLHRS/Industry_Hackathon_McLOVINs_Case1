from __future__ import annotations

import importlib.util
import json
import sys
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image
from pydantic import SecretStr

from naryadai.ai import ReviewResult
from naryadai.config import Settings

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

    code, report, path = await ai_eval.run_evaluation(
        output_root=tmp_path,
        analyzer=analyzer,
    )

    assert code == 0
    assert calls == 0
    assert report["executed"] is False
    assert report["stop_reason"] == "dry_run"
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


def test_grade_rejects_accepted_advisory_for_negative_case_even_when_manual() -> None:
    case = next(case for case in ai_eval.build_cases() if case.name == "not_repaired")
    result = ReviewResult(
        verdict=None,
        score=None,
        needs_master_review=True,
        explanation="Решение оставлено мастеру. Рекомендация модели: Принято. Всё хорошо.",
        model_name="gpt-6.1-sol",
        report=_report(
            [{"code": "semantic_review", "title": "semantic", "status": "unknown", "detail": "x"}]
        ),
    )

    grade = ai_eval.grade_case(case, result, "gpt-6.1-sol")

    assert grade["manual_safety_ok"] is True
    assert grade["semantic_ok"] is False
    assert grade["passed"] is False


def test_generated_vision_cases_are_distinct_clear_synthetic_jpegs() -> None:
    vision_cases = [case for case in ai_eval.build_cases() if case.vision]

    assert len(vision_cases) == 2
    before, after = vision_cases[0].review.photos
    different_after = vision_cases[1].review.photos[1]
    assert before.image_bytes is not None and after.image_bytes is not None
    assert after.image_bytes != different_after.image_bytes
    with Image.open(BytesIO(before.image_bytes)) as image:
        assert image.format == "JPEG"
        assert image.size == (360, 220)


@pytest.mark.parametrize("label", ["Принято", "Принято с замечаниями"])  # noqa: RUF001
def test_explicit_unfinished_work_cannot_be_accepted_even_with_remarks(label):
    case = next(case for case in ai_eval.build_cases() if case.name == "not_repaired")
    result = ReviewResult(
        verdict=None,
        score=None,
        needs_master_review=True,
        explanation="Рекомендация модели: " + label + ".",
        model_name="gpt-6.1-sol",
        report=_report(
            [
                {"code": "semantic_review", "status": "unknown", "detail": "unfinished"},
                {"code": "model_0", "status": "warning", "detail": "unfinished"},
            ]
        ),
    )
    assert not ai_eval.grade_case(case, result, "gpt-6.1-sol")["passed"]


def test_different_equipment_requires_explicit_visual_check():
    case = next(case for case in ai_eval.build_cases() if case.name == "vision_different_machine")
    result = ReviewResult(
        verdict=None,
        score=None,
        needs_master_review=True,
        explanation="Рекомендация модели: Недостаточно данных.",
        model_name="gpt-6.1-sol",
        report=_report([{"code": "semantic_review", "status": "unknown"}]),
    )
    assert not ai_eval.grade_case(case, result, "gpt-6.1-sol")["passed"]
