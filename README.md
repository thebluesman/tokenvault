# Tokenvault

A self-hosted, self-built Figma plugin that replaces [Tokens Studio for Figma](https://tokens.studio/): design tokens managed as versioned, [DTCG](https://tr.designtokens.org/format/)-compatible JSON, synced with a GitHub repo, applied to Figma Variables/Styles, and exported to platform code via [Style Dictionary](https://styledictionary.com/) — see [`docs/prd.md`](docs/prd.md) for the full product spec.

Built incrementally with Claude Code, running entirely on free infrastructure. Zero recurring cost at solo/small-team usage is a design constraint, not a nice-to-have — see PRD §8.

## Status

**Phase 2 (Figma Variables → token JSON import) in progress.** Phase 1's scaffold — plugin boilerplate, TypeScript, esbuild, UI shell — is done. See [`docs/prd.md` §9](docs/prd.md#9-build-plan-phased-for-claude-code-sessions) for the phased build plan and [`CLAUDE.md`](CLAUDE.md) for current phase status.

### Running the plugin locally

```
npm install
npm run build       # or: npm run watch
npm run typecheck
npm test
```

In Figma desktop: **Plugins → Development → Import plugin from manifest…**, select `manifest.json` at the repo root, then run it from the same menu.

### The Variables import

**Scan Variables** reads every local variable collection and every mode in the open file and
generates the DTCG token tree defined by [ADR-0002](docs/adr/0002-variables-token-schema.md):
one file per (collection, mode), plus `tokens/$manifest.json` and `tokens/$import-report.json`.

Number variables whose Figma `VariableScope` says nothing useful are tagged `spacing` with
`subtypeSource: "default"` and listed for confirmation; duration and easing are never
auto-detectable and only ever arrive as an explicit user tag (PRD §6.1). User tags are held in
Figma's `clientStorage` until Phase 6 gives the plugin a real working copy to read them back
from.

Nothing is written to git yet — that's Phase 6. To get the generated tree onto disk, use
**Copy whole tree as JSON** and:

```
pbpaste > /tmp/tree.json
node scripts/write-tokens.mjs /tmp/tree.json .
```

### Layout

| Path | What lives there |
|---|---|
| `src/tokens/` | Pure conversion logic — schema, collisions, subtypes, serialization. No `figma` global. |
| `src/figma/scan.ts` | The only module that calls the Figma Variables API; flattens it to a plain snapshot. |
| `src/ui/` | The plugin iframe. |
| `test/` | Unit tests over `src/tokens/`, run with `node --test` via esbuild (no test framework dependency). |

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
