from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from pydantic import SecretStr

from naryadai.ai import ReviewResult
from naryadai.config import Settings
from naryadai.domain.lifecycle import AiAssessment

SCRIPT = Path(__file__).parents[2] / "scripts" / "eval_ai_holdout.py"
SPEC = importlib.util.spec_from_file_location("eval_ai_holdout", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
holdout = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = holdout
SPEC.loader.exec_module(holdout)


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


def test_manifest_is_versioned_hashed_and_covers_required_semantics() -> None:
    manifest, cases = holdout.load_cases()

    assert manifest["suite_id"] == "ai-holdout-v1"
    assert len(cases) == 15
    assert len({case.identifier for case in cases}) == 15
    ids = {case.identifier for case in cases}
    assert {
        "visible_warning_label",
        "planned_inspection_without_photo",
        "unplanned_private_photo_not_shared",
        "different_equipment_after",
        "unrelated_material_for_guard",
        "prompt_injection_with_nonrepair",
    } <= ids
    assert all(case.rationale for case in cases)


def test_freeze_covers_manifest_grader_and_runtime_sources() -> None:
    observed = holdout.verify_freeze()

    assert set(observed) == {"manifest_sha256", "grader_sha256", "runtime_sha256"}
    assert all(len(value) == 64 for value in observed.values())


def test_grader_rejects_unsafe_acceptance_for_known_nonrepair() -> None:
    _, cases = holdout.load_cases()
    case = next(item for item in cases if item.identifier == "report_admits_no_repair")
    result = ReviewResult(
        verdict=AiAssessment.ACCEPTED,
        score=5,
        needs_master_review=True,
        explanation="Рекомендация модели: Принято.",
        model_name="gpt-5.4",
        report=_report(
            [
                {"code": "photo_pairs", "status": "pass", "detail": "pair"},
                {"code": "same_equipment", "status": "pass", "detail": "same"},
                {"code": "semantic_review", "status": "pass", "detail": "wrong"},
            ]
        ),
    )

    grade = holdout.grade_case(case, result, "gpt-5.4")

    assert grade["actual_outcome"] == "accepted"
    assert grade["outcome_ok"] is False
    assert grade["passed"] is False


@pytest.mark.asyncio
async def test_dry_run_writes_no_provider_result(tmp_path: Path) -> None:
    calls = 0

    async def analyzer(*_args: object) -> ReviewResult:
        nonlocal calls
        calls += 1
        raise AssertionError("dry holdout must not call provider")

    code, report, path = await holdout.run_holdout(output_root=tmp_path, analyzer=analyzer)

    assert code == 0
    assert calls == 0
    assert report["executed"] is False
    assert report["stop_reason"] == "dry_run"
    assert json.loads(path.read_text(encoding="utf-8"))["fixture_content_sha256"]


@pytest.mark.asyncio
async def test_live_run_refuses_when_freeze_is_modified(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        holdout, "verify_freeze", lambda: (_ for _ in ()).throw(ValueError("changed"))
    )

    code, report, _ = await holdout.run_holdout(
        live=True,
        output_root=tmp_path,
        settings=Settings(ai_api_key=SecretStr("unit-test-key")),
    )

    assert code == 2
    assert report["executed"] is False
    assert report["stop_reason"] == "freeze_mismatch"
