---
name: research
description: Research current or unfamiliar technical facts using authoritative web, documentation, GitHub, APIs, papers, or product sources. Use before implementation when external evidence can change the decision.
---

# Research

## Source priority
1. Official product/framework documentation.
2. Primary standards/specifications and first-party repositories.
3. Maintainer issues/releases/changelogs.
4. Reputable technical references.
5. Community sources only for practical evidence, clearly labeled.

## Tool choice
- Web search: discovery and current facts.
- OpenAI Docs MCP: OpenAI/Codex API or product details.
- Context7: version-specific library/framework docs.
- GitHub MCP: repositories, issues, PRs, code context.
- Exa: broad web/code/paper discovery and page fetch.
- Firecrawl: difficult HTML/JS pages when clean extraction is needed.
- Hugging Face MCP: models, datasets, papers, Spaces and Hub docs.

## Method
1. Identify the exact question and version/date boundary.
2. Inspect local dependency versions first when possible.
3. Search narrowly; prefer primary sources.
4. Verify names, parameters, compatibility, limitations, and failure behavior.
5. Stop once the decision is supported.
6. Report FACTS, INFERENCE, and OPEN QUESTIONS separately.

## Output
Give a compact evidence-backed handoff with source links and the exact implication for implementation. Do not dump large documents.
