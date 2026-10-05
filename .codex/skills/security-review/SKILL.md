---
name: security-review
description: Perform targeted secure-by-default review for Python, JavaScript/TypeScript, APIs, authentication, authorization, secrets, dependencies, containers and data boundaries. Use for security-sensitive work or explicit security review.
---

# Security Review

## Scope
Focus on concrete attack surfaces introduced or affected by the change.

Check as relevant:
- authentication and authorization boundaries;
- input validation and injection risk;
- secret handling and logging;
- SSRF, file access and unsafe deserialization;
- dependency vulnerabilities;
- CORS/CSRF/session/token handling;
- SQL/query safety;
- container/runtime permissions;
- sensitive data exposure;
- rate limits, replay and idempotency for externally triggered operations.

## Tools
Use `security`, `docker-check`, `lint`, `test`, and targeted repository inspection. Use authoritative documentation when framework behavior is version-specific.

## Reporting
Every finding needs: severity rationale, exact location, concrete evidence, and a minimal remediation. Do not invent vulnerabilities from naming alone.
