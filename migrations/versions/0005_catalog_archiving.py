"""Keep archived areas and equipment available for historical records."""

import sqlalchemy as sa
from alembic import op

revision = "0005_catalog_archiving"
down_revision = "0004_ai_review_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "areas",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.add_column(
        "equipment",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )


def downgrade() -> None:
    op.drop_column("equipment", "is_active")
    op.drop_column("areas", "is_active")
