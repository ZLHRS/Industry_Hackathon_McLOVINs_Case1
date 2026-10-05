---
name: verification
description: Independently verify code changes against acceptance criteria using diffs, tests, static analysis, API/data contracts, security-sensitive behavior, and reproducible evidence. Use as the final verification gate.
---

# Verification

## Review order
1. Acceptance criteria.
2. Actual diff and execution path.
3. Regression and edge cases.
4. API/data contracts.
5. Transaction/concurrency behavior.
6. Security/data-integrity risk when relevant.
7. Executed tests/build/typecheck/lint evidence.
8. Scope and unintended changes.

## Toolbelt
- `repo-health` and git diff inspection first.
- `test`, `lint`, `security` for executable evidence.
- `frontend-check` for browser/frontend changes.
- `docker-check` for infrastructure/container changes.
- `db-check` for read-only DB evidence.
- `api-check` and `openapi-check` for API changes.
- `dataset-inspect`, `ml-check`, `gpu-check` for data/ML changes.
- `benchmark` when performance is part of acceptance criteria.
- GitHub MCP for independent repository/PR context.
- Sentry when production evidence is relevant.

## Visual work
When design, responsive layout or reference fidelity is in scope, use [the visual review procedure](../frontend-engineering/references/visual-review.md). Compare the actual rendered output and interaction evidence with the brief. Check that referenced screenshots exist; inspect them when image viewing is available. A build alone does not establish visual quality, and unviewed screenshots are missing visual evidence. Preserve the existing style for narrow edits and do not substitute personal taste for the user's reference.

## Gate
PASS only when no blocking issue remains and required evidence exists.
FAIL for blocking defects or critical missing evidence.
PARTIAL only when the environment prevents a necessary check; explain exactly what is missing.

Never modify production code as part of the verification gate.
