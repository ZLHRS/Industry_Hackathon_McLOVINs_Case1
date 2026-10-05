"""Add transactional work-order commands, evidence versions and delivery outbox."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_order_workflow"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "work_orders", sa.Column("attempt", sa.Integer(), nullable=False, server_default="1")
    )
    op.add_column("work_orders", sa.Column("last_submission_version", sa.Integer(), nullable=True))
    op.add_column("work_orders", sa.Column("no_materials_reason", sa.Text(), nullable=True))
    op.create_check_constraint("ck_work_order_attempt_positive", "work_orders", "attempt > 0")
    op.create_check_constraint(
        "ck_work_order_submission_positive",
        "work_orders",
        "last_submission_version IS NULL OR last_submission_version > 0",
    )
    # Legacy fixtures used version=1 for their initial completed submission.
    op.execute(
        "UPDATE work_orders SET last_submission_version = version WHERE completed_at IS NOT NULL"
    )
    op.create_index(
        "uq_work_orders_executor_running",
        "work_orders",
        ["executor_id"],
        unique=True,
        postgresql_where=sa.text("status = 'in_progress'"),
    )
    op.add_column("work_order_events", sa.Column("order_version", sa.Integer(), nullable=True))
    op.add_column(
        "work_order_events",
        sa.Column(
            "details", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
    )
    op.create_check_constraint(
        "ck_work_order_event_version_positive",
        "work_order_events",
        "order_version IS NULL OR order_version > 0",
    )
    op.add_column("photos", sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"))
    op.create_check_constraint("ck_photo_attempt_positive", "photos", "attempt > 0")
    op.add_column("material_usages", sa.Column("submission_version", sa.Integer(), nullable=True))
    op.create_check_constraint(
        "ck_material_usage_submission_positive",
        "material_usages",
        "submission_version IS NULL OR submission_version > 0",
    )
    op.create_unique_constraint(
        "uq_ai_review_submission", "ai_reviews", ["work_order_id", "order_version"]
    )
    op.create_table(
        "idempotency_records",
        sa.Column("actor_id", sa.UUID(), sa.ForeignKey("employees.id"), primary_key=True),
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("order_id", sa.UUID(), sa.ForeignKey("work_orders.id"), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("response", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_table(
        "outbox_events",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("work_order_id", sa.UUID(), sa.ForeignKey("work_orders.id"), nullable=False),
        sa.Column(
            "event_id",
            sa.UUID(),
            sa.ForeignKey("work_order_events.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint("attempts >= 0", name="ck_outbox_attempts_nonnegative"),
    )
    op.create_index(
        "ix_outbox_pending",
        "outbox_events",
        ["created_at"],
        postgresql_where=sa.text("processed_at IS NULL"),
    )
    op.execute("""
        CREATE FUNCTION forbid_work_order_event_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'work_order_events are append-only' USING ERRCODE = '55000';
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER work_order_events_immutable
        BEFORE UPDATE OR DELETE ON work_order_events
        FOR EACH ROW EXECUTE FUNCTION forbid_work_order_event_mutation()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER work_order_events_immutable ON work_order_events")
    op.execute("DROP FUNCTION forbid_work_order_event_mutation()")
    op.drop_table("outbox_events")
    op.drop_table("idempotency_records")
    op.drop_constraint("uq_ai_review_submission", "ai_reviews", type_="unique")
    op.drop_constraint("ck_material_usage_submission_positive", "material_usages", type_="check")
    op.drop_column("material_usages", "submission_version")
    op.drop_constraint("ck_photo_attempt_positive", "photos", type_="check")
    op.drop_column("photos", "attempt")
    op.drop_constraint("ck_work_order_event_version_positive", "work_order_events", type_="check")
    op.drop_column("work_order_events", "details")
    op.drop_column("work_order_events", "order_version")
    op.drop_index("uq_work_orders_executor_running", table_name="work_orders")
    op.drop_constraint("ck_work_order_submission_positive", "work_orders", type_="check")
    op.drop_constraint("ck_work_order_attempt_positive", "work_orders", type_="check")
    op.drop_column("work_orders", "last_submission_version")
    op.drop_column("work_orders", "no_materials_reason")
    op.drop_column("work_orders", "attempt")
