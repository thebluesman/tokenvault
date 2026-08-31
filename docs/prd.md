# PRD: Tokenvault (Figma Design Tokens Plugin — Token Studio Replacement)

**Project name:** Tokenvault
**Owner:** Shyam
**Build method:** Claude Code
**Status:** Draft v1

---

## 1. Summary

A self-hosted, self-built Figma plugin that replicates the core functionality of Tokens Studio for Figma: **import existing Figma Variables/Styles into versioned token JSON**, manage those tokens, sync them with a git repository, apply them back to Figma Styles/Variables, and export them to platform code via Style Dictionary. Built incrementally with Claude Code, running entirely on free infrastructure (git hosting, serverless free tiers, open-source transform tooling).

## 2. Problem / Motivation

Token Studio is the de facto standard for git-backed design tokens in Figma, but it's a third-party dependency: pricing, roadmap, and platform risk are outside our control, and its data model doesn't always map cleanly to project-specific needs (e.g. multilingual/RTL-aware token sets). A self-built plugin gives full control over the token schema, sync behavior, and export pipeline, using only tooling already known to be free at this scale.

**The concrete driver:** existing Figma files already have Variables and Styles defined directly in Figma — not sourced from any token file. Bringing those under git-backed token management shouldn't mean manually re-creating every token by hand inside a plugin UI. The plugin's primary entry point is reading what's already in a file and converting it into token JSON; everything else (editing, sync, re-applying, export) builds on top of that.

## 3. Goals

- **Import existing Figma Variables and Styles into git-backed token JSON** — the primary entry point. Token management shouldn't require manually re-creating tokens that already exist in a file.
- Match Token Studio's core feature set: token sets, multi-theme support, aliasing, math expressions, git sync, Figma Styles/Variables application, and code export.
- Zero recurring infrastructure cost at solo/small-team usage.
- Token data stored as plain, portable JSON (DTCG-compatible) — no lock-in.
- Buildable and maintainable through iterative Claude Code sessions.

## 4. Non-Goals

- Team permissioning / seat management (Token Studio Pro territory) — not needed for solo or small-team use.
- Real-time multiplayer editing of tokens.
- Supporting every git provider on day one (GitHub first; GitLab/Bitbucket later if needed).
- A hosted SaaS product for external users — this is a personal/internal tool.

## 5. Users

- Primary: me, as a design-systems practitioner managing tokens for personal and work projects.
- Secondary (later): other designers/engineers on a design-systems team who need to pull the same tokens into code.

## 6. Feature Requirements

### 6.1 Token Management
- Create, edit, delete tokens grouped into sets (e.g. `core`, `semantic`, `component`).
- Support standard token types: color, spacing, sizing, typography, border radius, shadow, opacity, duration/easing.
- Token values stored in a DTCG-compatible JSON schema for portability.

### 6.2 Themes & Modes
- Multiple themes composed from combinations of token sets (e.g. `light`, `dark`, brand variants).
- Theme switching reflected live in the Figma canvas via Variables modes.

### 6.3 Math & Aliasing
- Tokens can reference other tokens (`{core.spacing.4}`).
- Support basic computed values (e.g. `{core.spacing.4} * 2`).
- Circular reference detection with a clear error state.

### 6.4 Git Sync
- Push/pull token JSON to/from a GitHub repo.
- Diff view before committing changes made in Figma.
- Branch selection (sync against a specific branch, not just `main`).
- **Auth:** Personal Access Token in v1 (zero infra); OAuth app as a v2 stretch goal (needs a small token-exchange endpoint).

### 6.5 Figma Application

#### 6.5.1 Import (Figma → tokens) — primary use case
- Read all Variables (every collection and mode) and Styles from the current Figma file.
- Convert into DTCG-compatible token JSON: collections/modes map to token sets/themes (§6.2); Figma's `/`-delimited variable names map to nested token groups.
- Flag naming collisions and value types that don't map cleanly to a token (rather than silently dropping or mangling them).
- Re-importable, not just one-time bootstrap — supports incrementally pulling in further Figma-side changes made outside the token workflow.

#### 6.5.2 Apply (tokens → Figma)
- Apply tokens as Figma Variables (primary path) and/or Styles (fallback for older files).
- Bulk-apply tokens to selected layers.

#### 6.5.3 Drift detection
- Detect and flag Figma-side edits that have drifted from the token source.

### 6.6 Code Export
- Style Dictionary–based pipeline: token JSON → CSS custom properties, and at least one additional platform target (iOS or Android) as a stretch goal.
- Exportable via a manual command and, later, a CI step (GitHub Actions) that runs on push to the tokens branch.

### 6.7 Plugin UI
- Token set/theme browser and editor inside the Figma plugin panel.
- Sync status indicator (in sync / local changes / remote changes).
- Settings panel for repo URL, branch, and auth token.

## 7. Technical Architecture

```
Figma Plugin (TypeScript, Figma Plugin + Variables API)
        |
        |-- reads (import) / writes (apply) --> Figma Variables & Styles
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

- **Plugin runtime:** Figma Plugin API, plugin UI as an HTML/JS iframe within Figma.
- **Storage of truth:** git repo, not a database — tokens are just versioned JSON files.
- **Auth:** PAT stored in Figma's `clientStorage` for v1; OAuth relay only if/when the UX friction of PATs becomes a real problem.
- **Transform pipeline:** Style Dictionary, invoked manually or via CI on push.

## 8. Infra & Cost Plan

| Component | Solution | Cost |
|---|---|---|
| Plugin hosting/runtime | Figma Plugin API | Free |
| Token storage & versioning | GitHub private repo | Free |
| Git sync | GitHub REST API | Free |
| Auth (v1) | Personal Access Token | Free |
| Auth (v2, optional) | OAuth relay on Cloudflare Workers/Vercel | Free at this scale |
| Export pipeline | Style Dictionary + GitHub Actions | Free |
| Custom domain (only if a web dashboard is added later) | — | ~$10–15/yr, optional |
| Build effort | Claude Code | Already covered (Pro plan) |

No component has a cost floor above $0 at solo/small-team usage; the only plausible future cost is a vanity domain, and only if a companion web dashboard gets built.

## 9. Build Plan (Phased, for Claude Code sessions)

1. **Scaffold** — Figma plugin boilerplate (manifest, TypeScript setup, plugin UI shell).
2. **Token schema + import from Figma** — define the JSON schema, then build the Variables/Styles → token JSON import (§6.5.1) against a real file so the schema is validated against actual data, not speculative examples. Add the in-plugin CRUD editor alongside it — no git sync yet.
3. **Figma application** — apply tokens back to Figma Variables/Styles (§6.5.2) and drift detection (§6.5.3).
4. **Git sync (PAT-based)** — push/pull token JSON to a GitHub repo, with a diff view before commit.
5. **Themes, aliasing, math** — layer in multi-theme composition and token references.
6. **Export pipeline** — wire up Style Dictionary, wire a GitHub Actions job to run it on push.
7. **Polish** — sync status UI, error states, settings panel; decide whether to publish privately or to Figma Community.

## 10. Success Metrics

- Can import an existing production Figma file's Variables/Styles into token JSON with zero manual re-creation.
- Can fully replace Token Studio for at least one real project without feature regressions I personally rely on.
- Token → code export produces output usable in an existing codebase without manual cleanup.
- Zero recurring infra spend after three months of real use.

## 11. Risks & Open Questions

- **Figma Plugin API changes:** Figma has been actively evolving the Variables API; some capabilities may shift under us.
- **Import fidelity:** real Figma files accumulate inconsistent naming, mixed Variables/Styles usage, and values that don't map cleanly to a token (e.g. exotic effects, non-numeric bindings). Import (§6.5.1) needs to fail loud and specific on what it can't convert, not silently drop or mangle data — this is the first thing that will get exercised against messy real-world data.
- **OAuth vs PAT tradeoff:** PAT is simplest but has weaker UX (manual token rotation); revisit once v1 is in daily use.
- **Scope creep:** Token Studio's full feature set (esp. Pro-tier permissioning) is large — stay disciplined about the non-goals in §4.
- **Maintenance:** as a personal tool, who fixes it when Figma ships a breaking API change?

## 12. Future Considerations (Out of Scope for v1)

- Multi-language/RTL-aware token sets (e.g. logical spacing/direction tokens) — relevant for multilingual design-system work, worth revisiting once the core plugin is stable.
- A standalone web dashboard for browsing tokens outside Figma.
- Support for additional git providers (GitLab, Bitbucket, Azure DevOps).
