"""Create a source-and-demo bundle using an explicit allowlist; exclude runtime data."""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIRECTORIES = ("src", "migrations", "tests", "scripts", "seeds", "docs", "deploy", "frontend")
FILES = (
    "README.md",
    "pyproject.toml",
    "uv.lock",
    "alembic.ini",
    ".python-version",
    ".gitignore",
    ".dockerignore",
    ".env.example",
    "compose.yaml",
    "compose.ai.yaml",
    "compose.tunnel.yaml",
)
EXCLUDED = {
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "dist",
    "test-results",
    "playwright-report",
    ".DS_Store",
}


def main() -> None:
    paths = [ROOT / name for name in FILES if (ROOT / name).is_file()]
    for directory in DIRECTORIES:
        paths.extend(
            path
            for path in (ROOT / directory).rglob("*")
            if path.is_file()
            and not path.is_symlink()
            and not set(path.relative_to(ROOT).parts) & EXCLUDED
            and not path.name.endswith((".pyc", ".tsbuildinfo"))
        )
    records = []
    output = ROOT / "dist/submission"
    output.mkdir(parents=True, exist_ok=True)
    bundle = output / "technaryad-source-and-demo.zip"
    with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(set(paths)):
            relative = path.relative_to(ROOT).as_posix()
            content = path.read_bytes()
            if re.search(rb"sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}", content):
                raise RuntimeError("Possible API secret; packaging stopped: " + relative)
            archive.write(path, "technaryad/" + relative)
            records.append(
                {
                    "path": relative,
                    "bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            )
        archive.writestr(
            "technaryad/SUBMISSION-MANIFEST.json",
            json.dumps({"files": records, "runtime_data_included": False}, indent=2),
        )
    with zipfile.ZipFile(bundle) as archive:
        assert archive.testzip() is None
        assert not any(
            set(Path(name).parts) & {"var", "tmp", ".git", ".venv", "node_modules"}
            or Path(name).name in {".env", ".env.docker", "ai_api_key", "credentials.json"}
            for name in archive.namelist()
        )
    print(
        json.dumps(
            {
                "bundle": str(bundle.relative_to(ROOT)),
                "files": len(records),
                "bytes": bundle.stat().st_size,
            }
        )
    )


if __name__ == "__main__":
    main()
