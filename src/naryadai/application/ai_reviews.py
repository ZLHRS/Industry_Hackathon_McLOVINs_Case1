"""Durable repair checks: short database leases, bounded I/O and atomic outcomes."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.ai import (
    OpenAIReviewConfig,
    ProviderError,
    ReviewInput,
    ReviewMaterial,
    ReviewPhoto,
    ReviewResult,
    analyze_review,
    manual_review_result,
)
from naryadai.application.common import OperationError
from naryadai.application.notification_engine import invalidate_order_views
from naryadai.application.orders import apply_review_in_session
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReviewJob,
    Employee,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    Photo,
    PhotoKind,
    TimeNorm,
    WorkOrder,
    WorkOrderEvent,
)
from naryadai.infrastructure.photo_store import PhotoStore, PhotoStoreError

Analyzer = Callable[[ReviewInput, OpenAIReviewConfig], Awaitable[ReviewResult]]


@dataclass(frozen=True, slots=True)
class _Claim:
    job_id: UUID
    order_id: UUID
    submission_version: int
    lease_token: UUID
    attempts: int
    exhausted: bool


def _utc(now: datetime) -> datetime:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(UTC)


async def _claim(
    database: Database, now: datetime, lease_seconds: int, max_attempts: int
) -> _Claim | None:
    async with database.sessions.begin() as session:
        job = await session.scalar(
            select(AIReviewJob)
            .where(
                or_(
                    AIReviewJob.status.in_(("pending", "retry"))
                    & (AIReviewJob.next_attempt_at <= now),
                    (AIReviewJob.status == "running") & (AIReviewJob.lease_until <= now),
                )
            )
            .order_by(AIReviewJob.next_attempt_at, AIReviewJob.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if job is None:
            return None
        # A worker may crash on its last attempt. Reclaim for a manual outcome,
        # never issue an unbounded series of paid requests after repeated crashes.
        exhausted = job.attempts >= max_attempts
        job.status = "running"
        job.attempts += int(not exhausted)
        token = uuid4()
        job.lease_token = token
        job.lease_until = now + timedelta(seconds=lease_seconds)
        job.updated_at = now
        order = await session.get(WorkOrder, job.work_order_id)
        if order is not None:
            await invalidate_order_views(session, order, now)
        return _Claim(
            job.id, job.work_order_id, job.submission_version, token, job.attempts, exhausted
        )


def _timing(order: WorkOrder, events: list[WorkOrderEvent]) -> tuple[float, float, float]:
    assert order.completed_at is not None
    start = order.started_at or order.completed_at
    previous = start
    status = WorkOrderStatus.IN_PROGRESS
    active = paused = 0.0
    for event in events:
        if (
            event.details.get("attempt", 1) != order.attempt
            or not start <= event.occurred_at <= order.completed_at
        ):
            continue
        elapsed = max(0.0, (event.occurred_at - previous).total_seconds() / 60)
        if status is WorkOrderStatus.IN_PROGRESS:
            active += elapsed
        elif status is WorkOrderStatus.PAUSED:
            paused += elapsed
        previous, status = event.occurred_at, event.to_status
    tail = max(0.0, (order.completed_at - previous).total_seconds() / 60)
    active += tail if status is WorkOrderStatus.IN_PROGRESS else 0
    paused += tail if status is WorkOrderStatus.PAUSED else 0
    return active, paused, (order.completed_at - start).total_seconds() / 60


async def _input(
    session: AsyncSession, claim: _Claim
) -> tuple[ReviewInput, tuple[str, ...]] | None:
    order = await session.get(WorkOrder, claim.order_id)
    if (
        order is None
        or order.status is not WorkOrderStatus.COMPLETED
        or order.last_submission_version != claim.submission_version
        or order.completed_at is None
    ):
        return None
    equipment = await session.get(Equipment, order.equipment_id)
    assert equipment is not None
    fault = await session.get(FaultCode, order.fault_code_id) if order.fault_code_id else None
    norm = await session.scalar(
        select(TimeNorm.minutes).where(
            TimeNorm.fault_code_id == order.fault_code_id,
            TimeNorm.equipment_type == equipment.equipment_type,
        )
    )
    materials = (
        await session.execute(
            select(MaterialUsage, Material)
            .join(Material, Material.id == MaterialUsage.material_id)
            .where(
                MaterialUsage.work_order_id == order.id,
                MaterialUsage.submission_version == claim.submission_version,
            )
            .order_by(MaterialUsage.id)
        )
    ).all()
    photos = list(
        (
            await session.scalars(
                select(Photo)
                .where(
                    Photo.work_order_id == order.id,
                    (Photo.kind == PhotoKind.BEFORE) | (Photo.attempt == order.attempt),
                )
                .order_by(Photo.uploaded_at, Photo.id)
            )
        ).all()
    )
    # Only hashes/counts cross the order boundary; no other order ID or employee is exposed.
    reused = (
        set(
            (
                await session.scalars(
                    select(Photo.sha256)
                    .where(Photo.sha256.in_([photo.sha256 for photo in photos]))
                    .group_by(Photo.sha256)
                    .having(func.count() > 1)
                )
            ).all()
        )
        if photos
        else set()
    )
    events = list(
        (
            await session.scalars(
                select(WorkOrderEvent)
                .where(
                    WorkOrderEvent.work_order_id == order.id,
                )
                .order_by(WorkOrderEvent.sequence)
            )
        ).all()
    )
    active, paused, elapsed = _timing(order, events)
    identities = [order.number, equipment.inventory_number, str(order.id)]
    people = (await session.execute(select(Employee.display_name, Employee.login))).all()
    for name, login in people:
        identities.extend((name, login))
    return ReviewInput(
        work_description=order.description,
        completion_description=order.work_description or "Описание работ отсутствует",
        equipment_type=equipment.equipment_type,
        fault_name=fault.name if fault else "Шифр неисправности отсутствует",
        materials=tuple(
            ReviewMaterial(name=material.name, unit=material.unit, quantity=str(usage.quantity))
            for usage, material in materials
        ),
        no_materials_reason=order.no_materials_reason,
        active_minutes=active,
        paused_minutes=paused,
        elapsed_minutes=elapsed,
        norm_minutes=norm,
        issued_at=order.issued_at,
        completed_at=order.completed_at,
        attempt_started_at=order.started_at,
        known_identifiers=tuple(identities),
        photos=tuple(
            ReviewPhoto(
                kind=photo.kind.value,
                sha256=photo.sha256,
                reused_exact=photo.sha256 in reused,
                captured_at=photo.captured_at,
                uploaded_at=photo.uploaded_at,
            )
            for photo in photos
        ),
    ), tuple(photo.storage_key for photo in photos)


async def _images(
    evidence: ReviewInput,
    keys: tuple[str, ...],
    store: PhotoStore | None,
    config: OpenAIReviewConfig,
) -> ReviewInput:
    if not config.vision_enabled or config.api_key is None or store is None:
        return evidence
    # At least one image from each side precedes optional extra views.
    before = [i for i, p in enumerate(evidence.photos) if p.kind == "before"]
    after = [i for i, p in enumerate(evidence.photos) if p.kind == "after"]
    candidates = (before[:1] + after[:1] + after[1:] + before[1:])[: config.max_images]
    photos = list(evidence.photos)
    for index in candidates:
        try:
            content = await asyncio.to_thread(store.read, keys[index])
        except (PhotoStoreError, OSError):
            continue  # The analyzer explicitly sees unavailable visual evidence.
        photos[index] = replace(photos[index], image_bytes=content)
    return replace(evidence, photos=tuple(photos))


def _release(job: AIReviewJob, *, status: str, now: datetime, error: str | None = None) -> None:
    job.status = status
    job.lease_token = None
    job.lease_until = None
    job.last_error_code = error
    job.updated_at = now


async def _finish(
    database: Database,
    claim: _Claim,
    result: ReviewResult | None,
    now: datetime,
    error: str | None = None,
) -> bool:
    async with database.sessions.begin() as session:
        job = await session.get(AIReviewJob, claim.job_id, with_for_update=True)
        if (
            job is None
            or job.status != "running"
            or job.lease_token != claim.lease_token
            or job.lease_until is None
            or job.lease_until <= now
        ):
            return False
        if result is None:
            _release(job, status="stale", now=now)
            return False
        # The job token, order transition, review, events and job completion commit together.
        try:
            await apply_review_in_session(
                session,
                claim.order_id,
                expected_order_version=claim.submission_version,
                submission_version=claim.submission_version,
                verdict=result.verdict,
                needs_master_review=result.needs_master_review,
                score=result.score,
                explanation=result.explanation,
                model_name=result.model_name,
                report=result.report,
            )
        except OperationError as error_response:
            if error_response.status_code not in {404, 409}:
                raise
            _release(job, status="stale", now=now)
            return False
        _release(job, status="completed", now=now, error=error)
        return True


async def _retry(database: Database, claim: _Claim, error: ProviderError, now: datetime) -> None:
    async with database.sessions.begin() as session:
        job = await session.get(AIReviewJob, claim.job_id, with_for_update=True)
        if (
            job is not None
            and job.lease_token == claim.lease_token
            and job.lease_until is not None
            and job.lease_until > now
        ):
            _release(job, status="retry", now=now, error=error.code)
            order = await session.get(WorkOrder, job.work_order_id)
            if order is not None:
                await invalidate_order_views(session, order, now)
            job.next_attempt_at = now + timedelta(seconds=min(120, 15 * 2 ** (claim.attempts - 1)))


async def process_ai_review_jobs(
    database: Database,
    *,
    config: OpenAIReviewConfig,
    now: datetime,
    photo_store: PhotoStore | None = None,
    max_attempts: int = 3,
    lease_seconds: int = 120,
    limit: int = 1,
    analyzer: Analyzer = analyze_review,
) -> int:
    """Do bounded checks; cancelled tasks leave recoverable leases, never fake success."""
    now = _utc(now)
    if (
        not 1 <= limit <= 20
        or not 1 <= max_attempts <= 5
        or lease_seconds < config.total_timeout_seconds + 30
    ):
        raise ValueError("invalid AI review job limits")
    start = asyncio.get_running_loop().time()

    def instant() -> datetime:
        # Monotonic elapsed time preserves controlled test clocks and enforces real lease expiry.
        return now + timedelta(seconds=asyncio.get_running_loop().time() - start)

    completed = 0
    for _ in range(limit):
        claim = await _claim(database, instant(), lease_seconds, max_attempts)
        if claim is None:
            break
        async with database.sessions.begin() as session:
            await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            loaded = await _input(session, claim)
        if loaded is None:
            await _finish(database, claim, None, instant())
            continue
        evidence, keys = loaded
        error_code = None
        if claim.exhausted:
            error_code = "attempts_exhausted"
            result = manual_review_result(
                evidence,
                source="unavailable",
                limitation="Попытки автоматической проверки исчерпаны; требуется мастер.",
            )
        else:
            try:
                # Bound image preparation plus transport, not only individual HTTP reads.
                async with asyncio.timeout(config.total_timeout_seconds):
                    evidence = await _images(evidence, keys, photo_store, config)
                    result = await analyzer(evidence, config)
            except (ProviderError, TimeoutError) as failure:
                error = (
                    failure
                    if isinstance(failure, ProviderError)
                    else ProviderError("timeout", retryable=True)
                )
                if error.retryable and claim.attempts < max_attempts:
                    await _retry(database, claim, error, instant())
                    continue
                error_code = error.code
                result = manual_review_result(
                    evidence,
                    source="unavailable",
                    limitation="Внешняя модель недоступна; требуется решение мастера.",
                )
        completed += int(await _finish(database, claim, result, instant(), error_code))
    return completed
