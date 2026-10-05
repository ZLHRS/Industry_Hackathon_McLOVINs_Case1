"""Create the initial PostgreSQL schema."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None

_STATUS_VALUES = ", ".join(
    (
        "'issued'",
        "'accepted'",
        "'queued'",
        "'rejected'",
        "'in_progress'",
        "'paused'",
        "'completed'",
        "'ai_review'",
        "'rework'",
        "'closed'",
        "'cancelled'",
    )
)


def _uuid_id() -> sa.Column[sa.UUID]:
    return sa.Column("id", sa.UUID(), primary_key=True, nullable=False)


def upgrade() -> None:
    op.create_table(
        "areas",
        _uuid_id(),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.UniqueConstraint("code", name="uq_areas_code"),
    )
    op.create_table(
        "brigades",
        _uuid_id(),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.UniqueConstraint("code", name="uq_brigades_code"),
    )
    op.create_table(
        "equipment",
        _uuid_id(),
        sa.Column("inventory_number", sa.String(64), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("area_id", sa.UUID(), nullable=False),
        sa.Column("equipment_type", sa.String(80), nullable=False),
        sa.Column("criticality", sa.Integer(), nullable=False),
        sa.CheckConstraint("criticality BETWEEN 1 AND 5", name="ck_equipment_criticality"),
        sa.ForeignKeyConstraint(["area_id"], ["areas.id"]),
        sa.UniqueConstraint("inventory_number", name="uq_equipment_inventory_number"),
        sa.UniqueConstraint("id", "area_id", name="uq_equipment_id_area"),
    )
    op.create_index("ix_equipment_area_id", "equipment", ["area_id"])
    op.create_table(
        "employees",
        _uuid_id(),
        sa.Column("login", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(160), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("specialty", sa.String(80), nullable=False),
        sa.Column("grade", sa.Integer(), nullable=False),
        sa.Column("brigade_id", sa.UUID(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_on_shift", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.CheckConstraint("login = lower(login)", name="ck_employee_login_lowercase"),
        sa.CheckConstraint("grade BETWEEN 1 AND 6", name="ck_employee_grade"),
        sa.CheckConstraint(
            "role IN ('executor', 'master', 'manager', 'admin')", name="ck_employee_role"
        ),
        sa.ForeignKeyConstraint(["brigade_id"], ["brigades.id"]),
        sa.UniqueConstraint("login", name="uq_employees_login"),
    )
    op.create_index("ix_employee_brigade_id", "employees", ["brigade_id"])
    op.create_index("ix_employee_active_shift", "employees", ["is_active", "is_on_shift"])
    op.create_table(
        "employee_areas",
        sa.Column("employee_id", sa.UUID(), primary_key=True, nullable=False),
        sa.Column("area_id", sa.UUID(), primary_key=True, nullable=False),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"]),
        sa.ForeignKeyConstraint(["area_id"], ["areas.id"]),
    )
    op.create_table(
        "fault_codes",
        _uuid_id(),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("specialty", sa.String(80), nullable=False),
        sa.UniqueConstraint("code", name="uq_fault_codes_code"),
    )
    op.create_index("ix_fault_codes_specialty", "fault_codes", ["specialty"])
    op.create_table(
        "materials",
        _uuid_id(),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("unit", sa.String(24), nullable=False),
        sa.UniqueConstraint("code", name="uq_materials_code"),
    )
    op.create_table(
        "time_norms",
        _uuid_id(),
        sa.Column("fault_code_id", sa.UUID(), nullable=False),
        sa.Column("equipment_type", sa.String(80), nullable=False),
        sa.Column("minutes", sa.Integer(), nullable=False),
        sa.CheckConstraint("minutes > 0", name="ck_time_norm_minutes_positive"),
        sa.ForeignKeyConstraint(["fault_code_id"], ["fault_codes.id"]),
        sa.UniqueConstraint("fault_code_id", "equipment_type", name="uq_time_norm_fault_equipment"),
    )
    op.create_table(
        "work_orders",
        _uuid_id(),
        sa.Column("number", sa.String(64), nullable=False),
        sa.Column("work_type", sa.String(16), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("area_id", sa.UUID(), nullable=False),
        sa.Column("equipment_id", sa.UUID(), nullable=False),
        sa.Column("executor_id", sa.UUID(), nullable=False),
        sa.Column("master_id", sa.UUID(), nullable=False),
        sa.Column("priority", sa.String(16), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column(
            "issued_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column("deadline", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fault_code_id", sa.UUID(), nullable=True),
        sa.Column("work_description", sa.Text(), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("is_synthetic", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.CheckConstraint("version > 0", name="ck_work_order_version_positive"),
        sa.CheckConstraint("deadline >= issued_at", name="ck_work_order_deadline_after_issue"),
        sa.CheckConstraint(
            "started_at IS NULL OR started_at >= issued_at",
            name="ck_work_order_started_after_issue",
        ),
        sa.CheckConstraint(
            "completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)",
            name="ck_work_order_completed_after_start",
        ),
        sa.CheckConstraint(
            "closed_at IS NULL OR (completed_at IS NOT NULL AND closed_at >= completed_at)",
            name="ck_work_order_closed_after_complete",
        ),
        sa.CheckConstraint(
            "status <> 'closed' OR closed_at IS NOT NULL",
            name="ck_work_order_closed_requires_timestamp",
        ),
        sa.CheckConstraint("work_type IN ('planned', 'unplanned')", name="ck_work_order_type"),
        sa.CheckConstraint(
            "priority IN ('emergency', 'high', 'normal', 'planned')", name="ck_work_order_priority"
        ),
        sa.CheckConstraint(f"status IN ({_STATUS_VALUES})", name="ck_work_order_status"),
        sa.ForeignKeyConstraint(
            ["equipment_id", "area_id"],
            ["equipment.id", "equipment.area_id"],
            name="fk_work_order_equipment_area",
        ),
        sa.ForeignKeyConstraint(["executor_id"], ["employees.id"]),
        sa.ForeignKeyConstraint(["master_id"], ["employees.id"]),
        sa.ForeignKeyConstraint(["fault_code_id"], ["fault_codes.id"]),
        sa.UniqueConstraint("number", name="uq_work_orders_number"),
    )
    op.create_index("ix_work_orders_area_status", "work_orders", ["area_id", "status"])
    op.create_index("ix_work_orders_executor_status", "work_orders", ["executor_id", "status"])
    op.create_index("ix_work_orders_master_id", "work_orders", ["master_id"])
    op.create_index("ix_work_orders_deadline", "work_orders", ["deadline"])
    op.create_table(
        "work_order_events",
        _uuid_id(),
        sa.Column("work_order_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=True),
        sa.Column("actor_role", sa.String(16), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("from_status", sa.String(24), nullable=True),
        sa.Column("to_status", sa.String(24), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.CheckConstraint("sequence > 0", name="ck_work_order_event_sequence_positive"),
        sa.CheckConstraint("length(action) > 0", name="ck_work_order_event_action_nonempty"),
        sa.CheckConstraint(
            "actor_id IS NOT NULL OR actor_role = 'system'", name="ck_work_order_event_system_actor"
        ),
        sa.CheckConstraint(
            "actor_role IN ('executor', 'master', 'manager', 'admin', 'system')",
            name="ck_work_order_event_actor_role",
        ),
        sa.CheckConstraint(
            f"from_status IS NULL OR from_status IN ({_STATUS_VALUES})",
            name="ck_work_order_event_from_status",
        ),
        sa.CheckConstraint(
            f"to_status IN ({_STATUS_VALUES})", name="ck_work_order_event_to_status"
        ),
        sa.ForeignKeyConstraint(["work_order_id"], ["work_orders.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["employees.id"]),
        sa.UniqueConstraint("work_order_id", "sequence", name="uq_work_order_event_sequence"),
    )
    op.create_index("ix_work_order_events_work_order", "work_order_events", ["work_order_id"])
    op.create_table(
        "photos",
        _uuid_id(),
        sa.Column("work_order_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("storage_key", sa.String(512), nullable=False),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.CheckConstraint("kind IN ('before', 'after')", name="ck_photo_kind"),
        sa.CheckConstraint("size_bytes > 0", name="ck_photo_size_positive"),
        sa.ForeignKeyConstraint(["work_order_id"], ["work_orders.id"]),
        sa.ForeignKeyConstraint(["author_id"], ["employees.id"]),
        sa.UniqueConstraint("storage_key", name="uq_photos_storage_key"),
    )
    op.create_index("ix_photos_work_order", "photos", ["work_order_id"])
    op.create_table(
        "material_usages",
        _uuid_id(),
        sa.Column("work_order_id", sa.UUID(), nullable=False),
        sa.Column("material_id", sa.UUID(), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_material_usage_quantity_positive"),
        sa.ForeignKeyConstraint(["work_order_id"], ["work_orders.id"]),
        sa.ForeignKeyConstraint(["material_id"], ["materials.id"]),
    )
    op.create_index("ix_material_usages_work_order", "material_usages", ["work_order_id"])
    op.create_index("ix_material_usages_material", "material_usages", ["material_id"])
    op.create_table(
        "ai_reviews",
        _uuid_id(),
        sa.Column("work_order_id", sa.UUID(), nullable=False),
        sa.Column("order_version", sa.Integer(), nullable=False),
        sa.Column("verdict", sa.String(24), nullable=True),
        sa.Column("score", sa.Integer(), nullable=True),
        sa.Column(
            "needs_master_review", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("model_name", sa.String(120), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("master_score", sa.Integer(), nullable=True),
        sa.CheckConstraint("order_version > 0", name="ck_ai_review_order_version_positive"),
        sa.CheckConstraint(
            "score IS NULL OR score BETWEEN 1 AND 5", name="ck_ai_review_score_range"
        ),
        sa.CheckConstraint(
            "master_score IS NULL OR master_score BETWEEN 1 AND 5",
            name="ck_ai_review_master_score_range",
        ),
        sa.CheckConstraint(
            "verdict IS NULL OR verdict IN "
            "('accepted', 'accepted_with_remarks', 'rework_required')",
            name="ck_ai_review_verdict",
        ),
        sa.ForeignKeyConstraint(["work_order_id"], ["work_orders.id"]),
    )
    op.create_index("ix_ai_reviews_work_order", "ai_reviews", ["work_order_id"])
    op.create_table(
        "auth_sessions",
        _uuid_id(),
        sa.Column("employee_id", sa.UUID(), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("expires_at > created_at", name="ck_auth_session_expiry_after_created"),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"]),
        sa.UniqueConstraint("token_hash", name="uq_auth_sessions_token_hash"),
    )
    op.create_index("ix_auth_sessions_employee", "auth_sessions", ["employee_id"])
    op.create_table(
        "login_throttles",
        sa.Column("key", sa.String(64), primary_key=True, nullable=False),
        sa.Column(
            "window_started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.CheckConstraint("attempts >= 0", name="ck_login_throttle_attempts_nonnegative"),
    )
    op.create_table(
        "seed_runs",
        sa.Column("id", sa.String(64), primary_key=True, nullable=False),
        sa.Column("seed", sa.Integer(), nullable=False),
        sa.Column("anchor_date", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("seed_runs")
    op.drop_table("login_throttles")
    op.drop_index("ix_auth_sessions_employee", table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_index("ix_ai_reviews_work_order", table_name="ai_reviews")
    op.drop_table("ai_reviews")
    op.drop_index("ix_material_usages_material", table_name="material_usages")
    op.drop_index("ix_material_usages_work_order", table_name="material_usages")
    op.drop_table("material_usages")
    op.drop_index("ix_photos_work_order", table_name="photos")
    op.drop_table("photos")
    op.drop_index("ix_work_order_events_work_order", table_name="work_order_events")
    op.drop_table("work_order_events")
    op.drop_index("ix_work_orders_deadline", table_name="work_orders")
    op.drop_index("ix_work_orders_master_id", table_name="work_orders")
    op.drop_index("ix_work_orders_executor_status", table_name="work_orders")
    op.drop_index("ix_work_orders_area_status", table_name="work_orders")
    op.drop_table("work_orders")
    op.drop_table("time_norms")
    op.drop_table("materials")
    op.drop_index("ix_fault_codes_specialty", table_name="fault_codes")
    op.drop_table("fault_codes")
    op.drop_table("employee_areas")
    op.drop_index("ix_employee_active_shift", table_name="employees")
    op.drop_index("ix_employee_brigade_id", table_name="employees")
    op.drop_table("employees")
    op.drop_index("ix_equipment_area_id", table_name="equipment")
    op.drop_table("equipment")
    op.drop_table("brigades")
    op.drop_table("areas")
