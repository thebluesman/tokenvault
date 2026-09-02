# Plugin UX

Flows and screen specs for the Tokenvault plugin panel (PRD §6.7). Owned by `@ux-designer`.

Everything here is written against the real imported token shape in `src/tokens/types.ts` and the
fixtures in `test/fixtures/`, not against a hypothetical schema.

| Doc | Phase | Status |
|---|---|---|
| [`local-editor.md`](local-editor.md) | 4 — Local editor | Implemented |
| [`apply-and-drift.md`](apply-and-drift.md) | 5 — Figma application + drift | Implemented, except §5.4 (bind); §6.4 amended by Phase 6 |
| [`git-sync.md`](git-sync.md) | 6 — Git sync, diff, settings | Settled — ready to build |

**Status vocabulary.** *Provisional* — written ahead of the build, open questions still in the doc.
*Settled* — every open question closed and the design is ready to build, but nothing has shipped yet,
so no section has been through contact with the real thing. *Implemented* — settled, then shipped and
validated live in Figma. An implemented doc is still the live spec: it gets amended when the design
changes, not frozen.

Phase 6's design questions were closed by Shyam on 2026-09-02. Two of the six were overridden, and both
changed structure rather than copy: the commit and diff view became a **third top-level `Repo` tab with a
full `Review & push` screen** instead of a fourth tab on the Changes list with a modal over it, and bulk
`Take Figma's` gained an **inline confirm** before it stages anything. `git-sync.md` §13 records all six
with the original recommendations intact.

Phase 5's §5.4 (bind tokens to selected layers) is the one section of an implemented doc that has no
code behind it — ADR-0005 §12 deferred binding to its own ticket, because the property mapping needs
subtype confirmation that most numbers don't have yet. The section stands as the spec for that ticket.

Phase 5's §6.4 (the drift comparison block) now has two forms. The disconnected one is what shipped and
is still correct; the connected one is written in `git-sync.md` §10, which rebaselines drift onto the
repo once a file is synced. Phase 5 predicted that amendment in the section itself.

Not yet written: theming, aliasing and math (Phase 7), and the export pipeline (Phase 8).
