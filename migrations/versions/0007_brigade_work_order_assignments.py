"""Freeze optional brigade participants on work-order issuance."""

import sqlalchemy as sa
from alembic import op

revision = "0007_brigade_assignments"
down_revision = "0006_photo_ai_consent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("work_orders", sa.Column("brigade_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_work_orders_brigade_id", "work_orders", "brigades", ["brigade_id"], ["id"]
    )
    op.create_index("ix_work_orders_brigade_status", "work_orders", ["brigade_id", "status"])
    op.create_table(
        "work_order_participants",
        sa.Column("work_order_id", sa.UUID(), nullable=False),
        sa.Column("employee_id", sa.UUID(), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=False),
        sa.Column("assignment_role", sa.String(length=16), nullable=False),
        sa.CheckConstraint(
            "assignment_role IN ('responsible', 'participant')",
            name="ck_work_order_participant_role",
        ),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"]),
        sa.ForeignKeyConstraint(["work_order_id"], ["work_orders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("work_order_id", "employee_id"),
    )
    op.create_index(
        "ix_work_order_participants_employee", "work_order_participants", ["employee_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_work_order_participants_employee", table_name="work_order_participants")
    op.drop_table("work_order_participants")
    op.drop_index("ix_work_orders_brigade_status", table_name="work_orders")
    op.drop_constraint("fk_work_orders_brigade_id", "work_orders", type_="foreignkey")
    op.drop_column("work_orders", "brigade_id")
