---
name: github-issues
description: Conventions for working with the Tokenvault backlog in GitHub Issues via the gh CLI. Use when creating issues, querying status, or grooming the backlog.
---

# GitHub Issues — Conventions

The Tokenvault backlog lives in GitHub Issues on `thebluesman/tokenvault` and is the single source of truth for ticket state. `@product-manager` owns it. See ADR-0001 for why (`docs/adr/0001-task-tracking-tooling.md`).

## Connection

- **Tooling**: `gh` CLI, authenticated via `gh auth login` (browser OAuth device flow) — no PAT to manage.
- **Repo**: `thebluesman/tokenvault`.

## Schema model

GitHub Issues doesn't have a custom-property schema, so conventions live in labels and a body template instead of typed fields.

### Status

Use the issue's native **open/closed** state as the primary status, plus a label for finer state while open:

| Label | Meaning |
|---|---|
| *(open, no status label)* | Not started — default for any new issue. |
| `status:in-progress` | Actively being worked on. |
| *(closed)* | Done. Closed via a commit's `Closes #N`, or manually. |
| `status:rejected` | Deliberately considered and ruled out. Close the issue and apply this label — distinguishes "ruled out" from "shipped" in closed-issue history. |

No "Review" status — if an issue needs a review gate before closing, capture it in the issue body's acceptance checklist.

### Type

One label per issue: `type:feature`, `type:bug`, `type:chore`, `type:research`, `type:docs`, `type:design`.

### Area

One or more labels matching the PRD's feature areas (PRD §6):

- `area:token-mgmt` — token CRUD, sets, DTCG schema (§6.1)
- `area:themes` — themes, modes, Variables mode switching (§6.2)
- `area:aliasing` — math & aliasing, circular-reference detection (§6.3)
- `area:git-sync` — push/pull, diff view, branch selection, auth (§6.4)
- `area:figma-io` — Variables/Styles import, application, and drift detection (§6.5)
- `area:export` — Style Dictionary pipeline, CI export (§6.6)
- `area:plugin-ui` — plugin panel UI, sync status, settings (§6.7)
- `area:infra` — build tooling, CI, repo scaffolding not tied to one feature

Match new areas to `docs/prd.md` as they come up; don't invent area labels not traceable to the PRD.

### No sprint labels yet

Tokenvault starts with a flat backlog — no `Sprint N` labels or sprint-planning ceremony. Revisit only once ticket volume or velocity data makes a flat backlog hard to plan against.

## Issue conventions

### Title

Short, action-led, one sentence. Reference the PRD section when useful.

### Body

An issue body should answer:

1. **What** — the deliverable, in one sentence.
2. **Why** — what need or PRD section this serves (link to `docs/prd.md`).
3. **Acceptance** — what "done" looks like, as a short checklist.
4. **Out of scope** — explicit list of what is *not* included.

### Closing issues from commits

Use `Closes #N` (or `Fixes #N`) in a commit message to close an issue automatically on push to `main`. Pairs with `@historian`'s commit/push step: if a commit closes an issue, say so in the commit body.

## Querying the backlog from Claude Code

Common operations via the `gh` CLI (always pass `--repo thebluesman/tokenvault` unless already inside a checkout with that as `origin`):

- **List open issues**: `gh issue list --label area:git-sync` (filter by label as needed).
- **Read issue details**: `gh issue view <number>`.
- **Create an issue**: `gh issue create --title "..." --body "..."` — always leave it unlabeled for status (open + no status label = not started) unless it's already in progress.
- **Update labels / close**: `gh issue edit <number> --add-label ...` / `gh issue close <number>`, or via a commit's `Closes #N` for the common "finished the work" case.

## When gh can't help

If a query fails: check `gh auth status` first (token/session issues surface there), report the limitation, and don't guess at issue state. Fall back to the GitHub web UI only as a last resort.

## Cross-references

- Tooling decision: `docs/adr/0001-task-tracking-tooling.md`
- PRD feature areas: `docs/prd.md` §6
