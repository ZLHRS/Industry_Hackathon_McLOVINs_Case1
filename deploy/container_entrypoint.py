"""Read mounted secrets at runtime; keep credentials out of image layers and argv."""

import os
import sys
from pathlib import Path

from sqlalchemy.engine import URL


def main() -> None:
    password = Path("/run/secrets/app_password").read_text().strip()
    os.environ["NARYADAI_DATABASE_URL"] = URL.create(
        "postgresql+psycopg",
        username="naryadai_app",
        password=password,
        host=os.environ.get("NARYADAI_DB_HOST", "postgres"),
        port=5432,
        database="naryadai",
    ).render_as_string(hide_password=False)
    if os.environ.get("NARYADAI_CONTAINER_SEED") == "1":
        os.environ["NARYADAI_SEED_SECRET"] = Path("/run/secrets/demo_password").read_text().strip()
    ai_key = Path("/run/secrets/ai_api_key")
    if ai_key.is_file():
        os.environ["NARYADAI_AI_API_KEY"] = ai_key.read_text().strip()
    if len(sys.argv) < 2:
        raise SystemExit("A container command is required")
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
