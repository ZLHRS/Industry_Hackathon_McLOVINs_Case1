# Visual and interaction review

Use for meaningful visual work. Scale the checks to the changed surface; a copy correction does not require a full-site audit. Report what was actually inspected, not what a tool might be able to inspect.

## Gather evidence

1. Start the project's documented development/preview command and confirm the target route loads. Use an existing browser connection or installed Playwright tooling. Check tool availability before naming a tool in the handoff. If several agents share a browser, coordinate ownership instead of navigating the same tab concurrently.
2. For a new responsive screen, inspect a desktop and a narrow mobile viewport (for example 1440x900 and 390x844). Use the reference's dimensions for fidelity checks. Also check an intermediate width when layout changes there. Let text reflow naturally; do not force a desktop screenshot into a smaller fixed canvas.
3. View the rendered screenshots with an image-capable tool or browser. Capture the first screen, the full page when relevant, and the main active state. Readable screenshot evidence takes priority over claims based solely on source or an accessibility tree. Never say images were reviewed if they were only saved.
4. Exercise the principal user journey. Examples: open navigation, select a filter, submit invalid then valid input, open/close a dialog, follow the main CTA. Verify the visible result and relevant URL/data changes. Do not treat an alert box or pretend success as a completed workflow. Keep external submissions within the user's authorization.
5. Inspect relevant console errors and failed application requests. Check keyboard order, visible focus and Escape/return-focus for overlays. Inspect local loading/error/empty states when the change affects them; do not fabricate failures against a live service.

## Review in order

| Dimension | Observable evidence |
|---|---|
| Product fit or reference fidelity | Content and composition suit the task; the supplied reference's important relationships survive |
| Hierarchy | The primary task/content is easy to find; secondary material does not compete |
| Typography and spacing | Lines wrap sensibly, controls stay readable, alignments and spacing are consistent |
| Color and assets | Text has usable contrast; images load, crop correctly and explain the subject |
| Responsive behavior | No accidental horizontal overflow, clipped text, overlapping controls or inaccessible mobile navigation |
| Interaction and access | Main flow works, focus is visible, states explain progress/errors, information is not color-only |
| Restraint and performance | Decorative work does not obscure the task, block input or cause obvious shifting/jank |

For fidelity work, compare screenshots at matching viewport/state, checking major blocks, proportions, crop and text hierarchy before fine details. For a fresh design, evaluate its chosen direction rather than enforcing a favorite aesthetic. Automated accessibility checks and screenshot diffs can support this review; they do not replace looking at the result.

## Iterate with a stopping condition

Identify the one to three most important observed defects. Fix those, then re-render the affected screen/state. A successful first implementation still needs an actual visual inspection. Do not change details randomly or spend unlimited cycles pursuing a self-assigned score.

Aim for a complete visual pass plus at most two targeted repair passes. Stop when the acceptance criteria and visible blockers are resolved; if they remain after that, hand back the concrete issue and evidence rather than claiming perfection. Fix functional/accessibility blockers before cosmetic refinement. Do not disguise real overflow with blanket `overflow-x: hidden` or remove content to make a screenshot pass.

## Report honestly

Separate build/type/test results, observed browser behavior, and visual inspection. Include route, viewport, state and local screenshot path. If screenshot viewing is unavailable, report screenshots captured but visually unreviewed. If browser launch is unavailable, report a partial verification and the exact missing check. Do not install a new browser stack or weaken permissions merely to manufacture a PASS.
