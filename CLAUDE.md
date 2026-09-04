# Tokenvault — Claude Code Workspace

Tokenvault is a self-built Figma plugin that replaces Tokens Studio for Figma: design tokens as versioned, DTCG-compatible JSON, synced with a GitHub repo, applied to Figma Variables/Styles, and exported to platform code via Style Dictionary — see `docs/prd.md` for the full product spec. It runs entirely on free infrastructure; zero recurring cost at solo/small-team usage is a hard constraint, not an aspiration (PRD §8).

## Current phase

**Phase 10 (UI polish, token routing rules, pipeline visibility) started 2026-09-04 — first workstream landed same day.** Scoped into six issues (#21–#26) since the phase bundles workstreams with different gates rather than moving as one unit — see PRD §9.10. Dark mode for the panel's own chrome (issue #21) landed via PR #27, built against `docs/ux/dark-mode.md` (Settled 2026-09-04, all five open questions answered by Shyam): neutrals sourced from Figma's own `--figma-color-*` variables rather than hand-authored, an Auto/Light/Dark override added to Settings, and the four-value semantic language (grey/green/amber/red) re-tuned numerically in dark so green stays quieter than amber and red stays a button color, never a state badge. 654 tests (19 new). The three items the spec deliberately left for a running panel — contrast at the actual injected values, the `--bg-subtle` pick, and the font-smoothing call — were checked by Shyam live in Figma desktop and confirmed fine as shipped, closing `dark-mode.md` §10. That same live pass surfaced an unplanned, unrelated bug: reference-valued colour token swatches rendered at 55% opacity with a dashed outline (a Phase 4/7 decision meant to distinguish a reference from a literal), which made light/dark-extreme references look inaccurate next to Figma's own Variables panel for the same tokens. Fixed same day via issue #28/PR #29 — a reference swatch now renders identically to a literal (full opacity, solid border), since the `↗` icon and value text already say "this is a pointer." `docs/ux/local-editor.md` §4.5 amended. Remaining Phase 10 issues (#22 onboarding polish — blocked on `@ux-designer` scoping, #23 subtype-sync bug, #24 naming rules + multi-repo routing — unblocked, ADRs Accepted, #25 pipeline visibility, #26 sub-key references) not yet started.

**Phase 7 (Themes, references, math) landed 2026-09-03.** References become authorable, expressions become computable, and themes become selectable — built against ADR-0007 and `docs/ux/references-math-themes.md`. One value field takes a literal, a reference or a math expression with no mode toggle; `{` opens a path picker whose three groups include the cycle-forming candidates you can see but can't tap. Circular-reference detection is one function at three checkpoints (editor, build/merge, apply plan), widened from alias edges to alias + expression edges, and a cycle renders as **the loop** with no value at all — never a zero, never the last good number. Themes are read-only: a lens chip that writes nothing, plus a separate `Switch this page to X` that is the only thing in the phase touching the Figma document. Theme *composition* editing stays out (ADR-0007 §7b), so a file with 2+ multi-mode collections still gets no themes and the chip says so rather than disappearing. 560 unit tests (111 new), validated live in Figma desktop. ADR-0007 open question 1 is settled by the API rather than by preference: `PageNode` carries `ExplicitVariableModesMixin` and `DocumentNode` does not, so page scope is the only document-wide option. Landed via PR #16, plus a same-day `/code-review medium` fix pass (`62d7d08`, `0551cd3`): a resolution-strategy mismatch between `resolve.ts` (last-wins) and `plan.ts` (first-wins) that could apply a reference and an expression on the same collided path to two different tokens, and `mergeOverlay` retiring a pending expression edit by evaluating it against the stale pre-overlay tree instead of the effective one.

**Phase 9 (Polish) landed 2026-09-04.** Sync status indicator and settings panel needed no new work — both already shipped in Phase 6 and were verified, not rebuilt. The real work was three previously-undesigned error states, documented in new `docs/ux/error-states.md`: a corrupt/unreadable `clientStorage` overlay no longer masquerades as "no local edits" — `readOverlay` quarantines the unparseable blob to a separate storage key before any write can reach the live one, recovers whatever still parses, and reports what was dropped; an unhandled plugin exception now hits a real crash screen (`src/ui/errors.ts`) instead of a blank iframe, showing a message not a stack, and recovering via the `ui-ready` handshake rather than an unreliable `location.reload()`; a failed scan/rescan no longer clears the previous valid import report out from under you. The audit pass across all four phases' documented error tables (local-editor, apply-and-drift, git-sync, references-math-themes) found and fixed drift in two places — delete-failure and apply-failure UI weren't matching their own specs — and amended one spec (`apply-and-drift.md`) where it had gone stale against Phase 5's actual post-apply rescan behavior. Landed via PR #20, plus a same-day `/code-review medium` fix pass (`e2d338b`): a delete-retry bug where retapping after a partial failure resent writes for entries that had already succeeded, and an apply-dialog "Show the loop" bug that could display the wrong cycle when two sets independently sat on different loops at the same path — the actual defect was worse than first framed, since a sibling instance at that path isn't on any loop at all, and path-only lookup was handing it another set's cycle. 584 unit tests (24 new). Not yet validated live in Figma desktop — a manual test checklist was handed to Shyam covering all three error states plus the two bug fixes.

**Phase 8 (Export pipeline) landed 2026-09-04 — scoped, built, shelved, then un-shelved and merged same day.** Style Dictionary + GitHub Actions export, scoped against issue #17: `npm run build:tokens` reads the committed token tree, one CSS-custom-property build per theme enumerated from `$manifest.json`, expression preprocessing ordered theme → references → expressions (math depends on which theme/mode is active, so it can't flatten before theme selection), output kept outside `tokensDir` so Phase 6's drift detection never sees the plugin's own generated files as user drift. A cycle, dangling reference, or expression error fails the whole build and writes nothing — never a partial or wrong stylesheet. Shyam initially shelved it (PR #18 held unmerged) pending validation; after two rounds of manual testing — synthetic fixtures covering expressions/cycles/the drift guard, then a real sync-pushed token tree from a live test repo (1162 properties/theme, correct light/dark divergence, `--check` staleness gate behaving correctly) — it was un-shelved and merged. 635 unit tests total (51 new from Phase 8's own work, atop Phase 9's 584). Next: two new phases being added to the build plan — a penultimate phase (scope TBD, pending discussion) and a final Figma-publishing phase. The publish-target decision (private vs. Figma Community) from Phase 9's scoping, previously deferred, is now folded into that final phase rather than a standalone open item.

**Phase 6 (Git sync) landed 2026-09-03.** Push/pull token JSON to a GitHub repo over PAT auth — a Repo tab with a two-half status chip, a diff-and-commit Review & push screen, pull that materializes as pending overlay entries (never a direct write), and per-file divergence that refuses rather than auto-merges, built against ADR-0006 and `docs/ux/git-sync.md`. Sync state is a blob-SHA base per file, not cached content, to stay inside the `clientStorage` quota (ADR-0004 §1); connecting rebaselines drift from the last scan to the pulled repo tree (`docs/ux/apply-and-drift.md` §6.4, amended). PAT auth only — no OAuth relay in v1. Landed via PR #14, plus a same-day ultrareview fix (`cb086ee`): the sync-state validity check compared owner/repo/branch but not `tokensDir`, so renaming the tokens folder left a stale base keyed to the old paths and every file misread as diverged. 449 unit tests (116 new), validated live in Figma desktop. Next up: Phase 7 (PRD §9, provisional), Themes, aliasing, math — multi-theme composition and token references.

**Phase 5 (Figma application) landed 2026-09-02.** Apply tokens back to Figma Variables/Styles and detect drift against the last scan, built against ADR-0005 and `docs/ux/apply-and-drift.md`. Apply writes only the edited overlay (not the full tree); conflicted targets are refused, never auto-resolved; deleting a Figma variable/style is its own separate, destructive-styled confirmation, never bundled into an apply; token-to-token references apply as native Figma variable aliases rather than flattening to resolved values (pulling alias-writing forward from Phase 7). No plugin-side undo for Figma writes — relies on Figma's native ⌘Z. 333 unit tests (71 new), validated live against a real Figma file.

**Phase 4 (Local editor) landed 2026-09-02.** In-plugin Tokens tab for browsing, editing, and deleting imported tokens — merged view across all sets keyed by dotted path (UX `docs/ux/local-editor.md`), per-type inline/overlay editing, delete blocked outright while a token has inbound references, undo, and edits persisted via a `clientStorage` overlay with three-way merge on rescan (ADR-0004). Token creation and path rename are explicitly deferred (create: no downstream consumer until Phase 5/6; rename: needs Phase 7's reference-rewriting). 262 unit tests, validated live in Figma desktop.

Phase 3 (Styles import) landed 2026-09-01. Figma Styles → token JSON import extends the schema for style-only types (typography, shadow/effect, grid) per ADR-0003 — paint, text, effect, and grid styles, with Variables-win cross-source collision precedence.

Phase 2 (Variables import) landed 2026-09-01. Figma Variables → DTCG token JSON import is built against ADR-0002 (Accepted, Revision 2), with the pure conversion layer under `src/tokens/`, the Figma API boundary in `src/figma/scan.ts`.

Phase 1 (scaffold) landed 2026-09-01 — see `README.md` for how to build and load the plugin locally.

## Canonical decisions

| Decision | Value | Source |
|---|---|---|
| Build scope | Self-hosted Figma plugin; solo/small-team use, no hosted SaaS | PRD §4 |
| Task tracking | GitHub Issues via `gh` CLI (no sprint ceremony) | ADR-0001 |
| Token storage | DTCG-compatible JSON in a git repo — no database | PRD §2, §7 |
| Git provider | GitHub only for v1 (GitLab/Bitbucket later if needed) | PRD §4 |
| Auth (v1) | Personal Access Token, stored in Figma `clientStorage`; OAuth relay is a v2 stretch goal | PRD §6.4, §11 |
| Export pipeline | Style Dictionary, run manually or via GitHub Actions on push | PRD §6.6 |

Do not relitigate an Accepted ADR without amending it.

## Solo contributor reality

Tokenvault is built by Shyam via Claude Code. Single workstream — no sprint cadence; the backlog is flat (GitHub Issues, open/closed + labels) until ticket volume or velocity data justifies planning ceremony (ADR-0001).

## Team (subagents)

| Agent | Owns | When to invoke |
|---|---|---|
| `@tech-lead` | `docs/adr/`, `docs/architecture.md` (once authored) | Architecture decisions, ADR authoring — token schema, git sync design, export pipeline |
| `@ux-designer` | `docs/ux/` | Plugin panel UX — token/theme browser, sync status, settings, diff view |
| `@product-manager` | GitHub Issues backlog | Ticket creation, backlog grooming, reconciling issues against `docs/prd.md` |
| `@frontend-engineer` | Plugin implementation | Active since Phase 1 scaffold landed 2026-09-01 |
| `@historian` | `docs/journal/` | Auto-invoked by the Stop hook after canonical-doc edits |

## Key references

- Product spec: `docs/prd.md`
- ADRs: `docs/adr/`
- Plugin UX flows: `docs/ux/`
- Project journal: `docs/journal/` — owned by `@historian`
- GitHub Issues conventions: `.claude/skills/github-issues/SKILL.md`

## Output format rule

**All documentation is `.md`.** When an agent produces a deliverable, it writes to `docs/` as markdown.

## Bash hygiene — git invocations

**Never chain `cd <path> && git ...`.** Every agent operating in this repo is already in the project root; `git` operates on the current working tree without help.

- **Bad**: `cd /Users/shyam/Documents/Projects/tokenvault && git status`
- **Good**: `git status`
- **Also good** (only if genuinely operating from a different directory): `git -C <path> status`

## Workflow (agreed 2026-08-31)

- **Ticket granularity**: one GitHub Issue per build-plan phase (PRD §9) — 9 tickets to start, tracking the plan 1:1. `@product-manager` splits a phase into sub-tickets only if it turns out too large to track as one.
- **Check-in cadence**: at phase boundaries. `@frontend-engineer` works through a full phase, then demos the result running live in Figma before starting the next phase — not mid-phase check-ins by default.
- **Code review gate**: every PR gets reviewed and merged by Shyam personally, no auto-merge. This is slower than trusting tests alone, but nothing lands on `main` unseen.

## Git workflow — committing doc vs. code changes

- **Docs/ops batches** (ADRs, PRD, agent defs): commit directly to `main` and push — no branch, no PR. Single contributor, no required review gate for doc work.
- **Code** (once Phase 1 lands): branch per ticket/phase, PR opened against `main`, Shyam reviews and merges — see Workflow above. Never merge your own PR.

## GitHub access

- **Repo**: `thebluesman/tokenvault`, pushed over HTTPS using the `gh`-authenticated `thebluesman` account (not the `aa-shyam` SSH identity — that account doesn't have push access to this repo).
- **Issues backlog** — via the `gh` CLI, authenticated with `gh auth login`. Run `gh auth status` to verify the connection, and confirm the active account is `thebluesman` before pushing or creating issues.
