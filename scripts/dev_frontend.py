"""Install the pinned Linux Node runtime inside this workspace, without sudo."""

from __future__ import annotations

import hashlib
import platform
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "24.21.0"


def bootstrap() -> None:
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "aarch64"}:
        raise SystemExit("Run inside Ubuntu/WSL on x64 or arm64; see README.")
    arch = "x64" if platform.machine() == "x86_64" else "arm64"
    name = f"node-v{VERSION}-linux-{arch}"
    parent = ROOT / "var" / "node"
    target = parent / name
    if (target / "bin" / "node").is_file():
        print(f"Node {VERSION} already installed locally: {target}")
        return
    parent.mkdir(parents=True, exist_ok=True)
    base = f"https://nodejs.org/dist/v{VERSION}"
    filename = name + ".tar.xz"
    with urllib.request.urlopen(base + "/SHASUMS256.txt", timeout=30) as response:
        checksums = response.read(32_000).decode("ascii")
    expected = next(
        (line.split()[0] for line in checksums.splitlines() if line.split()[-1] == filename),
        None,
    )
    if expected is None:
        raise SystemExit("Official checksum was not found; installation stopped.")
    with tempfile.TemporaryDirectory(prefix="install-", dir=parent) as temporary:
        folder = Path(temporary)
        archive = folder / filename
        with (
            urllib.request.urlopen(base + "/" + filename, timeout=60) as response,
            archive.open("wb") as output,
        ):
            shutil.copyfileobj(response, output)
        with archive.open("rb") as downloaded:
            actual = hashlib.file_digest(downloaded, "sha256").hexdigest()
        if actual != expected:
            raise SystemExit("Node archive checksum mismatch; installation stopped.")
        with tarfile.open(archive, "r:xz") as package:
            if any(Path(member.name).parts[0] != name for member in package.getmembers()):
                raise SystemExit("Unexpected archive root; installation stopped.")
            package.extractall(folder, filter="data")
        (folder / name).rename(target)
    print(f"Installed Node {VERSION}, verified official SHA-256: {target}")
    print("Next: bash scripts/frontend.sh ci (or install before the first lockfile exists).")


if __name__ == "__main__":
    if sys.argv[1:] != ["bootstrap"]:
        raise SystemExit("Usage: uv run python scripts/dev_frontend.py bootstrap")
    bootstrap()
