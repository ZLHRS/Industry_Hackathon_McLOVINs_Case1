"""Add executor fault reports and optional work-order conversion link."""

import sqlalchemy as sa
from alembic import op

revision = "0008_fault_reports"
down_revision = "0007_brigade_assignments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "fault_reports",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("equipment_id", sa.UUID(), nullable=False),
        sa.Column("area_id", sa.UUID(), nullable=False),
        sa.Column("reporter_id", sa.UUID(), nullable=False),
        sa.Column("master_id", sa.UUID(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="open"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissal_reason", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "status IN ('open', 'converted', 'dismissed')", name="ck_fault_report_status"
        ),
        sa.CheckConstraint("version > 0", name="ck_fault_report_version_positive"),
        sa.ForeignKeyConstraint(["area_id"], ["areas.id"]),
        sa.ForeignKeyConstraint(["equipment_id"], ["equipment.id"]),
        sa.ForeignKeyConstraint(["master_id"], ["employees.id"]),
        sa.ForeignKeyConstraint(["reporter_id"], ["employees.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("reporter_id", "idempotency_key", name="uq_fault_reports_reporter_key"),
    )
    op.create_index("ix_fault_reports_master_status", "fault_reports", ["master_id", "status"])
    op.create_index(
        "ix_fault_reports_reporter_created", "fault_reports", ["reporter_id", "created_at"]
    )
    op.add_column("work_orders", sa.Column("fault_report_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_work_orders_fault_report", "work_orders", "fault_reports", ["fault_report_id"], ["id"]
    )
    op.create_unique_constraint("uq_work_orders_fault_report", "work_orders", ["fault_report_id"])
    op.alter_column("notifications", "work_order_id", existing_type=sa.UUID(), nullable=True)
    op.add_column("notifications", sa.Column("fault_report_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_notifications_fault_report",
        "notifications",
        "fault_reports",
        ["fault_report_id"],
        ["id"],
    )
    op.create_check_constraint(
        "ck_notification_one_subject",
        "notifications",
        "(work_order_id IS NOT NULL) <> (fault_report_id IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_notification_one_subject", "notifications", type_="check")
    op.drop_constraint("fk_notifications_fault_report", "notifications", type_="foreignkey")
    op.drop_column("notifications", "fault_report_id")
    op.alter_column("notifications", "work_order_id", existing_type=sa.UUID(), nullable=False)
    op.drop_constraint("uq_work_orders_fault_report", "work_orders", type_="unique")
    op.drop_constraint("fk_work_orders_fault_report", "work_orders", type_="foreignkey")
    op.drop_column("work_orders", "fault_report_id")
    op.drop_index("ix_fault_reports_reporter_created", table_name="fault_reports")
    op.drop_index("ix_fault_reports_master_status", table_name="fault_reports")
    op.drop_table("fault_reports")
