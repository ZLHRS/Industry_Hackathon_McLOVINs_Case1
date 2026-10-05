---
name: tooling-and-diagnostics
description: Select and safely use the portable local Codex toolbelt and optional MCP integrations. Use when deciding which diagnostic tool to run, troubleshooting missing tools, or combining local and remote evidence.
---

# Tooling and Diagnostics

## Selection
Prefer the smallest tool that can answer the question.

Unix is the primary target. Resolve the project's `.codex/` first, then `CODEX_HOME` or `~/.codex`. Run `sh <package>/tooling/codex-tools <command>` or `python3 <package>/tooling/toolbelt.py <command>` (Python 3.11+). Windows retains `<package>/tooling/codex-tools.ps1`. Read `tooling/README.md` for arguments; use dependencies from the host's project environment.

- Package/runtime inventory: `doctor`

- Repository health: `repo-health`
- Tests: `test`
- Static checks: `lint`
- Security/dependencies: `security`
- Docker/Compose/Nginx: `docker-check`
- Read-only DB probes: `db-check`
- Dataset profiling: `dataset-inspect`
- GPU/CUDA: `gpu-check`
- HTTP endpoint probe: `api-check`
- Frontend checks: `frontend-check`
- ML environment: `ml-check`
- Performance measurement: `benchmark`
- OpenAPI structure: `openapi-check`

## MCP selection
Use MCP when it gives external context or a specialized capability that local tools do not provide:
- docs/version behavior: Context7 or official docs;
- GitHub evidence: GitHub MCP;
- browser behavior: Playwright;
- design source of truth: Figma;
- production telemetry: Sentry;
- web/paper discovery: Exa;
- hard-to-parse pages: Firecrawl;
- ML Hub assets/docs: Hugging Face.

These are capability choices, not installed-tool promises. Prefer capabilities already exposed by the host. Bundled MCP examples are disabled; enable only the required integration after checking its current setup and authentication.

## Reliability
- MCP is optional; its outage must not block unrelated local work.
- Never store credentials in config, skills, state, or handoffs.
- Treat missing executables as missing evidence, not success.
- Prefer read-only checks before mutating operations.
- Report the exact command/tool and observed result.
- Exit 0 means an executed check succeeded; 1 means failure; 2 means missing evidence or no applicable check. Missing optional tools are not a reason to install everything.
- Never add runner-specific flags to an unknown project test script or download tools implicitly. Use a direct project command when a wrapper cannot express the needed check.
