# Capability routing

Tools are selected per task, not preloaded per agent.

| Need | Preferred capability | Typical owner |
|---|---|---|
| Runtime/config diagnostics | doctor | root |
| Files and repository | native search/edit/git; repo-health | all |
| Unit/integration checks | project command; test | implementer / verifier |
| Static checks | project command; lint | implementer / verifier |
| Dependency/security checks | configured security command | backend / ML / verifier |
| Containers and database | docker-check / db-check | backend / verifier |
| UI behavior | frontend-check + connected browser | frontend / verifier |
| HTTP and API contracts | api-check / openapi-check | backend / frontend / verifier |
| Data/environment/GPU | dataset-inspect / ml-check / gpu-check | ML / verifier |
| Timing | benchmark on a bounded command | implementer / verifier |
| Current library documentation | official docs; optional Context7 | researcher / specialist |
| Remote repository, designs, telemetry | connected GitHub, Figma, Sentry capability when needed | relevant specialist |

A listed capability is not a claim that its optional binary, account or service is installed. See [command contracts](README.md) and [optional integration setup](../mcp/README.md).
