# Plugin UX

Flows and screen specs for the Tokenvault plugin panel (PRD §6.7). Owned by `@ux-designer`.

Everything here is written against the real imported token shape in `src/tokens/types.ts` and the
fixtures in `test/fixtures/`, not against a hypothetical schema.

| Doc | Phase | Status |
|---|---|---|
| [`local-editor.md`](local-editor.md) | 4 — Local editor | Implemented |
| [`apply-and-drift.md`](apply-and-drift.md) | 5 — Figma application + drift | Implemented, except §5.4 (bind); §6.4 amended by Phase 6 |
| [`git-sync.md`](git-sync.md) | 6 — Git sync, diff, settings | Settled — ready to build |
| [`references-math-themes.md`](references-math-themes.md) | 7 — Reference authoring, math, theme selection | Implemented — §11's four questions all closed 2026-09-03 |
| [`error-states.md`](error-states.md) | 9 — Scan failure, crash, unreadable overlay | Implemented |
| [`dark-mode.md`](dark-mode.md) | 10 — Dark mode | Settled — Phase 10 |
| [`user-journeys.md`](user-journeys.md) | 1–9 — Narrative survey | Published (not a spec; informs Phase 10 scoping) |

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

Phase 7 answers the one UX question ADR-0007 handed the designer — whether the editor steers users from a
math expression toward a plain reference, given that an expression loses its live link in Figma. The answer
is **yes, in exactly one case**: where the expression is arithmetically a no-op over a single reference
(`{a} * 1`), the editor commits it and offers a one-tap swap. Everywhere else there is no warning at all,
because a warning on every correct use of a feature is how `⚑` stops meaning anything.
`references-math-themes.md` §6.5 argues it.

Phase 7 also amends `local-editor.md` §5.3 (reference values were read-only — the field becomes editable)
and §7's delete-blocking copy, adds the composite sub-key refusal copy to §5.2, and makes
`apply-and-drift.md` §5.6's expression row reachable for the first time. `references-math-themes.md` §12
lists all four. **All four were applied on 2026-09-04, in the Phase 9 polish pass** — each amended section
carries its own dated note, so this instruction is spent.

Phase 9 adds [`error-states.md`](error-states.md): the three failure classes no phase doc had a treatment
for (a scan that throws, an uncaught exception, an unreadable `clientStorage` overlay), plus the audit of
every other async operation against the error table its own phase doc already owns. It is a cross-phase
doc by construction — the per-phase error tables stay where they are and stay authoritative, and §5 records
the two places implementation and doc were reconciled.

Phase 8 (the export pipeline: Style Dictionary + GitHub Actions) shipped outside the plugin scope — the build is repo-side by PRD §7, so there is no UX doc for it, though `README.md` "Exporting to code" documents the workflow. Phases 10–11 are now on the build plan (2026-09-04): Phase 10 is penultimate with scope TBD pending discussion; Phase 11 is Figma publishing.
