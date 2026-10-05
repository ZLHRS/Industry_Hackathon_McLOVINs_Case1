"""Add persistent notification inbox, realtime revisions, and push delivery queues."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003_notifications"
down_revision = "0002_order_workflow"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("employee_id", sa.UUID(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("work_order_id", sa.UUID(), sa.ForeignKey("work_orders.id"), nullable=False),
        sa.Column("dedup_key", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(64), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("urgent", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("action_required", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("read_at", sa.DateTime(timezone=True)),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True)),
        sa.Column(
            "payload", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.UniqueConstraint("employee_id", "dedup_key", name="uq_notification_employee_dedup"),
    )
    op.create_index(
        "ix_notifications_employee_inbox", "notifications", ["employee_id", "created_at"]
    )
    op.create_table(
        "realtime_revisions",
        sa.Column("employee_id", sa.UUID(), sa.ForeignKey("employees.id"), primary_key=True),
        sa.Column("revision", sa.BigInteger(), nullable=False, server_default="1"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("employee_id", sa.UUID(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("session_id", sa.UUID(), sa.ForeignKey("auth_sessions.id"), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("endpoint_hash", sa.String(64), nullable=False),
        sa.Column("p256dh", sa.String(255), nullable=False),
        sa.Column("auth", sa.String(255), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("disabled_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("endpoint_hash", name="uq_push_subscriptions_endpoint_hash"),
    )
    op.create_index("ix_push_subscriptions_employee", "push_subscriptions", ["employee_id"])
    op.create_table(
        "push_deliveries",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("notification_id", sa.UUID(), sa.ForeignKey("notifications.id"), nullable=False),
        sa.Column(
            "subscription_id", sa.UUID(), sa.ForeignKey("push_subscriptions.id"), nullable=False
        ),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("lease_token", sa.UUID()),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("failed_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.String(300)),
        sa.CheckConstraint("attempts >= 0", name="ck_push_delivery_attempts_nonnegative"),
        sa.UniqueConstraint(
            "notification_id", "subscription_id", name="uq_push_delivery_notification"
        ),
    )
    op.create_index(
        "ix_push_deliveries_pending",
        "push_deliveries",
        ["next_attempt_at"],
        postgresql_where=sa.text("sent_at IS NULL AND failed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_push_deliveries_pending", table_name="push_deliveries")
    op.drop_table("push_deliveries")
    op.drop_index("ix_push_subscriptions_employee", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
    op.drop_table("realtime_revisions")
    op.drop_index("ix_notifications_employee_inbox", table_name="notifications")
    op.drop_table("notifications")
