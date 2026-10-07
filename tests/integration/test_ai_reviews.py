"""AI review queue integration boundaries."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import func, select
from test_order_commands import _create_body, _fixture

import naryadai.ai.repair_review as repair_review
from naryadai.ai import OpenAIReviewConfig, ProviderError, ReviewResult
from naryadai.application.common import OperationError
from naryadai.application.contracts import Completion, MaterialLine, OrderAction
from naryadai.application.orders import apply_review, create_order, execute_action
from naryadai.domain.lifecycle import AiAssessment, WorkOrderStatus
from naryadai.infrastructure.models import (
    AIReview,
    AIReviewJob,
    Material,
    MaterialUsage,
    Photo,
    PhotoKind,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio


async def _completed(database):
    data = await _fixture(database)
    created = await create_order(database, data["master"], _create_body(data), "ai-create-key-0001")
    order_id = UUID(created["order_id"])
    accepted = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="accept", expected_version=1),
        "ai-accept-key-0001",
    )
    started = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="start", expected_version=accepted["version"]),
        "ai-start-key-0001",
    )
    completed = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(
            action="complete",
            expected_version=started["version"],
            completion=Completion(
                work_description="Repaired pump seal",
                fault_code_id=data["fault"],
                materials=(MaterialLine(material_id=data["material"], quantity="1.000"),),
            ),
        ),
        "ai-complete-key-0001",
    )
    return data, order_id, completed


async def test_completion_enqueues_one_durable_review_job_and_replay_does_not_duplicate(database):
    data, order_id, completed = await _completed(database)
    replay = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(
            action="complete",
            expected_version=3,
            completion=Completion(
                work_description="Repaired pump seal",
                fault_code_id=data["fault"],
                materials=(MaterialLine(material_id=data["material"], quantity="1.000"),),
            ),
        ),
        "ai-complete-key-0001",
    )
    assert replay == completed
    async with database.sessions() as session:
        jobs = list(
            (
                await session.scalars(
                    select(AIReviewJob).where(AIReviewJob.work_order_id == order_id)
                )
            ).all()
        )
        assert len(jobs) == 1
        assert jobs[0].submission_version == completed["version"]
        assert jobs[0].status == "pending"
        assert (
            await session.scalar(
                select(func.count())
                .select_from(MaterialUsage)
                .where(MaterialUsage.work_order_id == order_id)
            )
            == 1
        )
        assert (
            await session.scalar(
                select(func.count())
                .select_from(WorkOrderEvent)
                .where(WorkOrderEvent.work_order_id == order_id)
            )
            == 4
        )


async def test_review_job_can_apply_after_comment_version_change(database):
    _data, order_id, completed = await _completed(database)
    changed = await execute_action(
        database,
        _data["first"],
        order_id,
        OrderAction(
            action="comment",
            expected_version=completed["version"],
            comment="Additional note",
        ),
        "ai-comment-key-0001",
    )
    assert changed["version"] > completed["version"]

    from naryadai.ai import ReviewResult
    from naryadai.application.ai_reviews import process_ai_review_jobs
    from naryadai.domain.lifecycle import AiAssessment

    async def accepted(_evidence, _config):
        return ReviewResult(
            verdict=AiAssessment.ACCEPTED,
            score=4,
            needs_master_review=False,
            explanation="Review passed",
            model_name="fake",
            report={
                "schema_version": 1,
                "source": "rules",
                "confidence": 1.0,
                "checks": [],
                "timing": {},
                "limitations": [],
                "model_assessment": "accepted",
            },
        )

    assert (
        await process_ai_review_jobs(
            database,
            config=OpenAIReviewConfig(api_key=None),
            now=datetime.now(UTC),
            analyzer=accepted,
        )
        == 1
    )
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(AIReview)) == 1
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        assert job is not None
        assert job.status == "completed"


def _accepted_result() -> ReviewResult:
    return ReviewResult(
        AiAssessment.ACCEPTED,
        4,
        False,
        "Review passed",
        "fake",
        {
            "schema_version": 1,
            "source": "rules",
            "confidence": 1.0,
            "checks": [],
            "timing": {},
            "limitations": [],
            "model_assessment": "accepted",
        },
    )


async def test_retrying_provider_failure_exhausts_to_honest_manual_review(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    _data, order_id, _completed_result = await _completed(database)
    now, calls = datetime.now(UTC) + timedelta(minutes=1), 0

    async def unavailable(_evidence, _config):
        nonlocal calls
        calls += 1
        raise ProviderError("http_429", retryable=True)

    for when in (now, now + timedelta(seconds=16), now + timedelta(seconds=47)):
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=when, analyzer=unavailable
        )

    assert calls == 3
    async with database.sessions() as session:
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        assert job is not None and job.status == "completed"
        assert job.attempts == 3 and job.last_error_code == "http_429"
        assert review is not None
        assert (
            review.verdict is None and review.score is None and review.needs_master_review is True
        )
        assert review.report["source"] == "unavailable"


async def test_simultaneous_workers_claim_one_job_and_call_analyzer_once(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    _data, _order_id, _completed_result = await _completed(database)
    now, entered, release, calls = (
        datetime.now(UTC) + timedelta(minutes=1),
        asyncio.Event(),
        asyncio.Event(),
        0,
    )

    async def blocked(_evidence, _config):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return _accepted_result()

    first = asyncio.create_task(
        process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=blocked
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    second = await process_ai_review_jobs(
        database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=blocked
    )
    release.set()
    assert await first == 1
    assert second == 0 and calls == 1


async def test_changed_lease_token_during_analysis_cannot_apply_result(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    _data, order_id, _completed_result = await _completed(database)
    now = datetime.now(UTC) + timedelta(minutes=1)

    async def lose_lease(_evidence, _config):
        async with database.sessions.begin() as session:
            job = await session.scalar(
                select(AIReviewJob).where(AIReviewJob.work_order_id == order_id).with_for_update()
            )
            assert job is not None
            job.lease_token = uuid4()
        return _accepted_result()

    assert (
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=lose_lease
        )
        == 0
    )
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(AIReview)) == 0
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        assert job is not None and job.status == "running"


async def test_cancelled_order_while_analyzer_runs_is_not_reviewed(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, completed = await _completed(database)
    now = datetime.now(UTC) + timedelta(minutes=1)

    async def cancel_order(_evidence, _config):
        await execute_action(
            database,
            data["master"],
            order_id,
            OrderAction(
                action="cancel",
                expected_version=completed["version"],
                reason="Work is no longer needed.",
            ),
            "ai-cancel-while-running",
        )
        return _accepted_result()

    assert (
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=cancel_order
        )
        == 0
    )
    async with database.sessions() as session:
        order = await session.get(WorkOrder, order_id)
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        assert order is not None and order.status is WorkOrderStatus.CANCELLED
        assert job is not None and job.status == "stale"
        assert await session.scalar(select(func.count()).select_from(AIReview)) == 0


async def test_expired_last_attempt_becomes_manual_without_provider_call(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    _data, order_id, _completed_result = await _completed(database)
    now = datetime.now(UTC) + timedelta(minutes=1)
    async with database.sessions.begin() as session:
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        assert job is not None
        job.status, job.attempts, job.lease_token = "running", 3, uuid4()
        job.lease_until = now - timedelta(seconds=1)

    async def must_not_call(_evidence, _config):
        raise AssertionError("exhausted crash recovery must not call the provider")

    assert (
        await process_ai_review_jobs(
            database,
            config=OpenAIReviewConfig(api_key=None),
            now=now,
            max_attempts=3,
            analyzer=must_not_call,
        )
        == 1
    )
    async with database.sessions() as session:
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        assert job is not None and job.status == "completed"
        assert job.attempts == 3 and job.last_error_code == "attempts_exhausted"
        assert review is not None and review.needs_master_review is True


async def test_reassignment_and_new_submission_make_old_claim_stale(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, completed = await _completed(database)
    now = datetime.now(UTC) + timedelta(minutes=1)

    async def replace_submission(_evidence, _config):
        reviewed = await apply_review(
            database,
            order_id,
            expected_order_version=completed["version"],
            submission_version=completed["version"],
            verdict=AiAssessment.REWORK_REQUIRED,
            needs_master_review=False,
            score=1,
            explanation="A new attempt is needed.",
            model_name="controlled",
        )
        reassigned = await execute_action(
            database,
            data["master"],
            order_id,
            OrderAction(
                action="reassign",
                expected_version=reviewed["version"],
                executor_id=data["second"].employee_id,
                reason="Move repair to next shift.",
            ),
            "ai-reassign-while-running",
        )
        accepted = await execute_action(
            database,
            data["second"],
            order_id,
            OrderAction(action="accept", expected_version=reassigned["version"]),
            "ai-second-accept",
        )
        started = await execute_action(
            database,
            data["second"],
            order_id,
            OrderAction(action="start", expected_version=accepted["version"]),
            "ai-second-start",
        )
        await execute_action(
            database,
            data["second"],
            order_id,
            OrderAction(
                action="complete",
                expected_version=started["version"],
                completion=Completion(
                    work_description="Second executor repaired the seal.",
                    fault_code_id=data["fault"],
                    no_materials_reason="No additional material was needed.",
                ),
            ),
            "ai-second-complete",
        )
        return _accepted_result()

    assert (
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=replace_submission
        )
        == 0
    )
    async with database.sessions() as session:
        jobs = list(
            (
                await session.scalars(
                    select(AIReviewJob).where(AIReviewJob.work_order_id == order_id)
                )
            ).all()
        )
        assert len(jobs) == 2
        old_job = next(job for job in jobs if job.submission_version == completed["version"])
        new_job = next(job for job in jobs if job.submission_version != completed["version"])
        assert old_job.status == "stale" and new_job.status == "pending"


async def test_current_attempt_evidence_excludes_old_photos_and_preserves_cross_order_privacy(
    database,
):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, completed = await _completed(database)
    reviewed = await apply_review(
        database,
        order_id,
        expected_order_version=completed["version"],
        submission_version=completed["version"],
        verdict=AiAssessment.REWORK_REQUIRED,
        needs_master_review=False,
        score=1,
        explanation="Do repair again.",
        model_name="controlled",
    )
    restarted = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="start", expected_version=reviewed["version"]),
        "ai-evidence-restart",
    )
    paused = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(
            action="pause", expected_version=restarted["version"], reason="Awaiting test rig."
        ),
        "ai-evidence-pause",
    )
    resumed = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="resume", expected_version=paused["version"]),
        "ai-evidence-resume",
    )
    resubmitted = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(
            action="complete",
            expected_version=resumed["version"],
            completion=Completion(
                work_description="Installed a fresh seal after retest.",
                fault_code_id=data["fault"],
                materials=(MaterialLine(material_id=data["material"], quantity="2.000"),),
            ),
        ),
        "ai-evidence-complete",
    )
    other = await create_order(database, data["master"], _create_body(data), "ai-evidence-other")
    other_id, reused_hash = UUID(other["order_id"]), "a" * 64
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, order_id)
        assert order is not None
        session.add_all(
            [
                Photo(
                    work_order_id=order_id,
                    kind=PhotoKind.AFTER,
                    attempt=1,
                    storage_key="test/old-attempt.jpg",
                    author_id=data["first"].employee_id,
                    sha256="b" * 64,
                    size_bytes=10,
                    uploaded_at=order.completed_at,
                    captured_at=order.completed_at,
                ),
                Photo(
                    work_order_id=order_id,
                    kind=PhotoKind.AFTER,
                    attempt=order.attempt,
                    storage_key="test/current-attempt.jpg",
                    author_id=data["first"].employee_id,
                    sha256=reused_hash,
                    size_bytes=10,
                    uploaded_at=order.completed_at,
                    captured_at=order.completed_at - timedelta(seconds=1),
                ),
                Photo(
                    work_order_id=other_id,
                    kind=PhotoKind.AFTER,
                    attempt=1,
                    storage_key="test/other-order.jpg",
                    author_id=data["first"].employee_id,
                    sha256=reused_hash,
                    size_bytes=10,
                    uploaded_at=order.completed_at,
                    captured_at=order.completed_at,
                ),
            ]
        )

    seen = []

    async def capture(evidence, _config):
        seen.append(evidence)
        return _accepted_result()

    now = datetime.now(UTC) + timedelta(minutes=1)
    assert (
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=capture
        )
        == 0
    )
    assert (
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=capture
        )
        == 1
    )
    evidence = seen[0]
    assert [(m.name, m.quantity) for m in evidence.materials] == [("Seal", "2.000")]
    assert [(p.sha256, p.reused_exact) for p in evidence.photos] == [(reused_hash, True)]
    assert evidence.active_minutes is not None and evidence.active_minutes >= 0
    assert evidence.paused_minutes is not None and evidence.paused_minutes >= 0
    assert evidence.elapsed_minutes is not None
    assert evidence.active_minutes + evidence.paused_minutes == pytest.approx(
        evidence.elapsed_minutes
    )
    assert str(other_id) not in evidence.known_identifiers
    assert resubmitted["version"] > completed["version"]


async def test_worker_exports_only_per_photo_ai_opted_in_image_bytes(database):
    """A private repair photo remains useful locally but is never attached to provider input."""

    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, _completed_result = await _completed(database)
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, order_id)
        assert order is not None
        session.add_all(
            [
                Photo(
                    work_order_id=order_id,
                    kind=PhotoKind.AFTER,
                    attempt=order.attempt,
                    storage_key="private-photo.jpg",
                    author_id=data["first"].employee_id,
                    sha256="c" * 64,
                    size_bytes=10,
                    uploaded_at=now,
                    ai_share_allowed=False,
                ),
                Photo(
                    work_order_id=order_id,
                    kind=PhotoKind.AFTER,
                    attempt=order.attempt,
                    storage_key="approved-photo.jpg",
                    author_id=data["first"].employee_id,
                    sha256="d" * 64,
                    size_bytes=10,
                    uploaded_at=now + timedelta(microseconds=1),
                    ai_share_allowed=True,
                ),
            ]
        )

    class ImageStore:
        def __init__(self) -> None:
            self.read_keys: list[str] = []

        def read(self, key: str) -> bytes:
            self.read_keys.append(key)
            return b"explicitly-approved-image"

    store = ImageStore()
    seen = []

    async def capture(evidence, _config):
        seen.append(evidence)
        return _accepted_result()

    assert (
        await process_ai_review_jobs(
            database,
            config=OpenAIReviewConfig(api_key=SecretStr("test-key"), vision_enabled=True),
            now=now + timedelta(minutes=1),
            photo_store=store,  # type: ignore[arg-type]
            analyzer=capture,
        )
        == 1
    )
    assert store.read_keys == ["approved-photo.jpg"]
    assert [(photo.sha256, photo.image_bytes) for photo in seen[0].photos] == [
        ("c" * 64, None),
        ("d" * 64, b"explicitly-approved-image"),
    ]


async def test_material_baseline_ignores_synthetic_future_and_obsolete_submissions(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, _completed_result = await _completed(database)
    async with database.sessions.begin() as session:
        current = await session.get(WorkOrder, order_id)
        assert current is not None and current.completed_at is not None
        current_usage = await session.scalar(
            select(MaterialUsage).where(MaterialUsage.work_order_id == current.id)
        )
        assert current_usage is not None
        current_usage.quantity = Decimal("3.000")
        submitted_at = current.completed_at

        def historical_order(
            suffix: str, *, closed_at: datetime, synthetic: bool = False
        ) -> WorkOrder:
            return WorkOrder(
                number=f"HISTORY-{suffix}",
                work_type=WorkType.UNPLANNED,
                description="Historical seal replacement",
                area_id=data["area"],
                equipment_id=data["equipment"],
                executor_id=data["first"].employee_id,
                master_id=data["master"].employee_id,
                priority=Priority.HIGH,
                status=WorkOrderStatus.CLOSED,
                issued_at=closed_at - timedelta(hours=3),
                deadline=closed_at - timedelta(hours=2),
                started_at=closed_at - timedelta(hours=2),
                completed_at=closed_at - timedelta(hours=1),
                closed_at=closed_at,
                fault_code_id=data["fault"],
                work_description="Seal replaced.",
                version=2,
                attempt=1,
                last_submission_version=2,
                is_synthetic=synthetic,
            )

        genuine = [
            historical_order(str(index), closed_at=submitted_at - timedelta(days=index + 1))
            for index in range(4)
        ]
        synthetic = historical_order(
            "synthetic", closed_at=submitted_at - timedelta(days=8), synthetic=True
        )
        future = historical_order("future", closed_at=submitted_at + timedelta(minutes=1))
        session.add_all([*genuine, synthetic, future])
        await session.flush()
        for history in genuine:
            session.add(
                MaterialUsage(
                    work_order_id=history.id,
                    material_id=data["material"],
                    quantity=Decimal("1.000"),
                    submission_version=2,
                )
            )
        session.add_all(
            [
                MaterialUsage(
                    work_order_id=synthetic.id,
                    material_id=data["material"],
                    quantity=Decimal("100.000"),
                    submission_version=2,
                ),
                MaterialUsage(
                    work_order_id=future.id,
                    material_id=data["material"],
                    quantity=Decimal("100.000"),
                    submission_version=2,
                ),
                MaterialUsage(
                    work_order_id=genuine[0].id,
                    material_id=data["material"],
                    quantity=Decimal("100.000"),
                    submission_version=1,
                ),
            ]
        )

    seen = []

    async def capture(evidence, _config):
        seen.append(evidence)
        return _accepted_result()

    assert (
        await process_ai_review_jobs(
            database,
            config=OpenAIReviewConfig(api_key=None),
            now=datetime.now(UTC) + timedelta(minutes=1),
            analyzer=capture,
        )
        == 1
    )

    material = seen[0].materials[0]
    assert material.quantity == "3.000"
    assert material.historical_median_quantity is None
    assert material.historical_sample_count is None


async def test_material_baseline_uses_bounded_even_and_odd_historical_medians(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, _completed_result = await _completed(database)
    async with database.sessions.begin() as session:
        current = await session.get(WorkOrder, order_id)
        assert current is not None and current.completed_at is not None
        current_usage = await session.scalar(
            select(MaterialUsage).where(MaterialUsage.work_order_id == current.id)
        )
        assert current_usage is not None
        current_usage.quantity = Decimal("76.500")
        odd_material = Material(code="M-ODD", name="Odd median seal", unit="piece")
        session.add(odd_material)
        await session.flush()
        session.add(
            MaterialUsage(
                work_order_id=current.id,
                material_id=odd_material.id,
                quantity=Decimal("6.000"),
                submission_version=current.last_submission_version,
            )
        )
        submitted_at = current.completed_at

        histories: list[WorkOrder] = []
        for index in range(52):
            closed_at = submitted_at - timedelta(days=index + 1)
            history = WorkOrder(
                number=f"BASELINE-{index}",
                work_type=WorkType.UNPLANNED,
                description="Historical seal replacement",
                area_id=data["area"],
                equipment_id=data["equipment"],
                executor_id=data["first"].employee_id,
                master_id=data["master"].employee_id,
                priority=Priority.HIGH,
                status=WorkOrderStatus.CLOSED,
                issued_at=closed_at - timedelta(hours=3),
                deadline=closed_at - timedelta(hours=2),
                started_at=closed_at - timedelta(hours=2),
                completed_at=closed_at - timedelta(hours=1),
                closed_at=closed_at,
                fault_code_id=data["fault"],
                work_description="Seal replaced.",
                version=2,
                attempt=1,
                last_submission_version=2,
                is_synthetic=False,
            )
            histories.append(history)
        session.add_all(histories)
        await session.flush()
        for index, history in enumerate(histories):
            # The two older extreme values prove the query keeps only its 50 newest rows.
            quantity = Decimal(index + 1) if index < 50 else Decimal(10_000 + index)
            session.add(
                MaterialUsage(
                    work_order_id=history.id,
                    material_id=data["material"],
                    quantity=quantity,
                    submission_version=2,
                )
            )
        for history, quantity in zip(histories[:5], (1, 1, 2, 10, 11), strict=True):
            session.add(
                MaterialUsage(
                    work_order_id=history.id,
                    material_id=odd_material.id,
                    quantity=Decimal(quantity),
                    submission_version=2,
                )
            )

    seen = []

    async def capture(evidence, _config):
        seen.append(evidence)
        return _accepted_result()

    assert (
        await process_ai_review_jobs(
            database,
            config=OpenAIReviewConfig(api_key=None),
            now=datetime.now(UTC) + timedelta(minutes=1),
            analyzer=capture,
        )
        == 1
    )

    evidence = seen[0]
    materials = {material.name: material for material in evidence.materials}
    assert materials["Seal"].historical_median_quantity == "25.500"
    assert materials["Seal"].historical_sample_count == 50
    assert materials["Odd median seal"].historical_median_quantity == "2.000"
    assert materials["Odd median seal"].historical_sample_count == 5

    payload = repair_review._payload(evidence, OpenAIReviewConfig(api_key=SecretStr("test-key")))
    user = payload["input"][1]
    assert isinstance(user, dict)
    content = user["content"]
    assert isinstance(content, list) and isinstance(content[0], dict)
    facts = json.loads(str(content[0]["text"]))
    payload_materials = {item["name"]: item for item in facts["materials"]}
    assert payload_materials == {
        "Seal": {
            "name": "Seal",
            "unit": "piece",
            "quantity": "76.500",
            "historical_median_quantity": "25.500",
            "historical_sample_count": 50,
        },
        "Odd median seal": {
            "name": "Odd median seal",
            "unit": "piece",
            "quantity": "6.000",
            "historical_median_quantity": "2.000",
            "historical_sample_count": 5,
        },
    }
    local = repair_review.manual_review_result(evidence, source="rules")
    check = next(item for item in local.report["checks"] if item["code"] == "materials")
    assert check["status"] == "warning"
    assert "исторической медианы" in check["detail"]


async def test_master_override_score_is_reasoned_idempotent_and_audited(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, _completed_result = await _completed(database)
    now = datetime.now(UTC) + timedelta(minutes=1)

    async def manual(_evidence, _config):
        return ReviewResult(
            None,
            None,
            True,
            "Master must decide.",
            "fake-manual",
            {
                "schema_version": 1,
                "source": "unavailable",
                "confidence": None,
                "checks": [],
                "timing": {},
                "limitations": ["Provider unavailable"],
                "model_assessment": None,
            },
        )

    assert (
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=manual
        )
        == 1
    )
    async with database.sessions() as session:
        order = await session.get(WorkOrder, order_id)
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        assert order is not None and review is not None
        version, original_score = order.version, review.score

    with pytest.raises(OperationError):
        await execute_action(
            database,
            data["first"],
            order_id,
            OrderAction(
                action="override_close", expected_version=version, reason="Master decision."
            ),
            "ai-unauthorized-override",
        )
    decision = OrderAction(
        action="override_close",
        expected_version=version,
        reason="Evidence reviewed by the responsible master.",
        master_score=5,
    )
    closed = await execute_action(
        database, data["master"], order_id, decision, "ai-master-override"
    )
    replay = await execute_action(
        database, data["master"], order_id, decision, "ai-master-override"
    )
    assert replay == closed
    async with database.sessions() as session:
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        event = await session.scalar(
            select(WorkOrderEvent).where(
                WorkOrderEvent.work_order_id == order_id, WorkOrderEvent.action == "override_close"
            )
        )
        assert review is not None and review.score == original_score and review.master_score == 5
        assert event is not None
        assert event.reason == "Evidence reviewed by the responsible master."
        assert event.details["master_score"] == 5


async def test_scored_close_requires_reason_and_preserves_ai_score(database):
    from pydantic import ValidationError

    from naryadai.application.ai_reviews import process_ai_review_jobs

    data, order_id, _completed_result = await _completed(database)

    async def accepted(_evidence, _config):
        return _accepted_result()

    assert (
        await process_ai_review_jobs(
            database,
            config=OpenAIReviewConfig(api_key=None),
            now=datetime.now(UTC) + timedelta(minutes=1),
            analyzer=accepted,
        )
        == 1
    )
    async with database.sessions() as session:
        order = await session.get(WorkOrder, order_id)
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        assert order is not None and review is not None
        version, ai_score = order.version, review.score

    with pytest.raises(ValidationError, match="reason is required"):
        OrderAction(action="close", expected_version=version, master_score=5)
    result = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="close",
            expected_version=version,
            reason="Reviewed completion evidence before closure.",
            master_score=5,
        ),
        "ai-scored-close",
    )
    assert result["status"] == WorkOrderStatus.CLOSED.value
    async with database.sessions() as session:
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        assert review is not None and review.score == ai_score and review.master_score == 5


async def test_master_can_return_uncertain_review_without_inventing_a_score(database):
    data, order_id, completed = await _completed(database)
    reviewed = await apply_review(
        database,
        order_id,
        expected_order_version=completed["version"],
        submission_version=completed["version"],
        verdict=None,
        score=None,
        needs_master_review=True,
        explanation="Insufficient evidence; the master must inspect the completion.",
        model_name="uncertain-test-model",
    )
    with pytest.raises(OperationError, match="closed_order_requires_ai_or_master_score"):
        await execute_action(
            database,
            data["master"],
            order_id,
            OrderAction(
                action="override_close",
                expected_version=reviewed["version"],
                reason="Inspected the available evidence.",
            ),
            "uncertain-scoreless-close",
        )
    returned = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="request_rework",
            expected_version=reviewed["version"],
            reason="Please provide the missing test readings.",
        ),
        "uncertain-return-no-score",
    )
    assert returned["status"] == "rework"
    async with database.sessions() as session:
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        assert review is not None and review.score is None and review.master_score is None


async def test_reassigned_executor_does_not_inherit_previous_repair_authors_feedback(database):
    from naryadai.application.queries import order_detail

    data, order_id, completed = await _completed(database)
    reviewed = await apply_review(
        database,
        order_id,
        expected_order_version=completed["version"],
        submission_version=completed["version"],
        verdict=AiAssessment.REWORK_REQUIRED,
        score=1,
        needs_master_review=False,
        explanation="The earlier repair is incomplete.",
        model_name="feedback-test-model",
    )
    first_view = await order_detail(database, data["first"], order_id)
    assert len(first_view.executor_feedback) == 1
    reassigned = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="reassign",
            expected_version=reviewed["version"],
            executor_id=data["second"].employee_id,
            reason="A second specialist will repair it.",
        ),
        "reassign-feedback-privacy",
    )
    second_view = await order_detail(database, data["second"], order_id)
    assert second_view.executor_feedback == [] and second_view.reviews == []
    assert len((await order_detail(database, data["master"], order_id)).reviews) == 1
    with pytest.raises(OperationError):
        await order_detail(database, data["first"], order_id)
    for action in ("accept", "start"):
        reassigned = await execute_action(
            database,
            data["second"],
            order_id,
            OrderAction(action=action, expected_version=reassigned["version"]),
            "second-feedback-" + action,
        )
    completed_again = await execute_action(
        database,
        data["second"],
        order_id,
        OrderAction(
            action="complete",
            expected_version=reassigned["version"],
            completion=Completion(
                work_description="Repaired and checked the previous fault.",
                fault_code_id=data["fault"],
                no_materials_reason="Reused the installed replacement.",
            ),
        ),
        "second-feedback-complete",
    )
    await apply_review(
        database,
        order_id,
        expected_order_version=completed_again["version"],
        submission_version=completed_again["version"],
        verdict=AiAssessment.ACCEPTED,
        score=4,
        needs_master_review=True,
        explanation="Repair report is consistent.",
        model_name="feedback-test-model",
    )
    second_view = await order_detail(database, data["second"], order_id)
    assert len(second_view.executor_feedback) == 1
    assert second_view.executor_feedback[0].score == 4
    assert second_view.executor_feedback[0].submission_version == completed_again["version"]
    assert len((await order_detail(database, data["master"], order_id)).reviews) == 2


async def test_quota_exhaustion_finishes_once_with_manual_review_and_no_retry(database):
    from naryadai.application.ai_reviews import process_ai_review_jobs

    _data, order_id, _submission = await _completed(database)
    now = datetime.now(UTC) + timedelta(minutes=1)
    calls = 0

    async def quota_error(_evidence, _config):
        nonlocal calls
        calls += 1
        raise ProviderError("quota_exhausted", retryable=False)

    assert (
        await process_ai_review_jobs(
            database, config=OpenAIReviewConfig(api_key=None), now=now, analyzer=quota_error
        )
        == 1
    )
    assert (
        await process_ai_review_jobs(
            database,
            config=OpenAIReviewConfig(api_key=None),
            now=now + timedelta(minutes=2),
            analyzer=quota_error,
        )
        == 0
    )
    assert calls == 1
    async with database.sessions() as session:
        job = await session.scalar(select(AIReviewJob).where(AIReviewJob.work_order_id == order_id))
        review = await session.scalar(select(AIReview).where(AIReview.work_order_id == order_id))
        order = await session.get(WorkOrder, order_id)
        assert job.status == "completed"
        assert job.attempts == 1
        assert job.last_error_code == "quota_exhausted"
        assert review.needs_master_review
        assert review.verdict is None and review.score is None
        assert review.report["source"] == "unavailable"
        assert any("API-квота" in line for line in review.report["limitations"])
        assert order.status == WorkOrderStatus.AI_REVIEW
