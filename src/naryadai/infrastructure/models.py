"""Typed SQLAlchemy mappings for the PostgreSQL work-order schema."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy import (
    Enum as SqlEnum,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from naryadai.domain.lifecycle import ActorRole, AiAssessment, WorkOrderStatus


class EmployeeRole(StrEnum):
    EXECUTOR = "executor"
    MASTER = "master"
    MANAGER = "manager"
    ADMIN = "admin"


class WorkType(StrEnum):
    PLANNED = "planned"
    UNPLANNED = "unplanned"


class Priority(StrEnum):
    EMERGENCY = "emergency"
    HIGH = "high"
    NORMAL = "normal"
    PLANNED = "planned"


class PhotoKind(StrEnum):
    BEFORE = "before"
    AFTER = "after"


employee_role_enum = SqlEnum(
    EmployeeRole,
    name="employee_role",
    length=16,
    native_enum=False,
    create_constraint=False,
    validate_strings=True,
    values_callable=lambda enum_class: [member.value for member in enum_class],
)
work_type_enum = SqlEnum(
    WorkType,
    name="work_type",
    length=16,
    native_enum=False,
    create_constraint=False,
    validate_strings=True,
    values_callable=lambda enum_class: [member.value for member in enum_class],
)
priority_enum = SqlEnum(
    Priority,
    name="priority",
    length=16,
    native_enum=False,
    create_constraint=False,
    validate_strings=True,
    values_callable=lambda enum_class: [member.value for member in enum_class],
)
work_order_status_enum = SqlEnum(
    WorkOrderStatus,
    name="work_order_status",
    length=24,
    native_enum=False,
    create_constraint=False,
    validate_strings=True,
    values_callable=lambda enum_class: [member.value for member in enum_class],
)
actor_role_enum = SqlEnum(
    ActorRole,
    name="actor_role",
    length=16,
    native_enum=False,
    create_constraint=False,
    validate_strings=True,
    values_callable=lambda enum_class: [member.value for member in enum_class],
)
photo_kind_enum = SqlEnum(
    PhotoKind,
    name="photo_kind",
    length=8,
    native_enum=False,
    create_constraint=False,
    validate_strings=True,
    values_callable=lambda enum_class: [member.value for member in enum_class],
)
ai_assessment_enum = SqlEnum(
    AiAssessment,
    name="ai_assessment",
    length=24,
    native_enum=False,
    create_constraint=False,
    validate_strings=True,
    values_callable=lambda enum_class: [member.value for member in enum_class],
)


class Base(DeclarativeBase):
    """Base metadata used by Alembic and all mapped tables."""


class UUIDPrimaryKey:
    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)


def utc_now() -> datetime:
    return datetime.now(UTC)


class Area(UUIDPrimaryKey, Base):
    __tablename__ = "areas"

    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)


class Brigade(UUIDPrimaryKey, Base):
    __tablename__ = "brigades"

    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)


class Equipment(UUIDPrimaryKey, Base):
    __tablename__ = "equipment"
    __table_args__ = (
        UniqueConstraint("id", "area_id", name="uq_equipment_id_area"),
        CheckConstraint("criticality BETWEEN 1 AND 5", name="ck_equipment_criticality"),
        Index("ix_equipment_area_id", "area_id"),
    )

    inventory_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    area_id: Mapped[UUID] = mapped_column(ForeignKey("areas.id"), nullable=False)
    equipment_type: Mapped[str] = mapped_column(String(80), nullable=False)
    criticality: Mapped[int] = mapped_column(Integer, nullable=False)


class Employee(UUIDPrimaryKey, Base):
    __tablename__ = "employees"
    __table_args__ = (
        CheckConstraint("login = lower(login)", name="ck_employee_login_lowercase"),
        CheckConstraint("grade BETWEEN 1 AND 6", name="ck_employee_grade"),
        Index("ix_employee_brigade_id", "brigade_id"),
        Index("ix_employee_active_shift", "is_active", "is_on_shift"),
    )

    login: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(160), nullable=False)
    role: Mapped[EmployeeRole] = mapped_column(employee_role_enum, nullable=False)
    specialty: Mapped[str] = mapped_column(String(80), nullable=False)
    grade: Mapped[int] = mapped_column(Integer, nullable=False)
    brigade_id: Mapped[UUID | None] = mapped_column(ForeignKey("brigades.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    is_on_shift: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)


class EmployeeArea(Base):
    __tablename__ = "employee_areas"

    employee_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), primary_key=True)
    area_id: Mapped[UUID] = mapped_column(ForeignKey("areas.id"), primary_key=True)


class FaultCode(UUIDPrimaryKey, Base):
    __tablename__ = "fault_codes"
    __table_args__ = (Index("ix_fault_codes_specialty", "specialty"),)

    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    specialty: Mapped[str] = mapped_column(String(80), nullable=False)


class Material(UUIDPrimaryKey, Base):
    __tablename__ = "materials"

    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    unit: Mapped[str] = mapped_column(String(24), nullable=False)


class TimeNorm(UUIDPrimaryKey, Base):
    __tablename__ = "time_norms"
    __table_args__ = (
        UniqueConstraint("fault_code_id", "equipment_type", name="uq_time_norm_fault_equipment"),
        CheckConstraint("minutes > 0", name="ck_time_norm_minutes_positive"),
    )

    fault_code_id: Mapped[UUID] = mapped_column(ForeignKey("fault_codes.id"), nullable=False)
    equipment_type: Mapped[str] = mapped_column(String(80), nullable=False)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)


class WorkOrder(UUIDPrimaryKey, Base):
    __tablename__ = "work_orders"
    __table_args__ = (
        ForeignKeyConstraint(
            ["equipment_id", "area_id"],
            ["equipment.id", "equipment.area_id"],
            name="fk_work_order_equipment_area",
        ),
        CheckConstraint("version > 0", name="ck_work_order_version_positive"),
        CheckConstraint("deadline >= issued_at", name="ck_work_order_deadline_after_issue"),
        CheckConstraint(
            "started_at IS NULL OR started_at >= issued_at",
            name="ck_work_order_started_after_issue",
        ),
        CheckConstraint(
            "completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)",
            name="ck_work_order_completed_after_start",
        ),
        CheckConstraint(
            "closed_at IS NULL OR (completed_at IS NOT NULL AND closed_at >= completed_at)",
            name="ck_work_order_closed_after_complete",
        ),
        CheckConstraint(
            "status <> 'closed' OR closed_at IS NOT NULL",
            name="ck_work_order_closed_requires_timestamp",
        ),
        Index("ix_work_orders_area_status", "area_id", "status"),
        Index("ix_work_orders_executor_status", "executor_id", "status"),
        Index("ix_work_orders_master_id", "master_id"),
        Index("ix_work_orders_deadline", "deadline"),
        Index(
            "uq_work_orders_executor_running",
            "executor_id",
            unique=True,
            postgresql_where=text("status = 'in_progress'"),
        ),
        CheckConstraint("attempt > 0", name="ck_work_order_attempt_positive"),
        CheckConstraint(
            "last_submission_version IS NULL OR last_submission_version > 0",
            name="ck_work_order_submission_positive",
        ),
    )

    number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    work_type: Mapped[WorkType] = mapped_column(work_type_enum, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    area_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    equipment_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    executor_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), nullable=False)
    master_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), nullable=False)
    priority: Mapped[Priority] = mapped_column(priority_enum, nullable=False)
    status: Mapped[WorkOrderStatus] = mapped_column(work_order_status_enum, nullable=False)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    fault_code_id: Mapped[UUID | None] = mapped_column(ForeignKey("fault_codes.id"), nullable=True)
    work_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    last_submission_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    no_materials_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_synthetic: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )


class WorkOrderEvent(UUIDPrimaryKey, Base):
    __tablename__ = "work_order_events"
    __table_args__ = (
        UniqueConstraint("work_order_id", "sequence", name="uq_work_order_event_sequence"),
        CheckConstraint("sequence > 0", name="ck_work_order_event_sequence_positive"),
        CheckConstraint("length(action) > 0", name="ck_work_order_event_action_nonempty"),
        CheckConstraint(
            "actor_id IS NOT NULL OR actor_role = 'system'",
            name="ck_work_order_event_system_actor",
        ),
        Index("ix_work_order_events_work_order", "work_order_id"),
        CheckConstraint(
            "order_version IS NULL OR order_version > 0",
            name="ck_work_order_event_version_positive",
        ),
    )

    work_order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    order_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    details: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    actor_role: Mapped[ActorRole] = mapped_column(actor_role_enum, nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    from_status: Mapped[WorkOrderStatus | None] = mapped_column(
        work_order_status_enum, nullable=True
    )
    to_status: Mapped[WorkOrderStatus] = mapped_column(work_order_status_enum, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class Photo(UUIDPrimaryKey, Base):
    __tablename__ = "photos"
    __table_args__ = (
        CheckConstraint("size_bytes > 0", name="ck_photo_size_positive"),
        CheckConstraint("attempt > 0", name="ck_photo_attempt_positive"),
        Index("ix_photos_work_order", "work_order_id"),
        Index("ix_photos_sha256", "sha256"),
    )

    work_order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    kind: Mapped[PhotoKind] = mapped_column(photo_kind_enum, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    storage_key: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)


class MaterialUsage(UUIDPrimaryKey, Base):
    __tablename__ = "material_usages"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_material_usage_quantity_positive"),
        CheckConstraint(
            "submission_version IS NULL OR submission_version > 0",
            name="ck_material_usage_submission_positive",
        ),
        Index("ix_material_usages_work_order", "work_order_id"),
        Index("ix_material_usages_material", "material_id"),
    )

    work_order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    material_id: Mapped[UUID] = mapped_column(ForeignKey("materials.id"), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    submission_version: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AIReview(UUIDPrimaryKey, Base):
    __tablename__ = "ai_reviews"
    __table_args__ = (
        CheckConstraint("order_version > 0", name="ck_ai_review_order_version_positive"),
        CheckConstraint("score IS NULL OR score BETWEEN 1 AND 5", name="ck_ai_review_score_range"),
        CheckConstraint(
            "master_score IS NULL OR master_score BETWEEN 1 AND 5",
            name="ck_ai_review_master_score_range",
        ),
        Index("ix_ai_reviews_work_order", "work_order_id"),
        UniqueConstraint("work_order_id", "order_version", name="uq_ai_review_submission"),
    )

    work_order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    order_version: Mapped[int] = mapped_column(Integer, nullable=False)
    verdict: Mapped[AiAssessment | None] = mapped_column(ai_assessment_enum, nullable=True)
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    needs_master_review: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    master_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    report: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )


class AIReviewJob(UUIDPrimaryKey, Base):
    __tablename__ = "ai_review_jobs"
    __table_args__ = (
        UniqueConstraint("work_order_id", "submission_version", name="uq_ai_review_job_submission"),
        CheckConstraint("attempts >= 0", name="ck_ai_review_job_attempts_nonnegative"),
        CheckConstraint("submission_version > 0", name="ck_ai_review_job_submission_positive"),
        CheckConstraint(
            "(status = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR "
            "(status <> 'running' AND lease_token IS NULL AND lease_until IS NULL)",
            name="ck_ai_review_job_lease",
        ),
        Index(
            "ix_ai_review_jobs_expired", "lease_until", postgresql_where=text("status = 'running'")
        ),
        CheckConstraint(
            "status IN ('pending', 'running', 'retry', 'completed', 'stale', 'failed')",
            name="ck_ai_review_job_status",
        ),
        Index(
            "ix_ai_review_jobs_due",
            "next_attempt_at",
            postgresql_where=text("status IN ('pending', 'retry')"),
        ),
    )

    work_order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    submission_version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_token: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )


class AuthSession(UUIDPrimaryKey, Base):
    __tablename__ = "auth_sessions"
    __table_args__ = (
        CheckConstraint("expires_at > created_at", name="ck_auth_session_expiry_after_created"),
        Index("ix_auth_sessions_employee", "employee_id"),
    )

    employee_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LoginThrottle(Base):
    __tablename__ = "login_throttles"
    __table_args__ = (
        CheckConstraint("attempts >= 0", name="ck_login_throttle_attempts_nonnegative"),
    )

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    window_started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class SeedRun(Base):
    __tablename__ = "seed_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    anchor_date: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_records"
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )


class OutboxEvent(UUIDPrimaryKey, Base):
    __tablename__ = "outbox_events"
    __table_args__ = (
        Index("ix_outbox_pending", "created_at", postgresql_where=text("processed_at IS NULL")),
        CheckConstraint("attempts >= 0", name="ck_outbox_attempts_nonnegative"),
    )
    work_order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    event_id: Mapped[UUID] = mapped_column(
        ForeignKey("work_order_events.id"), nullable=False, unique=True
    )
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class Notification(UUIDPrimaryKey, Base):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("employee_id", "dedup_key", name="uq_notification_employee_dedup"),
        Index("ix_notifications_employee_inbox", "employee_id", "created_at"),
    )

    employee_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), nullable=False)
    work_order_id: Mapped[UUID] = mapped_column(ForeignKey("work_orders.id"), nullable=False)
    dedup_key: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    urgent: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    action_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )


class RealtimeRevision(Base):
    __tablename__ = "realtime_revisions"
    employee_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1, server_default="1")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )


class PushSubscription(UUIDPrimaryKey, Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint("endpoint_hash", name="uq_push_subscriptions_endpoint_hash"),
        Index("ix_push_subscriptions_employee", "employee_id"),
    )
    employee_id: Mapped[UUID] = mapped_column(ForeignKey("employees.id"), nullable=False)
    session_id: Mapped[UUID] = mapped_column(ForeignKey("auth_sessions.id"), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    endpoint_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    p256dh: Mapped[str] = mapped_column(String(255), nullable=False)
    auth: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PushDelivery(UUIDPrimaryKey, Base):
    __tablename__ = "push_deliveries"
    __table_args__ = (
        UniqueConstraint(
            "notification_id", "subscription_id", name="uq_push_delivery_notification"
        ),
        CheckConstraint("attempts >= 0", name="ck_push_delivery_attempts_nonnegative"),
        Index(
            "ix_push_deliveries_pending",
            "next_attempt_at",
            postgresql_where=text("sent_at IS NULL AND failed_at IS NULL"),
        ),
    )
    notification_id: Mapped[UUID] = mapped_column(ForeignKey("notifications.id"), nullable=False)
    subscription_id: Mapped[UUID] = mapped_column(
        ForeignKey("push_subscriptions.id"), nullable=False
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_token: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(300), nullable=True)
