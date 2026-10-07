"""Opt-in live AI acceptance checks in a disposable PostgreSQL test schema."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import UUID, uuid4

from anyio import CapacityLimiter
from PIL import Image, ImageDraw
from pydantic import SecretStr
from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.frontend_test_server import (  # noqa: E402
    _drop_schema,
    _read_test_database_url,
    _require_test_database_url,
    _run_migrations,
    _schema_url,
)

from naryadai.application.contracts import Completion, MaterialLine, OrderAction  # noqa: E402
from naryadai.application.orders import create_order, execute_action  # noqa: E402
from naryadai.application.photos import upload_photo  # noqa: E402
from naryadai.application.queries import order_detail  # noqa: E402
from naryadai.config import Settings  # noqa: E402
from naryadai.domain.lifecycle import AiAssessment, WorkOrderStatus  # noqa: E402
from naryadai.infrastructure.database import Database  # noqa: E402
from naryadai.infrastructure.models import (  # noqa: E402
    AIReview,
    AIReviewJob,
    Equipment,
    FaultCode,
    Material,
    PhotoKind,
    TimeNorm,
    WorkOrder,
)
from naryadai.infrastructure.photo_store import PhotoStore  # noqa: E402
from naryadai.worker import _review_once  # noqa: E402


def schematic(guarded: bool, label: str) -> bytes:
    """Clearly synthetic non-personal evidence; not an accuracy benchmark."""
    image = Image.new("RGB", (640, 400), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((65, 115, 550, 305), outline="navy", width=8)
    draw.rectangle((105, 75, 255, 115), outline="navy", width=8)
    draw.ellipse((375, 150, 485, 260), outline="black", width=8)
    if guarded:
        draw.rectangle((350, 125, 510, 285), fill="lightgray", outline="green", width=8)
        for x, y in ((360, 135), (500, 135), (360, 275), (500, 275)):
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill="black")
    draw.text((30, 350), "SYNTHETIC TRAINING DIAGRAM - " + label, fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88)
    return buffer.getvalue()


async def scenario(database, data, settings, store, name: str) -> dict:
    from test_order_commands import _create_body

    started_clock = time.monotonic()
    now = datetime.now(UTC)
    body = _create_body(data).model_copy(
        update={
            "description": "Установить отсутствующий защитный кожух привода конвейера.",
        }
    )
    with patch("naryadai.application.orders._now", return_value=now - timedelta(minutes=35)):
        result = await create_order(database, data["master"], body, "live-create-" + uuid4().hex)
    order_id = UUID(result["order_id"])

    async def photo(kind: PhotoKind, guarded: bool):
        nonlocal result
        result = await upload_photo(
            database,
            data["master"] if kind is PhotoKind.BEFORE else data["first"],
            order_id,
            kind=kind,
            expected_version=result["version"],
            captured_at=now - timedelta(minutes=34) if kind is PhotoKind.BEFORE else now,
            idempotency_key="live-photo-" + uuid4().hex,
            raw=schematic(guarded, name + " " + kind.value),
            content_type="image/jpeg",
            photo_store=store,
            limiter=CapacityLimiter(1),
            ai_share_allowed=True,
        )

    if name == "paired_positive":
        await photo(PhotoKind.BEFORE, False)
    for action, minutes in (("accept", 34), ("start", 33)):
        with patch(
            "naryadai.application.orders._now", return_value=now - timedelta(minutes=minutes)
        ):
            result = await execute_action(
                database,
                data["first"],
                order_id,
                OrderAction(action=action, expected_version=result["version"]),
                "live-" + action + "-" + uuid4().hex,
            )
    negative = name == "missing_after_excess_material"
    if not negative:
        await photo(PhotoKind.AFTER, True)
    result = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(
            action="complete",
            expected_version=result["version"],
            completion=Completion(
                work_description=(
                    "Кожух не установлен, ремонт не выполнен. Списано 50 кожухов, результата нет."
                    if negative
                    else "Установлен один защитный кожух. Четыре крепления затянуты, "
                    "вращающиеся детали полностью закрыты, проверены зазоры и пробный пуск."
                ),
                fault_code_id=data["fault"],
                materials=(
                    MaterialLine(material_id=data["material"], quantity="50" if negative else "1"),
                ),
            ),
        ),
        "live-complete-" + uuid4().hex,
    )
    assert await _review_once(database, settings=settings, now=datetime.now(UTC)) == 1
    async with database.sessions() as session:
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        order = await session.get(WorkOrder, order_id)
        assert job is not None and job.status == "completed", "AI job did not complete"
        assert review is not None and review.report["source"] == "openai", (
            "No actual model response"
        )
        assert review.model_name == settings.ai_model
        assert review.score is not None and review.verdict is not None, "AI assessment was lost"
        assert order is not None
        original_score, verdict = review.score, review.verdict
        manual, version, status = review.needs_master_review, order.version, order.status
    feedback = await order_detail(database, data["first"], order_id)
    assert feedback.executor_feedback[0].score == original_score, "Executor cannot see AI score"
    if negative:
        assert verdict is AiAssessment.REWORK_REQUIRED and status is WorkOrderStatus.REWORK
        master_decision = "not_closed_rework_required"
    else:
        assert verdict in {AiAssessment.ACCEPTED, AiAssessment.ACCEPTED_WITH_REMARKS}
        assert original_score >= 3 and status is WorkOrderStatus.AI_REVIEW
        closed = await execute_action(
            database,
            data["master"],
            order_id,
            OrderAction(
                action="override_close" if manual else "close",
                expected_version=version,
                reason="Synthetic verification: master inspected the repair and limitations.",
                master_score=4,
            ),
            "live-master-close-" + uuid4().hex,
        )
        assert closed["status"] == "closed"
        feedback = await order_detail(database, data["first"], order_id)
        assert feedback.executor_feedback[0].score == original_score
        assert feedback.executor_feedback[0].master_score == 4
        master_decision = "closed_score_4_original_ai_preserved"
    return {
        "scenario": name,
        "status": "PASS",
        "source": "openai",
        "model": settings.ai_model,
        "ai_verdict": verdict.value,
        "ai_score": original_score,
        "needs_master_review": manual,
        "master_decision": master_decision,
        "executor_feedback_checked": True,
        "durable_job": "completed",
        "elapsed_seconds": round(time.monotonic() - started_clock, 2),
    }


async def verify(key_file: Path, model: str) -> dict:
    sys.path.insert(0, str(ROOT / "tests/integration"))
    from test_order_commands import _fixture

    url = _require_test_database_url(_read_test_database_url())
    schema = "e2e_" + uuid4().hex
    isolated_url = _schema_url(url, schema)
    admin, database = Database(url), Database(isolated_url)
    created = False
    try:
        async with admin.engine.begin() as connection:
            await connection.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
        created = True
        await asyncio.to_thread(_run_migrations, isolated_url)
        data = await _fixture(database)
        async with database.sessions.begin() as session:
            equipment = await session.get(Equipment, data["equipment"])
            fault = await session.get(FaultCode, data["fault"])
            material = await session.get(Material, data["material"])
            equipment.equipment_type = "Конвейер"
            fault.name = "Отсутствует защитный кожух привода"
            material.name, material.unit = "Защитный кожух", "шт"
            session.add(
                TimeNorm(fault_code_id=data["fault"], equipment_type="Конвейер", minutes=40)
            )
        with TemporaryDirectory(prefix="live-pipeline-", dir=ROOT / "tmp") as photo_dir:
            settings = Settings(
                _env_file=None,
                environment="test",
                photo_root=Path(photo_dir),
                ai_api_key=SecretStr(key_file.read_text().strip()),
                ai_model=model,
                ai_vision_enabled=True,
            )
            store = PhotoStore(
                settings.photo_root,
                max_bytes=settings.photo_max_bytes,
                max_pixels=settings.photo_max_pixels,
                max_dimension=settings.photo_max_dimension,
                output_max_bytes=settings.photo_output_max_bytes,
            )
            scenarios = []
            for name in ("paired_positive", "after_only_positive", "missing_after_excess_material"):
                scenarios.append(await scenario(database, data, settings, store, name))
        return {
            "status": "PASS",
            "synthetic_only": True,
            "production_database_changed": False,
            "vision_enabled": True,
            "schema_removed_after_run": True,
            "scenarios": scenarios,
        }
    finally:
        await database.dispose()
        if created:
            await _drop_schema(url, schema)
        await admin.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--model", default="gpt-5.4")
    args = parser.parse_args()
    if not args.execute:
        parser.error("Three paid synthetic requests require --execute")
    path = ROOT / "tmp/review/technical-live-pipeline.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        report = asyncio.run(verify(args.key_file, args.model))
    except Exception as error:
        # Do not echo provider/driver payloads or secrets.
        report = {"status": "FAIL", "error_type": type(error).__name__}
        path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
        return 1
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
