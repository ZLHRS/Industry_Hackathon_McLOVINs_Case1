#!/usr/bin/env python3
"""Create one stable local VAPID key without touching .env or sending push."""

from __future__ import annotations

import argparse
import base64
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid

_GITHUB_PATH = re.compile(r"^/?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$")


def _github_subject() -> str | None:
    result = subprocess.run(
        ["git", "config", "--get", "remote.origin.url"],
        check=False,
        capture_output=True,
        text=True,
    )
    remote = result.stdout.strip()
    if remote.startswith("git@github.com:"):
        path = remote.removeprefix("git@github.com:")
    else:
        parsed = urlsplit(remote)
        if parsed.scheme not in {"http", "https", "ssh"} or parsed.hostname != "github.com":
            return None
        path = parsed.path
    match = _GITHUB_PATH.fullmatch(path)
    if match is None:
        return None
    return f"https://github.com/{match.group(1)}/{match.group(2)}"


def _public_key(path: Path) -> str:
    vapid = Vapid.from_file(private_key_file=str(path))
    raw = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, default=Path("var/webpush/vapid_private.pem"))
    parser.add_argument(
        "--subject", help="VAPID contact URI; derived from a trusted GitHub origin when omitted"
    )
    args = parser.parse_args()
    subject = args.subject or _github_subject()
    if not subject:
        parser.error("provide --subject; no trusted github.com origin was available")
    key_file = args.key_file
    if not key_file.exists():
        key_file.parent.mkdir(parents=True, exist_ok=True)
        vapid = Vapid()
        vapid.generate_keys()
        # Open with restrictive permissions even before chmod races on POSIX.
        descriptor = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(vapid.private_pem())
    os.chmod(key_file, 0o600)
    print(f"NARYADAI_WEB_PUSH_PRIVATE_KEY_FILE={key_file}")
    print(f"NARYADAI_WEB_PUSH_SUBJECT={subject}")
    print(f"NARYADAI_WEB_PUSH_PUBLIC_KEY={_public_key(key_file)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
