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
| [`onboarding-polish.md`](onboarding-polish.md) | 10 — PAT setup, subtype queue, first-run counts, three-place explainer | Settled — Phase 10 |
| [`panel-size-and-swatches.md`](panel-size-and-swatches.md) | 10 — Resizable window, colour swatch states, collapsed-group strip | Settled 2026-09-07 — all four §9 questions answered |
| [`edit-view-redesign.md`](edit-view-redesign.md) | 10 — The token card: restyling the edit overlay | Settled 2026-09-07 — all five §10 questions answered |
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

Phase 10 has two UX docs, not one, because the phase bundles workstreams with different gates.
[`dark-mode.md`](dark-mode.md) is issue #21 (shipped). [`onboarding-polish.md`](onboarding-polish.md)
is issue #22 — the four first-run gaps `user-journeys.md` §13c named, scoped 2026-09-05 after Shyam
closed both of that issue's blocking questions (**OAuth is not being revisited**; **Community
publishing stays on the table**). Two of the four gaps turned out to be partly misdescribed in the
survey — the bulk subtype controls already exist, and the first chip has never read `132 local` —
so that doc's §9.1 corrects `user-journeys.md` in place and §9.2 lists the amendments `git-sync.md`
and `local-editor.md` take when the build lands.

Phase 10 gained a third doc on 2026-09-07: [`panel-size-and-swatches.md`](panel-size-and-swatches.md),
covering issues #35 (resizable window) and #36 (colour swatches). Both tickets were filed off a UX
discussion rather than off the running panel, and in both cases the panel was further along than the
ticket assumed — row-level colour swatches already ship, so #36's real work is the three *no-colour*
cases (cycle, dangling, wrong-type) and the new collapsed-group swatch strip. Its load-bearing claim
is §3.4: **a resizable window does not retire the 460px arguments in the other four docs**, because
the minimum becomes the design target and 400px stays reachable. So there is no reflow, no
breakpoint, and no column layout — the merged-row design in `local-editor.md` §4.2 stands on its
own argument (11 sets don't fit in columns at any width), not on the old width argument. The doc is
**Provisional**: §9 holds four questions, and §9.2 — whether "the table/columns token view" the
issues name means the existing tree or an actual table — should be answered before the build starts,
because §5's collapsed-group strip has no meaning in a view with no collapsed groups. **Settled the
same day** — the tree stays, no table rewrite, and the three numeric recommendations were confirmed
as written.

A fourth Phase 10 doc landed 2026-09-07: [`edit-view-redesign.md`](edit-view-redesign.md), restyling
the token detail overlay to the layout of Tokens Studio's own edit panel. Scoped by Shyam to **layout
only — existing fields, no new schema or functionality**, so three of the reference's seven sections
(Modify/PRO, editable variable-scope checkboxes, code syntax) are dropped rather than stubbed, and
`scopes` stay read-only. The doc's load-bearing calls: the surface stays the **full-panel overlay**
and only its internals change (§3.1); **inline editing in the tree survives** (§3.3); field **labels
move above their fields**, buying ~90px of value width at the 400px floor (§4.1); the reference's
collapsible **Figma section** becomes the home for the provenance blob, with the Source line promoted
to its summary so collapsing never hides it (§6); and there is **no Save button**, because every field
already commits to the overlay on blur and Save's honest analogue is Apply (§7.2). **Settled the same
day** — all five §10 questions answered, including no rename (the title bar's path display is the
name field) and labels moving above every field.
