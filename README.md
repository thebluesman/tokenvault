# Tokenvault

A self-hosted, self-built Figma plugin that replaces [Tokens Studio for Figma](https://tokens.studio/): design tokens managed as versioned, [DTCG](https://tr.designtokens.org/format/)-compatible JSON, synced with a GitHub repo, applied to Figma Variables/Styles, and exported to platform code via [Style Dictionary](https://styledictionary.com/) — see [`docs/prd.md`](docs/prd.md) for the full product spec.

Built incrementally with Claude Code, running entirely on free infrastructure. Zero recurring cost at solo/small-team usage is a design constraint, not a nice-to-have — see PRD §8.

## Status

**Pre-build.** The PRD is drafted; no plugin code exists yet. See [`docs/prd.md` §9](docs/prd.md#9-build-plan-phased-for-claude-code-sessions) for the phased build plan and [`CLAUDE.md`](CLAUDE.md) for current phase status.

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
