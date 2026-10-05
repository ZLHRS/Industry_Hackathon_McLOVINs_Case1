---
name: orchestration
description: Route software tasks among the root session and five specialists when delegation, ownership or independent verification can improve the result.
---

# Orchestration

Use the smallest execution graph that safely completes the task. Simple local work stays in the root. Delegate only a bounded task that can run alongside useful parent work.

- `researcher`: current or unfamiliar evidence that changes an implementation decision.
- `backend_engineer`: Python, APIs, data access, async and services.
- `frontend_engineer`: product-specific UI design, reference fidelity, TypeScript, browser behavior, accessibility and rendered visual review.
- `ml_engineer`: data, training, evaluation and inference.
- `verifier`: independent checks for meaningful behavior, security, data or contract changes.

Assign objective, acceptance criteria, relevant files, constraints and checks. Explicitly assign file ownership to writers and tell them to preserve other agents' work. Shared configuration belongs to the root unless ownership is transferred. Avoid nested delegation and overlapping edits.

Reuse an existing specialist for related follow-ups. Request compact findings and executed evidence; do not paste entire conversations. Cancel obsolete work when scope changes.

Implementation self-checks before independent verification. A failed gate returns a concrete defect to the original writer. After at most two targeted repair cycles, report the unresolved blocker instead of looping.

Use one `.codex-state/task.md` only when durable coordination helps. The root is its sole writer. Persist decisions, ownership, results and next actions, not transcripts.
