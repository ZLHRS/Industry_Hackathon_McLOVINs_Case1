"""Add AI review reports and durable review jobs."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_ai_review_jobs"
down_revision = "0003_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_reviews",
        sa.Column(
            "report",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_table(
        "ai_review_jobs",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("work_order_id", sa.UUID(), sa.ForeignKey("work_orders.id"), nullable=False),
        sa.Column("submission_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("lease_token", sa.UUID()),
        sa.Column("last_error_code", sa.String(80)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_ai_review_job_attempts_nonnegative"),
        sa.CheckConstraint("submission_version > 0", name="ck_ai_review_job_submission_positive"),
        sa.CheckConstraint(
            "(status = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR "
            "(status <> 'running' AND lease_token IS NULL AND lease_until IS NULL)",
            name="ck_ai_review_job_lease",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'retry', 'completed', 'stale', 'failed')",
            name="ck_ai_review_job_status",
        ),
        sa.UniqueConstraint(
            "work_order_id", "submission_version", name="uq_ai_review_job_submission"
        ),
    )
    op.create_index(
        "ix_ai_review_jobs_due",
        "ai_review_jobs",
        ["next_attempt_at"],
        postgresql_where=sa.text("status IN ('pending', 'retry')"),
    )
    op.create_index(
        "ix_ai_review_jobs_expired",
        "ai_review_jobs",
        ["lease_until"],
        postgresql_where=sa.text("status = 'running'"),
    )
    op.create_index("ix_photos_sha256", "photos", ["sha256"])


def downgrade() -> None:
    op.drop_index("ix_photos_sha256", table_name="photos")
    op.drop_index("ix_ai_review_jobs_expired", table_name="ai_review_jobs")
    op.drop_index("ix_ai_review_jobs_due", table_name="ai_review_jobs")
    op.drop_table("ai_review_jobs")
    op.drop_column("ai_reviews", "report")
