# Playbook maintenance

The eight playbooks are compact package-specific instructions. Keep routing, ownership and evidence rules here rather than copying provider manuals into model context.

Configuration was checked on 2026-09-24 against the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents). The package preserves its existing model selections.

Playbooks are read explicitly from the relevant project .codex directory or configured Codex home. Host-discovered skills may also be used; avoid claims that a single discovery path works across every Codex version.

Frontend design guidance revised 2026-10-05 after reviewing these primary sources:

- [OpenAI: Designing delightful frontends](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4) — explicit visual direction, content-led structure and rendered iteration.
- [Anthropic frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) — subject-specific visual decisions instead of interchangeable defaults.
- [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines) — usable interactions, responsive layouts and deliberate motion.

The bundled instructions are an original, compact synthesis for this package. No upstream skill is installed, vendored wholesale or fetched at runtime. Keep source suggestions conditional: do not force one promotional layout on operational software, forbid an existing brand, or require new image/browser dependencies. Behavioral evaluation requests live in `tests/frontend-scenarios.md` at the distribution root.

When changing a skill, preserve the user's scope, keep frontmatter specific, and validate actual behavior when the change affects delegation or tool execution. Do not add a template, service, state database or mandatory agent merely to make the package larger.
