"""Keep repair photos private until their uploader explicitly allows external AI."""

import sqlalchemy as sa
from alembic import op

revision = "0006_photo_ai_consent"
down_revision = "0005_catalog_archiving"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "photos",
        sa.Column("ai_share_allowed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("photos", "ai_share_allowed")
