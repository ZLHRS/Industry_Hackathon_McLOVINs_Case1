---
name: frontend-engineering
description: Design, implement and visually verify distinctive web interfaces, or improve existing frontend code. Use for new pages, redesigns, reference matching, React/TypeScript UI, interactions and responsive fixes; preserve the existing design for narrow edits.
---

# Frontend Engineering

Deliver an interface that suits this product and works in a browser. Visual quality is part of correctness when design is requested; a successful build alone cannot establish it.

## Select the scope

Inspect the actual page, assets, framework, package scripts, UI primitives, content and API contracts before editing. Establish the audience, main user task and observable acceptance criteria from the request and repository. Ask only about information that materially blocks the work; otherwise state a reasonable assumption and continue.

- **New UI / substantial redesign:** read [design-direction.md](references/design-direction.md). Choose a visual direction before building.
- **Supplied screenshot, Figma or established brand:** inspect that source and follow it. Preserve its geometry, content hierarchy, palette, typography and interaction conventions; interpret missing responsive behavior consistently. A requested faithful reproduction takes priority over inventing a new aesthetic.
- **Small bug, copy, API or component change:** retain the surrounding visual language. Do not introduce a design phase, replace fonts or redesign the page to fix a local issue.

For new design work, briefly state the product/audience, primary action, visual direction, type/color choices and distinctive composition. Keep this in the working response or existing task notes, not a new design-document hierarchy. Do not wait for approval of routine design choices.

## Build a coherent interface

Establish or reuse tokens for surfaces, text, accents, spacing, typography and interactive states. Build the main screen with realistic content first; verify its hierarchy before multiplying sections and components. Reuse the project's framework and primitives. A component library supplies behavior, not the finished art direction.

Make layout decisions from the information: a transaction history may need a table, a portfolio needs work samples, a catalog needs comparable products. Do not turn every task into a marketing hero followed by interchangeable cards. Preserve backend contracts and state ownership; avoid new libraries, global state or abstractions without a concrete need.

Use honest, domain-specific copy. Do not invent customer logos, testimonials, compliance claims or business metrics as fact. Mark necessary demo data as illustrative. Use supplied/local assets first. If visual assets are essential, use available image or design tools within the task; an unavailable tool is not permission to fabricate evidence or install integrations. Keep textual content and controls as real UI, not baked into an image.

Implement the actual primary flow and its relevant loading, empty, validation, error and success states. Every visible control must have a meaningful action, destination or explicit disabled reason. Handle keyboard focus, semantic controls, usable contrast, long content and mobile layout. Motion must support orientation or feedback; honor reduced motion and leave content readable without animation.

## Render, inspect, refine

For a new screen, redesign or layout change, follow [visual-review.md](references/visual-review.md). Run the page, inspect screenshots at relevant widths, exercise the principal interaction and fix observed problems. Distinguish screenshots actually viewed from files merely captured. A DOM snapshot cannot establish visual polish.

Prefer a connected browser or the project's installed browser tooling; Playwright MCP is optional. Figma is useful when it is the source of truth. Use official library documentation for version-specific behavior. Do not add competing tools just to follow this playbook.

Run focused project checks (or `frontend-check` from the portable toolbelt). Do not call a scaffold, mock success message or untested integration production-ready. If browser execution is unavailable, complete feasible implementation/static checks and identify visual and interaction verification as missing.

## Handoff

Return changed paths, the chosen direction when relevant, commands and observed results, screenshot paths with route/viewport/state, interactions checked, and remaining limitations. Tie design conclusions to visible observations. Never award an automatic “10/10” or claim universal quality from a checklist. Pass unresolved functional or visual blockers to the root/verifier.
