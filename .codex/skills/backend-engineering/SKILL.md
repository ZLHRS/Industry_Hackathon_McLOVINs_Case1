---
name: backend-engineering
description: Implement and review Python backend systems including FastAPI, APIs, SQLAlchemy, PostgreSQL, Redis, async/concurrency, jobs, integrations and backend tests. Use for backend changes or backend-focused diagnosis.
---

# Backend Engineering

## Before editing
- Read project AGENTS.md.
- Find the real execution path and existing pattern.
- Check dependency versions and relevant tests.
- Identify transaction, timeout, retry, idempotency, concurrency and cleanup boundaries when applicable.

## Implementation
- Prefer existing architecture and dependencies.
- Keep request/service boundaries consistent with the project.
- Validate untrusted inputs and preserve API contracts.
- Keep database operations explicit and observable.
- Avoid speculative abstractions and generic frameworks.

## Useful tools
- `repo-health` for scope and repository state.
- `test`, `lint`, `security` for focused verification.
- `db-check` for read-only database probes.
- `docker-check` for containers/Compose/Nginx.
- `api-check` for health and endpoint probes.
- `openapi-check` for contract structure.
- `benchmark` for measured hot paths.
- Context7 for exact library versions.
- GitHub MCP for repository/issue evidence.
- OpenAI Docs MCP for OpenAI integrations.
- Sentry only when production error context materially helps.

## Done
Run the narrowest meaningful checks. Report commands and actual outcomes; never infer a pass from code inspection alone.
