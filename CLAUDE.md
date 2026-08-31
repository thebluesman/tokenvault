# Tokenvault — Claude Code Workspace

Tokenvault is a self-built Figma plugin that replaces Tokens Studio for Figma: design tokens as versioned, DTCG-compatible JSON, synced with a GitHub repo, applied to Figma Variables/Styles, and exported to platform code via Style Dictionary — see `docs/prd.md` for the full product spec. It runs entirely on free infrastructure; zero recurring cost at solo/small-team usage is a hard constraint, not an aspiration (PRD §8).

## Current phase

**Pre-build.** PRD drafted (v1). Docs structure, agent roster, and backlog tooling set up 2026-08-31. No repo scaffold yet — Phase 1 of the build plan (PRD §9: Figma plugin boilerplate, manifest, TypeScript setup, plugin UI shell) hasn't landed.

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
| `@ux-designer` | `docs/ux/` (once it exists) | Plugin panel UX — token/theme browser, sync status, settings, diff view |
| `@product-manager` | GitHub Issues backlog | Ticket creation, backlog grooming, reconciling issues against `docs/prd.md` |
| `@frontend-engineer` | Plugin implementation — DORMANT until Phase 1 scaffold lands | Once there's a repo scaffold to build against |
| `@historian` | `docs/journal/` | Auto-invoked by the Stop hook after canonical-doc edits |

## Key references

- Product spec: `docs/prd.md`
- ADRs: `docs/adr/`
- Plugin UX flows: `docs/ux/` (once it exists)
- Project journal: `docs/journal/` — owned by `@historian`
- GitHub Issues conventions: `.claude/skills/github-issues/SKILL.md`

## Output format rule

**All documentation is `.md`.** When an agent produces a deliverable, it writes to `docs/` as markdown.

## Bash hygiene — git invocations

**Never chain `cd <path> && git ...`.** Every agent operating in this repo is already in the project root; `git` operates on the current working tree without help.

- **Bad**: `cd /Users/shyam/Documents/Projects/tokenvault && git status`
- **Good**: `git status`
- **Also good** (only if genuinely operating from a different directory): `git -C <path> status`

## Git workflow — committing doc changes

For doc/ops batches (ADRs, PRD, agent defs), commit directly to `main` and push — no branch, no PR. Single contributor, no required review gate for doc work. Branch/PR only when it's code (once the build phase starts) or explicitly requested.

## GitHub access

- **Repo**: `thebluesman/tokenvault`, pushed over HTTPS using the `gh`-authenticated `thebluesman` account (not the `aa-shyam` SSH identity — that account doesn't have push access to this repo).
- **Issues backlog** — via the `gh` CLI, authenticated with `gh auth login`. Run `gh auth status` to verify the connection, and confirm the active account is `thebluesman` before pushing or creating issues.
