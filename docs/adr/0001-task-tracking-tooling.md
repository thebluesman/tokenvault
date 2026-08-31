# ADR-0001 — GitHub Issues for task tracking

**Status**: Accepted
**Date**: 2026-08-31
**Owner**: @tech-lead

## Context

Tokenvault is a solo-built project (PRD §5 "Users") already hosted on GitHub (`thebluesman/tokenvault`), with no Notion workspace or other backlog tool in play. It needs some way to track scoped work across the phased build plan (PRD §9) without introducing ceremony a one-person project doesn't need.

## Decision

**Use GitHub Issues, via the `gh` CLI, as the single source of truth for the backlog.** No Notion, no separate project-management tool, no sprint labels or planning ceremony — a flat backlog (open/closed + labels) is enough at this scale. Conventions (labels, issue body shape) live in `.claude/skills/github-issues/SKILL.md`.

This mirrors the same choice made for `horizon` (its ADR-0002), for the same reason: solo contributor, already GitHub-hosted, no need for a second system of record.

## Consequences

- `@product-manager` operates against `gh issue` commands, not a Notion API.
- No sprint cadence machinery (cadence tables, sprint-plan/retro docs) gets built unless ticket volume or velocity data later justifies it.
- Auth is whatever `gh auth login` already has configured locally — no additional token to manage for this purpose.

## Alternatives considered

- **Notion Kanban** (the pattern used in `exlibris`/`personal-brand`). Rejected — those projects predate a settled repo/tooling choice and used Notion for cross-tool visibility; Tokenvault has no such need and the repo already exists on GitHub.
- **No tracking, just work off the PRD's phased build plan directly.** Rejected — the build plan (PRD §9) is coarse-grained; individual tickets are still useful for tracking discrete pieces of work within a phase.

## References

- PRD §5 "Users", §9 "Build Plan": `docs/prd.md`
- Precedent: `horizon` ADR-0002 (`docs/adr/0002-task-tracking-tooling.md` in that repo)
