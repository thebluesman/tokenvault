# Plugin UX

Flows and screen specs for the Tokenvault plugin panel (PRD §6.7). Owned by `@ux-designer`.

Everything here is written against the real imported token shape in `src/tokens/types.ts` and the
fixtures in `test/fixtures/`, not against a hypothetical schema.

| Doc | Phase | Status |
|---|---|---|
| [`local-editor.md`](local-editor.md) | 4 — Local editor | Implemented |
| [`apply-and-drift.md`](apply-and-drift.md) | 5 — Figma application + drift | Implemented, except §5.4 (bind) |

**Status vocabulary.** *Provisional* — written ahead of the build, open questions still in the doc.
*Implemented* — every open question closed, and the design shipped and was validated live in Figma.
An implemented doc is still the live spec: it gets amended when the design changes, not frozen.

Phase 5's §5.4 (bind tokens to selected layers) is the one section of an implemented doc that has no
code behind it — ADR-0005 §12 deferred binding to its own ticket, because the property mapping needs
subtype confirmation that most numbers don't have yet. The section stands as the spec for that ticket.

Not yet written: git sync and the pre-commit diff view (Phase 6), theming/aliasing/math
(Phase 7), sync status and settings panel (Phase 9).
