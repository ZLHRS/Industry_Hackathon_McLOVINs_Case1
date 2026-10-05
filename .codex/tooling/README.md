# Portable toolbelt

Unix is the primary platform. Run `sh <package>/tooling/codex-tools COMMAND [ARGUMENT]` or `python3 <package>/tooling/toolbelt.py COMMAND [ARGUMENT]` with Python 3.11+. From this package root use `sh ./tools`; after installation, `tooling/codex-tools` is executable directly. Bash is not required. Windows retains `codex-tools.ps1` and the root `tools.ps1` shortcut. Python shims remain in `bin/` for compatibility; do not add that folder to PATH because `test` can shadow a shell command.

There are no third-party runtime dependencies for the dispatcher, doctor, CSV/JSON profiling, HTTP probe or regression tests. Each project supplies its own check tools. Nothing is downloaded or installed by the toolbelt itself; project scripts and build tools retain their normal behavior.

## Commands

| Command | Argument | Scope / prerequisites |
|---|---|---|
| doctor | optional `--home PATH` | Validate package TOML, role references, playbooks; inventory PATH. Offline only. |
| repo-health | project, default `.` | Git status and diff whitespace. A non-Git folder is MISSING. |
| test | project, default `.` | Explicit argv in pyproject, pytest, declared Node test script, Cargo or Go. |
| lint | project, default `.` | Configured Ruff/mypy, declared Node lint/typecheck, Go vet, Cargo clippy. |
| security | project, default `.` | Explicit pyproject security argv or Node security script. No scanner configured means MISSING. |
| frontend-check | project, default `.` | Declared lint, typecheck, test and test:e2e scripts. Browser execution must be in the project's script or done with connected browser tools. |
| docker-check | project, default `.` | Compose config, Dockerfile build check, Nginx config when present. Requires corresponding binaries. Build checks may access registries. |
| db-check | project, default `.` | Read-only PostgreSQL SELECT 1 / Redis PING using DATABASE_URL / REDIS_URL from the environment. Contacts those services. |
| api-check | HTTP(S) URL | Bounded GET; status and content metadata only. No response body or cookies printed. |
| dataset-inspect | data file | Bounded CSV/TSV/JSON/JSONL profile; Parquet requires pyarrow. Reports sampled data, never raw row values. |
| gpu-check | project, default `.` | NVIDIA and PyTorch CUDA capability evidence. Hardware availability is distinct from model correctness. |
| ml-check | project, default `.` | Selected Python environment's available ML modules; not a training or inference test. |
| benchmark | command and separate arguments | One bounded execution with wall-clock measurement; command can have its usual side effects. |
| openapi-check | JSON/YAML file | Structural check followed by full validation when openapi-spec-validator is present. YAML additionally needs PyYAML. Structural-only returns MISSING. |

Do not append test-runner flags to a wrapper. Run the native project command for test selection, watch modes, unusually long runs or options the wrapper does not expose.

## Results

- **0 / PASS**: the selected checks actually ran successfully within the scope above.
- **1 / FAIL**: bad input, failed check or timeout.
- **2 / MISSING**: dependency/evidence absent or no applicable checks.

A failure takes precedence over missing checks. A partial set of successful checks is not full verification. An inventory PASS means the inventory worked, not that the application works.

## Project environments

Python project checks prefer `.venv/bin/python` (or `python3`) on Unix and `.venv/Scripts/python.exe` on Windows; artifacts from the other OS are ignored. Otherwise they use the dispatcher interpreter. Set `CODEX_TOOLBELT_PYTHON` to an explicit executable to select the runtime in either shell launcher. Pass a path, not a shell command with flags.

Node checks use `packageManager` or a single supported lockfile (npm, pnpm, Yarn). Conflicting lockfiles are reported, not silently worked around. Windows batch package-manager shims are resolved to their installed Node CLI; unsupported layouts yield MISSING. No `npx` download or runner-specific `--runInBand` injection occurs.

For an unrecognized Python test runner or security tool, declare an explicit argv in the project:

```toml
[tool.codex_toolbelt]
test = ["{python}", "-m", "unittest", "discover", "-s", "tests", "-v"]
security = ["{python}", "-m", "pip_audit"]
```

Only configure tools installed for that project. `{python}` and `{project}` expand as individual argument text, without a shell. A configured command is executable project code and should be reviewed like package.json scripts.

The toolbelt is a convenience layer. Use direct project commands when they provide better evidence. Optional external capabilities are described in [MCP setup](MCP-SETUP.md).
