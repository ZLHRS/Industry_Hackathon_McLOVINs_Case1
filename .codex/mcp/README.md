# Optional external capabilities

The five agent files do not start MCP servers. Use the host's native tools and connected plugins first. Configure a server only when the task benefits from its external data or specialized capability.

| Task | Capability to consider | Local/native fallback |
|---|---|---|
| OpenAI/Codex documentation | OpenAI Developer Docs | official documentation search |
| Version-specific library behavior | Context7 | dependency source and official docs |
| Remote PRs, issues and repository context | GitHub | git / authenticated GitHub CLI |
| Browser execution | connected browser or Playwright | project's existing browser test script |
| Figma design source | Figma | supplied design assets |
| Production exceptions/traces | Sentry | supplied logs and local reproduction |
| Models and datasets | Hugging Face | existing Hub CLI / documentation |

Native web search usually covers discovery; add another search/scraping provider only for a demonstrated gap.

## Browser for frontend verification

Use the connected browser or the project's installed Playwright first. If neither is available, Playwright MCP is one optional route. On the Unix host where Codex runs, install Node.js/npm and Chrome, then install the server once:

```sh
npm install -g @playwright/mcp
command -v playwright-mcp
```

Copy the disabled `playwright` block from `optional.toml` into the selected configuration, use the resolved executable path if necessary, and enable it. Alternatively, `codex mcp add playwright -- playwright-mcp --headless --isolated` registers it in the user configuration. Choose one method, not both. Start a new session and confirm tools appear with `/mcp`; then open a test page and inspect an actual screenshot. Registration alone does not prove the browser runs.

`--headless` works without a desktop window. `--isolated` keeps each browser session ephemeral and does not reuse personal login cookies. On Linux, missing browser system dependencies must be resolved for that host; this package neither installs them nor disables the browser sandbox. Do not configure five duplicate browser servers for the five roles. A shared browser tab needs one owner at a time.

See the [Microsoft Playwright MCP documentation](https://github.com/microsoft/playwright-mcp) and [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp), checked 2026-10-05. The example remains disabled until explicitly configured.

## Enabling a server

1. Check whether a connected plugin already exposes the capability.
2. Read the provider's current authentication and permission instructions.
3. Copy **only the chosen block** from `optional.toml` into the relevant project/user config, or a single role file if the capability is role-specific.
4. Set that block's `enabled = true`, provide authentication through the client or environment, and start a new Codex session.
5. Verify an actual read-only tool call before relying on the integration.

The examples file is not loaded automatically. `required = false` prevents an optional connection from being mandatory; it does not remove startup work from an enabled server. Keep unused servers disabled.

No tokens belong in TOML, URLs, repository files, state or handoffs. Configure a minimal token scope if a provider requires one. Do not launch `npx ...@latest` automatically on every agent spawn; use a reviewed installed version if a local MCP is needed.

Primary references checked for the examples on 2026-09-24:

- [OpenAI Docs MCP](https://developers.openai.com/learn/docs-mcp)
- [Context7 Codex setup](https://github.com/upstash/context7/blob/master/docs/clients/codex.mdx)
- [GitHub MCP configuration and read-only endpoint](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

Endpoint configuration is not evidence of account access or connectivity; the package regression tests deliberately do not contact these services.
