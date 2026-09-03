# Tokenvault — Claude Code Workspace

Tokenvault is a self-built Figma plugin that replaces Tokens Studio for Figma: design tokens as versioned, DTCG-compatible JSON, synced with a GitHub repo, applied to Figma Variables/Styles, and exported to platform code via Style Dictionary — see `docs/prd.md` for the full product spec. It runs entirely on free infrastructure; zero recurring cost at solo/small-team usage is a hard constraint, not an aspiration (PRD §8).

## Current phase

**Phase 7 (Themes, references, math) landed 2026-09-03.** References become authorable, expressions become computable, and themes become selectable — built against ADR-0007 and `docs/ux/references-math-themes.md`. One value field takes a literal, a reference or a math expression with no mode toggle; `{` opens a path picker whose three groups include the cycle-forming candidates you can see but can't tap. Circular-reference detection is one function at three checkpoints (editor, build/merge, apply plan), widened from alias edges to alias + expression edges, and a cycle renders as **the loop** with no value at all — never a zero, never the last good number. Themes are read-only: a lens chip that writes nothing, plus a separate `Switch this page to X` that is the only thing in the phase touching the Figma document. Theme *composition* editing stays out (ADR-0007 §7b), so a file with 2+ multi-mode collections still gets no themes and the chip says so rather than disappearing. 544 unit tests (95 new). ADR-0007 open question 1 is settled by the API rather than by preference: `PageNode` carries `ExplicitVariableModesMixin` and `DocumentNode` does not, so page scope is the only document-wide option. Next up: Phase 8 (PRD §9), Style Dictionary export and its GitHub Actions wiring.

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
