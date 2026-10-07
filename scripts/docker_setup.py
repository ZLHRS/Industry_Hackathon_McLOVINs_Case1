"""Prepare private local Docker settings without overwriting existing secrets."""

import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def prepare(root: Path = ROOT) -> None:
    directory = root / "var/docker/secrets"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ("postgres_password", "app_password", "demo_password"):
        path = directory / name
        if not path.exists():
            with path.open("x", encoding="utf-8") as stream:
                os.chmod(path, 0o600)
                stream.write(secrets.token_urlsafe(32) + "\n")
    settings = root / ".env.docker"
    if not settings.exists():
        with settings.open("x", encoding="utf-8") as stream:
            os.chmod(settings, 0o600)
            stream.write(
                "NARYADAI_BIND=127.0.0.1\n"
                "NARYADAI_HTTP_PORT=8080\n"
                "NARYADAI_HTTPS_PORT=8443\n"
                "NARYADAI_SITE_ADDRESS=http://:80\n"
                'NARYADAI_ALLOWED_HOSTS=["localhost","127.0.0.1"]\n'
                "NARYADAI_CORS_ORIGINS=[]\n"
            )
    print("Private Docker settings ready. Existing configuration and secrets preserved.")
    print("Start: docker compose --env-file .env.docker up -d --build")


if __name__ == "__main__":
    prepare()
