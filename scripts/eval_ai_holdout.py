"""Frozen, independent synthetic holdout for the repair-review adapter.

The fixture manifest is authored before any provider invocation.  This runner
only constructs the public ``ReviewInput`` contract, calls the runtime adapter,
and grades its result; it never changes adapter policy or eval_ai.py.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import time
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal, cast
from uuid import uuid4

from pydantic import SecretStr

from naryadai.ai import (
    OpenAIReviewConfig,
    ProviderError,
    ReviewInput,
    ReviewMaterial,
    ReviewPhoto,
    ReviewResult,
    analyze_review,
)
from naryadai.config import Settings

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = ROOT / "tests" / "fixtures" / "ai_holdout" / "v1"
MANIFEST_PATH = FIXTURE_DIRECTORY / "manifest.json"
FREEZE_PATH = FIXTURE_DIRECTORY / "freeze.json"
RUNTIME_PATH = ROOT / "src" / "naryadai" / "ai" / "repair_review.py"
OUTPUT_ROOT = ROOT / "tmp" / "ai-eval-holdout"
Outcome = Literal["accepted", "accepted_with_remarks", "rework_required", "abstain"]
CheckStatus = Literal["pass", "warning", "fail", "unknown"]
Analyzer = Callable[[ReviewInput, OpenAIReviewConfig], Awaitable[ReviewResult]]


@dataclass(frozen=True, slots=True)
class HoldoutCase:
    identifier: str
    rationale: str
    review: ReviewInput
    allowed_outcomes: frozenset[Outcome]
    required_checks: tuple[tuple[str, CheckStatus], ...]


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _canonical_manifest_hash(payload: Mapping[str, object]) -> str:
    content = {key: value for key, value in payload.items() if key != "content_sha256"}
    encoded = json.dumps(
        content, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _read_json(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read {path.name}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain an object")
    return value


def _require_string(value: object, label: str, maximum: int = 10_000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"invalid {label}")
    return value


def _photo(record: Mapping[str, object], completed_at: datetime) -> ReviewPhoto:
    asset = _require_string(record.get("asset"), "photo asset", 120)
    if Path(asset).name != asset:
        raise ValueError("photo asset path must be a file name")
    path = FIXTURE_DIRECTORY / asset
    expected_hash = _require_string(record.get("sha256"), "photo hash", 64)
    if len(expected_hash) != 64 or _sha256_path(path) != expected_hash:
        raise ValueError(f"photo fixture hash mismatch: {asset}")
    kind = record.get("kind")
    if kind not in {"before", "after", "other"}:
        raise ValueError("invalid photo kind")
    offset = record.get("captured_minutes_before_completion")
    if not isinstance(offset, int) or isinstance(offset, bool) or not -100_000 <= offset <= 0:
        raise ValueError("invalid photo capture offset")
    reused_exact = record.get("reused_exact", False)
    if not isinstance(reused_exact, bool):
        raise ValueError("invalid photo reuse marker")
    return ReviewPhoto(
        kind=cast(Literal["before", "after", "other"], kind),
        sha256=expected_hash,
        reused_exact=reused_exact,
        captured_at=completed_at + timedelta(minutes=offset),
        uploaded_at=completed_at + timedelta(minutes=1),
        image_bytes=path.read_bytes(),
    )


def _review(record: Mapping[str, object], completed_at: datetime) -> ReviewInput:
    raw = record.get("input")
    if not isinstance(raw, dict):
        raise ValueError("case input must be an object")
    raw_materials = raw.get("materials")
    if not isinstance(raw_materials, list):
        raise ValueError("case materials must be a list")
    materials: list[ReviewMaterial] = []
    for material in raw_materials:
        if not isinstance(material, dict):
            raise ValueError("invalid material")
        quantity = _require_string(material.get("quantity"), "material quantity", 100)
        median = material.get("historical_median_quantity")
        sample = material.get("historical_sample_count")
        materials.append(
            ReviewMaterial(
                name=_require_string(material.get("name"), "material name", 200),
                unit=None
                if material.get("unit") is None
                else _require_string(material.get("unit"), "unit", 40),
                quantity=quantity,
                historical_median_quantity=None
                if median is None
                else _require_string(median, "historical median", 100),
                historical_sample_count=sample
                if isinstance(sample, int) and not isinstance(sample, bool)
                else None,
            )
        )
    raw_photos = raw.get("photos")
    if not isinstance(raw_photos, list):
        raise ValueError("case photos must be a list")
    work_type = raw.get("work_type")
    if work_type not in {"planned", "unplanned"}:
        raise ValueError("invalid work type")
    minutes = ("active_minutes", "paused_minutes", "elapsed_minutes", "norm_minutes")
    values: dict[str, float | None] = {}
    for name in minutes:
        value = raw.get(name)
        if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            raise ValueError(f"invalid {name}")
        values[name] = None if value is None else float(value)
    no_materials = raw.get("no_materials_reason")
    photos: list[ReviewPhoto] = []
    for photo in raw_photos:
        if not isinstance(photo, dict):
            raise ValueError("invalid photo fixture")
        photos.append(_photo(photo, completed_at))
    return ReviewInput(
        work_description=_require_string(raw.get("work_description"), "work description"),
        completion_description=_require_string(
            raw.get("completion_description"), "completion description"
        ),
        equipment_type=_require_string(raw.get("equipment_type"), "equipment type"),
        fault_name=_require_string(raw.get("fault_name"), "fault name"),
        materials=tuple(materials),
        no_materials_reason=None
        if no_materials is None
        else _require_string(no_materials, "no materials reason", 1_000),
        active_minutes=values["active_minutes"],
        paused_minutes=values["paused_minutes"],
        elapsed_minutes=values["elapsed_minutes"],
        norm_minutes=values["norm_minutes"],
        issued_at=completed_at - timedelta(hours=2),
        completed_at=completed_at,
        attempt_started_at=completed_at - timedelta(hours=1),
        photos=tuple(photos),
        work_type=cast(Literal["planned", "unplanned"], work_type),
    )


def load_cases(
    manifest_path: Path = MANIFEST_PATH,
) -> tuple[dict[str, object], tuple[HoldoutCase, ...]]:
    manifest = _read_json(manifest_path)
    if manifest.get("schema_version") != 1 or manifest.get("suite_id") != "ai-holdout-v1":
        raise ValueError("unsupported holdout manifest")
    declared = manifest.get("content_sha256")
    if not isinstance(declared, str) or declared != _canonical_manifest_hash(manifest):
        raise ValueError("holdout manifest content hash mismatch")
    records = manifest.get("cases")
    if not isinstance(records, list) or not 12 <= len(records) <= 18:
        raise ValueError("holdout must contain 12 to 18 cases")
    now = datetime(2026, 10, 8, 10, tzinfo=UTC)
    output: list[HoldoutCase] = []
    identifiers: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("case must be an object")
        identifier = _require_string(record.get("id"), "case id", 100)
        if identifier in identifiers:
            raise ValueError("case identifiers must be unique")
        identifiers.add(identifier)
        expected = record.get("expected")
        if not isinstance(expected, dict):
            raise ValueError("case expectation must be an object")
        outcomes = expected.get("outcomes")
        if not isinstance(outcomes, list) or not outcomes:
            raise ValueError("case must declare allowed outcomes")
        allowed = frozenset(cast(Outcome, item) for item in outcomes)
        if not allowed <= {"accepted", "accepted_with_remarks", "rework_required", "abstain"}:
            raise ValueError("invalid allowed outcome")
        checks = expected.get("required_checks")
        if not isinstance(checks, list):
            raise ValueError("case required checks must be a list")
        required: list[tuple[str, CheckStatus]] = []
        for pair in checks:
            if not isinstance(pair, list) or len(pair) != 2:
                raise ValueError("invalid required check")
            code, status = pair
            if not isinstance(code, str) or status not in {"pass", "warning", "fail", "unknown"}:
                raise ValueError("invalid required check")
            required.append((code, cast(CheckStatus, status)))
        output.append(
            HoldoutCase(
                identifier=identifier,
                rationale=_require_string(record.get("rationale"), "case rationale", 2_000),
                review=_review(record, now),
                allowed_outcomes=allowed,
                required_checks=tuple(required),
            )
        )
    return manifest, tuple(output)


def _freeze_hashes() -> dict[str, str]:
    return {
        "manifest_sha256": _sha256_path(MANIFEST_PATH),
        "grader_sha256": _sha256_path(Path(__file__).resolve()),
        "runtime_sha256": _sha256_path(RUNTIME_PATH),
    }


def verify_freeze() -> dict[str, str]:
    freeze = _read_json(FREEZE_PATH)
    observed = _freeze_hashes()
    if freeze != observed:
        raise ValueError("holdout freeze mismatch; provider execution is refused")
    return observed


def _actual_outcome(result: ReviewResult) -> Outcome:
    return "abstain" if result.verdict is None else result.verdict.value


def grade_case(case: HoldoutCase, result: ReviewResult, model: str) -> dict[str, object]:
    actual = _actual_outcome(result)
    checks = result.report.get("checks")
    check_list = checks if isinstance(checks, list) else []
    check_map = {
        str(item.get("code")): item.get("status") for item in check_list if isinstance(item, dict)
    }
    required_ok = all(check_map.get(code) == status for code, status in case.required_checks)
    if actual == "accepted":
        score_ok = result.score in {4, 5} and result.needs_master_review
    elif actual == "accepted_with_remarks":
        score_ok = result.score in {3, 4} and result.needs_master_review
    elif actual == "rework_required":
        score_ok = result.score in {1, 2} and not result.needs_master_review
    else:
        score_ok = result.score is None and result.needs_master_review
    source_ok = result.report.get("source") == "openai"
    model_ok = result.model_name == model
    outcome_ok = actual in case.allowed_outcomes
    semantic_present = "semantic_review" in check_map
    return {
        "passed": source_ok
        and model_ok
        and outcome_ok
        and score_ok
        and required_ok
        and semantic_present,
        "allowed_outcomes": sorted(case.allowed_outcomes),
        "actual_outcome": actual,
        "outcome_ok": outcome_ok,
        "score_and_gate_ok": score_ok,
        "required_checks_ok": required_ok,
        "semantic_present": semantic_present,
        "source_ok": source_ok,
        "model_ok": model_ok,
    }


def _metrics(records: list[dict[str, object]], cases: tuple[HoldoutCase, ...]) -> dict[str, object]:
    confusion: Counter[str] = Counter()
    unsafe_acceptances = 0
    abstentions = 0
    uncertain_recommendations = 0
    passed = 0
    for case, record in zip(cases, records, strict=True):
        grade = cast(dict[str, object], record["grade"])
        actual = cast(str, grade["actual_outcome"])
        expected = "|".join(sorted(case.allowed_outcomes))
        confusion[f"{expected} -> {actual}"] += 1
        passed += grade.get("passed") is True
        abstentions += actual == "abstain"
        uncertain_recommendations += actual in {"accepted_with_remarks", "abstain"}
        unsafe_acceptances += actual in {"accepted", "accepted_with_remarks"} and not (
            case.allowed_outcomes & {"accepted", "accepted_with_remarks"}
        )
    return {
        "case_count": len(cases),
        "passed": passed,
        "pass_rate": round(passed / len(cases), 4),
        "unsafe_acceptances": unsafe_acceptances,
        "abstentions": abstentions,
        "uncertain_recommendations": uncertain_recommendations,
        "confusion": dict(sorted(confusion.items())),
    }


def _settings_from_key_file(key_file: Path) -> Settings:
    try:
        secret = key_file.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ValueError("cannot read AI key file") from error
    if not secret:
        raise ValueError("AI key file is empty")
    return Settings(_env_file=None).model_copy(update={"ai_api_key": SecretStr(secret)})


def _output_path(root: Path) -> Path:
    directory = root / f"run-{int(time.time() * 1000)}-{uuid4().hex[:8]}"
    directory.mkdir(parents=True, exist_ok=False)
    return directory / "results.json"


async def run_holdout(
    *,
    live: bool = False,
    output_root: Path = OUTPUT_ROOT,
    settings: Settings | None = None,
    model: str = "gpt-5.4",
    analyzer: Analyzer = analyze_review,
) -> tuple[int, dict[str, object], Path]:
    manifest, cases = load_cases()
    path = _output_path(output_root)
    report: dict[str, object] = {
        "suite_id": manifest["suite_id"],
        "fixture_policy": manifest["fixture_policy"],
        "fixture_content_sha256": manifest["content_sha256"],
        "executed": False,
        "model": model,
        "cases": [
            {"id": case.identifier, "allowed_outcomes": sorted(case.allowed_outcomes)}
            for case in cases
        ],
    }
    if not live:
        report["stop_reason"] = "dry_run"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0, report, path
    try:
        report["source_hashes"] = verify_freeze()
    except ValueError:
        report["stop_reason"] = "freeze_mismatch"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 2, report, path
    current = settings or Settings()
    if current.ai_api_key is None or not current.ai_api_key.get_secret_value().strip():
        report["stop_reason"] = "missing_api_key"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 2, report, path
    config = OpenAIReviewConfig(
        api_key=current.ai_api_key,
        model=model,
        reasoning_effort=current.ai_reasoning_effort,
        vision_enabled=True,
        request_timeout_seconds=current.ai_timeout_seconds,
        total_timeout_seconds=current.ai_total_timeout_seconds,
        max_output_tokens=current.ai_max_output_tokens,
    )
    records: list[dict[str, object]] = []
    report["executed"] = True
    for case in cases:
        started = time.perf_counter()
        try:
            result = await analyzer(case.review, config)
        except ProviderError as error:
            report["cases"] = records
            report["stop_reason"] = error.code
            path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            return 1, report, path
        grade = grade_case(case, result, model)
        checks = result.report.get("checks")
        check_list = checks if isinstance(checks, list) else []
        records.append(
            {
                "id": case.identifier,
                "rationale": case.rationale,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "source": result.report.get("source"),
                "model": result.model_name,
                "actual_outcome": grade["actual_outcome"],
                "score": result.score,
                "needs_master_review": result.needs_master_review,
                "check_statuses": {
                    str(item.get("code")): item.get("status")
                    for item in check_list
                    if isinstance(item, dict)
                },
                "grade": grade,
            }
        )
    report["cases"] = records
    metrics = _metrics(records, cases)
    report["metrics"] = metrics
    report["stop_reason"] = None
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return (0 if metrics["passed"] == len(cases) else 1), report, path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute", action="store_true", help="call the provider after hash verification"
    )
    parser.add_argument("--key-file", type=Path, help="secret file used only with --execute")
    parser.add_argument("--model", default="gpt-5.4")
    parser.add_argument("--output-root", type=Path, default=OUTPUT_ROOT)
    args = parser.parse_args()
    if args.execute and args.key_file is None:
        parser.error("--execute requires --key-file")
    settings = _settings_from_key_file(args.key_file) if args.key_file else None
    code, report, path = asyncio.run(
        run_holdout(
            live=args.execute, output_root=args.output_root, settings=settings, model=args.model
        )
    )
    print(
        json.dumps(
            {
                "output": str(path),
                "executed": report["executed"],
                "stop_reason": report["stop_reason"],
            }
        )
    )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
