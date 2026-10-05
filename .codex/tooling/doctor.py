"""Offline package/environment diagnostics; never installs or authenticates anything."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import sys
import tomllib


def inspect_package(home: Path) -> list[tuple[str, str]]:
    results: list[tuple[str, str]] = []
    try:
        config = tomllib.loads((home / "config.toml").read_text(encoding="utf-8-sig"))
        agents = config.get("agents", {})
        if agents.get("enabled", True) is not True:
            results.append(("MISSING", "Multi-agent tools are disabled in this configuration"))
        limit = agents.get("max_concurrent_threads_per_session", agents.get("max_threads", 3))
        if type(limit) is not int or limit < 1:
            raise ValueError("agents concurrency must be a positive integer")
        results.append(("PASS", f"Configuration parses; child concurrency limit: {limit}"))
        role_files = set((home / "agents").glob("*.toml"))
        for name, settings in agents.items():
            if isinstance(settings, dict) and "config_file" in settings:
                target = (home / settings["config_file"]).resolve()
                if not target.is_relative_to(home.resolve()) or not target.is_file():
                    raise ValueError(f"Missing or non-portable role config: {name}")
                role_files.add(target)
        names = set()
        for role_path in sorted({p.resolve() for p in role_files}):
            role = tomllib.loads(role_path.read_text(encoding="utf-8-sig"))
            for key in ("name", "description", "developer_instructions"):
                if not isinstance(role.get(key), str) or not role[key].strip():
                    raise ValueError(f"{role_path.name}: missing {key}")
            if role["name"] in names:
                raise ValueError(f"Duplicate agent name: {role['name']}")
            names.add(role["name"])
            if role.get("sandbox_mode") not in {"read-only", "workspace-write"}:
                raise ValueError(f"{role_path.name}: expected a restricted sandbox")
            for server, value in role.get("mcp_servers", {}).items():
                if value.get("enabled", True):
                    results.append(("INFO", f"{role['name']}: MCP {server} enabled; connectivity not checked"))
            results.append(("PASS", f"Role {role['name']}: valid portable file"))
        if not names:
            raise ValueError("No agent files found")
        for relative in ("AGENTS.md", "tooling/toolbelt.py", "tooling/codex-tools", "tooling/codex-tools.ps1"):
            if not (home / relative).is_file():
                raise ValueError(f"Missing package file: {relative}")
        skill_count = 0
        for skill in sorted((home / "skills").glob("*/SKILL.md")):
            content = skill.read_text(encoding="utf-8-sig")
            if not content.startswith("---\n") or "\nname:" not in content or "\ndescription:" not in content:
                raise ValueError(f"Invalid skill frontmatter: {skill.parent.name}")
            skill_count += 1
        if not skill_count:
            raise ValueError("No bundled skill playbooks found")
        results.append(("PASS", f"{skill_count} skill playbooks found"))
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        results.append(("FAIL", f"Package validation: {exc}"))
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path(__file__).resolve().parents[1],
                        help="Package .codex directory (does not alter CODEX_HOME)")
    args = parser.parse_args(argv)
    results = inspect_package(args.home)
    results.append(("PASS", f"Python {sys.version.split()[0]}: {sys.executable}"))
    for name in ("codex", "git", "rg"):
        location = shutil.which(name)
        results.append(("PASS" if location else "MISSING", f"{name}: {location or 'not on PATH'}"))
    for name in ("node", "npm", "pnpm", "uv", "docker", "psql", "redis-cli", "nvidia-smi"):
        results.append(("INFO", f"Optional {name}: {shutil.which(name) or 'not on PATH'}"))
    override = os.environ.get("CODEX_TOOLBELT_PYTHON")
    if override:
        results.append(("INFO", "CODEX_TOOLBELT_PYTHON is set; launcher uses this interpreter"))
    for status, message in results:
        print(f"[{status}] {message}")
    print("Offline diagnostics only; model access, MCP authentication and project checks are not verified.")
    code = 1 if any(s == "FAIL" for s, _ in results) else 2 if any(s == "MISSING" for s, _ in results) else 0
    print(f"RESULT: {('PASS', 'FAIL', 'MISSING')[code]}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
