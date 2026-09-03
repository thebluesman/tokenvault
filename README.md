# Tokenvault

A self-hosted, self-built Figma plugin that replaces [Tokens Studio for Figma](https://tokens.studio/): design tokens managed as versioned, [DTCG](https://tr.designtokens.org/format/)-compatible JSON, synced with a GitHub repo, applied to Figma Variables/Styles, and exported to platform code via [Style Dictionary](https://styledictionary.com/) — see [`docs/prd.md`](docs/prd.md) for the full product spec.

Built incrementally with Claude Code, running entirely on free infrastructure. Zero recurring cost at solo/small-team usage is a design constraint, not a nice-to-have — see PRD §8.

## Status

**Phase 6 (Git sync) landed 2026-09-03.** Phases 1–6 — scaffold, Variables import, Styles import, the local editor, applying to Figma with drift detection, and git sync over a PAT — are done. See [`docs/prd.md` §9](docs/prd.md#9-build-plan-phased-for-claude-code-sessions) for the phased build plan and [`CLAUDE.md`](CLAUDE.md) for current phase status.

### Running the plugin locally

```
npm install
npm run build       # or: npm run watch
npm run typecheck
npm test
```

In Figma desktop: **Plugins → Development → Import plugin from manifest…**, select `manifest.json` at the repo root, then run it from the same menu.

### The import

**Scan file** reads two things in one pass and merges them into a single token tree.

Every local variable collection and every mode becomes the DTCG token tree defined by
[ADR-0002](docs/adr/0002-variables-token-schema.md): one file per (collection, mode), plus
`tokens/$manifest.json` and `tokens/$import-report.json`.

Number variables whose Figma `VariableScope` says nothing useful are tagged `spacing` with
`subtypeSource: "default"` and listed for confirmation; duration and easing are never
auto-detectable and only ever arrive as an explicit user tag (PRD §6.1). User tags are held in
Figma's `clientStorage`; Phase 6 gives the plugin a real working copy in a connected repo, but
tags still live in the overlay regardless of connection state.

Every local paint, text, effect and grid style becomes four synthetic, mode-free token sets under
`tokens/styles/`, per [ADR-0003](docs/adr/0003-styles-token-schema.md) — paint → `color`, text →
a DTCG `typography` composite, effect → a `shadow` composite, grid → a divergent `grid` type.
`$manifest.json` goes to `version: 2` and grows a `styleSets` key; the style sets join every
theme in first position.

Styles and Variables are merged by `src/tokens/merge.ts`, which owns the shared collision pass.
Where a style and a Variable land on the same token path the Variable wins and both are named in
the report — except where the style's paint is *provably bound* to that Variable, which is
reported as an informational `redundant-style` rather than a clash. Values that cannot become a
token (gradients, image fills, stacked paints, blur-only effects) are flagged, never dropped, and
composites that imported with something missing (an `AUTO` line height, a blur beside a shadow)
are flagged as `partial-token`.

Nothing here writes to git — Phase 2/3's scan is a read-only import. Once a repo is connected
(see [Git sync](#git-sync) below), pushing is how the tree reaches disk in the repo. Without a
connection, or to get a one-off copy, use **Copy whole tree as JSON** and:

```
pbpaste > /tmp/tree.json
node scripts/write-tokens.mjs /tmp/tree.json .
```

**Copy Figma scan (fixture input)** copies the raw scan instead — a whole `FileScan`, both halves
— which is what `test/fixtures/*/`'s regression fixtures are rebuilt from:

```
pbpaste > /tmp/scan.json
node -e 'const s=require("/tmp/scan.json"),w=(p,v)=>require("fs").writeFileSync(p,JSON.stringify(v,null,2));
  w("test/fixtures/styles-import/variables-snapshot.json", s.variables);
  w("test/fixtures/styles-import/styles-snapshot.json", s.styles);'
UPDATE_FIXTURE=1 npm test
```

Both halves must come from **one** Figma file. A style can only bind to a Variable in its own
file, so the mirror rule and the cross-source clash are unreachable — silently, with the tests
still green — if the two snapshots are captured from different files. `fixtureStyles.test.ts`
guards this with an explicit same-file assertion, but recapture both halves together regardless.
If a collection was renamed or removed, delete `test/fixtures/styles-import/tokens/` before
regenerating so no stale set is left behind.

### The local editor

The **Tokens** tab browses the imported tree and edits it in place — edits stay local until they're
either applied to Figma (below) or pushed to a connected repo (below). It follows
[`docs/ux/local-editor.md`](docs/ux/local-editor.md) and
[ADR-0004](docs/adr/0004-local-edit-persistence.md).

Browsing is **one merged tree across every set**, keyed by dotted path rather than by token: the
paths `Theme/Light` and `Theme/Dark` share appear once, with a value line per set stacked under the
name, so retuning a colour in both themes is two clicks on adjacent lines. Set, type and flag
filters narrow it; search covers paths and descriptions and says so when a query has hits in sets
the filter is hiding. The tree is virtualized with variable row heights, because a multi-set row is
taller than a single-set one.

Colours, numbers, booleans and strings edit **inline on the value line**. Typography, shadow and
grid — and description, subtype and provenance for anything — open a **full-panel overlay** with one
section per set. Reference values (`{folio.ref.palette.red-warm.50}`) are rendered verbatim, badged
and read-only: resolving or repointing one is aliasing, which is Phase 7.

Deleting is **blocked while anything references the token**. The `⋯` menu shows the referrer count
inline and opens an explanation listing every referrer rather than a confirmation. Phase 4 cannot
rewrite a reference, so a token deep in the alias graph is simply undeletable until Phase 7 — the
panel says that rather than dangling an affordance that doesn't exist.

Edits **persist across sessions** in `clientStorage`, stored as intent (target + op + new value +
the imported value it was made against) rather than as an edited copy of the tree. That is what
makes a rescan safe: it rebuilds from Figma and three-way-merges the overlay back over it. Where
Figma hasn't moved the edit reapplies silently; where Figma caught up the entry retires; where both
moved the local edit wins and is flagged `edit-conflict`; where the target is gone it is flagged
`orphaned-edit`. There is no pre-scan dialog and no global keep-mine/take-theirs.

The header chip reads **Local edits · N**, not "unsaved changes": `clientStorage` is per-device and
unsynced, so the edits are durable on this machine, invisible on another, and not committed
anywhere until applied or pushed (below).

### Applying to Figma, and drift

The **Repo** tab's status chip and the panel's header both surface **drift** — a flag on any token
whose Figma value has moved since the last scan or the last pull. **Apply** writes the edited
overlay back onto Figma Variables/Styles: it previews every target before writing, refuses a
target that's also changed in Figma rather than guessing which side wins, and a
token-to-token reference applies as a native Figma variable alias, never a flattened value. Deleting
a Figma variable or style is its own separate, destructive-styled confirmation — never bundled into
an apply. There is no plugin-side undo for a Figma write; Figma's own ⌘Z is the only way back. It
follows [`docs/ux/apply-and-drift.md`](docs/ux/apply-and-drift.md) and
[ADR-0005](docs/adr/0005-figma-apply-and-drift.md).

### Git sync

The **Repo** tab connects the file to a GitHub repo — owner/repo, branch, tokens folder, and a
fine-grained Personal Access Token with `Contents: read and write` on that repo, entered in
**Settings**. Once connected:

- **Push** opens a diff-and-commit review screen, listing exactly which files and rows change,
  with an editable commit message.
- **Pull** fetches the repo's version of selected files and lands it as **pending overlay
  entries** — never a direct Figma write. Getting a pulled value onto the canvas goes through the
  same apply flow as a local edit.
- **Divergence** — a file changed on both sides since the last sync — is refused, per file, until
  you pick a side (*Keep mine* / *Take the repo's*); nothing auto-merges.
- Connecting rebaselines drift to compare Figma against the repo's last-pulled value instead of the
  last scan.

Auth is PAT-only in v1 — no OAuth relay. The PAT crosses from the plugin sandbox to the iframe for
one request and is never stored on the iframe side; `fetch` only exists in the iframe, and
`clientStorage` only in the sandbox. It follows
[`docs/ux/git-sync.md`](docs/ux/git-sync.md) and [ADR-0006](docs/adr/0006-git-sync.md).

### Layout

| Path | What lives there |
|---|---|
| `src/tokens/` | Pure conversion logic — schema, collisions, subtypes, serialization. No `figma` global. |
| `src/tokens/merge.ts` | Composes both imports, runs the shared collision pass, emits the manifest and report. |
| `src/tokens/view.ts` | The merged browser's view model — set codes, the path-keyed merge, the group tree. |
| `src/tokens/overlay.ts` | The local edit overlay (ADR-0004): entry shape, apply, and the rescan three-way merge. |
| `src/tokens/edit.ts` | Per-type value parsing and validation. Pure; shared by the controller and the iframe. |
| `src/tokens/references.ts` | Reference recognition and the inbound-reference index that blocks a delete. |
| `src/tokens/plan.ts`, `src/tokens/preview.ts` | Builds and previews an `ApplyPlan` — the shared plan shape both a Figma apply and a git pull diff against (ADR-0005). |
| `src/tokens/drift.ts` | Drift detection: compares the tree against a baseline, disconnected (last scan) or connected (last-pulled repo tree, ADR-0006 §7). |
| `src/figma/scan.ts` | The only module that calls the Figma Variables API; flattens it to a plain snapshot. |
| `src/figma/scanStyles.ts` | The only module that calls the Figma Styles API; same boundary, four style kinds. |
| `src/figma/apply.ts` | The only module that writes to Figma Variables/Styles — executes an `ApplyPlan` (ADR-0005). |
| `src/git/` | Pure git-sync logic (ADR-0006) — `state.ts` (settings/sync-state shapes and validity), `api.ts` (GitHub REST client), `diff.ts`/`filediff.ts` (status and per-row diff), `commit.ts`/`pull.ts` (push and pull plan builders), `blob.ts` (git blob SHA), `paths.ts` (repo-path ↔ token-path mapping). No `fetch` or `figma` global. |
| `src/ui/` | The plugin iframe — `importView.ts` (Import tab), `tokens.ts` + `detail.ts` (Tokens tab), `applyDialog.ts` + `deleteFigma.ts` (apply/delete flows), `repo.ts` + `git.ts` (Repo tab and sync orchestration — the one place `fetch` is called), `settings.ts` (connection settings), `state.ts` (view model). |
| `test/` | Unit tests over `src/tokens/` and `src/git/`, run with `node --test` via esbuild (no test framework dependency). |

## Why

Tokens Studio is the de facto standard for git-backed design tokens in Figma, but it's a third-party dependency — pricing, roadmap, and platform risk sit outside our control, and its data model doesn't always map cleanly to project-specific needs. Tokenvault trades that dependency for full control over the token schema, sync behavior, and export pipeline, using only tooling already known to be free at this scale.

## How it works

```
Figma Plugin (TypeScript, Figma Plugin + Variables API)
        |
        |-- reads/writes --> Figma Variables & Styles
        |
        |-- sync --> GitHub REST API (token JSON in a repo)
        |
        |-- (optional) OAuth token exchange --> tiny serverless
        |    function (Cloudflare Workers / Vercel free tier)
        |
Style Dictionary (Node, runs locally or in GitHub Actions)
        |
        --> CSS variables / platform output committed back to repo
```

Tokens live as plain JSON in this repo — git is the source of truth, not a database. See [`docs/prd.md` §7](docs/prd.md#7-technical-architecture) for the full architecture sketch.

## Docs

- [`docs/prd.md`](docs/prd.md) — product requirements, feature scope, and the phased build plan
- [`docs/adr/`](docs/adr/) — architecture decision records
- [`docs/journal/`](docs/journal/) — chronological log of decisions and why they were made
- [`CLAUDE.md`](CLAUDE.md) — Claude Code workspace conventions (agent roster, canonical decisions, tooling)

## Built with Claude Code

This project is designed and built solo, in Claude Code, using a small set of role-scoped subagents (`@tech-lead`, `@product-manager`, `@ux-designer`, `@frontend-engineer`) defined in [`.claude/agents/`](.claude/agents/). Backlog tracking is GitHub Issues on this repo — see [`.claude/skills/github-issues/SKILL.md`](.claude/skills/github-issues/SKILL.md).
