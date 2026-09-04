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
- Support standard token types: color, spacing, sizing, typography, border radius, shadow, grid, opacity, duration/easing.
- Token values stored in a DTCG-compatible JSON schema for portability.
- **Opacity vs. duration/easing — not symmetric.** Figma's Plugin API gives number Variables an optional `VariableScope` (e.g. `OPACITY`, `CORNER_RADIUS`, `WIDTH_HEIGHT`, `GAP`, `FONT_SIZE`) that a designer may set in Figma's UI to control where the variable shows up as a bindable field:
  - **Opacity**: auto-detectable when the source Variable is scoped to `OPACITY` — import reads `variable.scopes` and tags it automatically. When the designer left the Variable unscoped (`ALL_SCOPES`) or scoped to something else, it's ambiguous like any other number and falls back to the flag/tag step below.
  - **Duration/easing**: no `VariableScope` exists for it, so a number (`FLOAT`) Variable can never be scope-detected as duration/easing — sourced one of two ways: (a) during Variables import (§6.5.1), the user explicitly flags a number Variable as duration/easing; or (b) entered manually in the plugin editor (Phase 4) when no corresponding Variable exists. Figma also has natively-typed `EASING`/`TIMING` Variables, which *are* self-describing by `resolvedType` and so auto-detectable in principle — see ADR-0002 Amendment 1 §A for how import treats them (deferred in Phase 2, not yet a `$type`).

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
- Read all Variables and Styles from the current Figma file and convert into DTCG-compatible token JSON. These are two distinct Figma APIs with different data models, and are built as two separate import paths (see Build Plan §9 Phases 2–3):
  - **Variables** — every collection and mode; collections/modes map to token sets/themes (§6.2); `/`-delimited variable names map to nested token groups. Covers color, number (spacing/sizing/radius/opacity/duration-easing), boolean, and string variable types. Number Variables use the source Variable's `VariableScope` (e.g. `OPACITY`) as an auto-detect signal where Figma provides one; otherwise import surfaces an explicit flag/tag step rather than guessing silently — see §6.1 for the opacity vs. duration/easing distinction.
  - **Styles** — paint, text, effect, and grid styles (Figma's older, non-Variables system). Covers typography, shadow/effect, and other style-only token types that Variables don't carry.
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

**Phases 1–3, 8, 9 are locked and landed** — see below. **Phases 10–11 are new, added 2026-09-04** — Phase 10 (penultimate, scope TBD) and Phase 11 (Figma publishing, folding in the publish-target decision deferred from Phase 9) — provisional until scoped.

1. **Scaffold** ✅ locked — Figma plugin boilerplate (manifest, TypeScript setup, plugin UI shell).
2. **Import — Variables** ✅ locked — define the token schema scoped to Variables-backed types (color, number, boolean, string), then build the Variables → token JSON import (§6.5.1): read every collection/mode, map to token sets/themes (§6.2), validate the schema against a real file. No editor, no Styles, no sync yet.
3. **Import — Styles** ✅ locked — extend the schema for style-only token types (typography, shadow/effect, grid) and build the Styles → token JSON import (§6.5.1): paint, text, effect, and grid styles — Figma's separate, older API from Variables, so treated as its own phase rather than bundled into Phase 2.
4. **Local editor** — provisional — in-plugin CRUD UI for browsing and editing the imported tokens (create/edit/delete, sets/groups) — no sync yet.
5. **Figma application** — provisional — apply tokens back to Figma Variables/Styles (§6.5.2) and drift detection (§6.5.3).
6. **Git sync (PAT-based)** — provisional — push/pull token JSON to a GitHub repo, with a diff view before commit.
7. **Themes, aliasing, math** — provisional — layer in multi-theme composition and token references.
8. **Export pipeline** ✅ **landed 2026-09-04** — Style Dictionary + GitHub Actions export, scoped per issue #17. Initially shelved unmerged (PR #18 held pending validation); un-shelved and merged the same day after manual testing against synthetic fixtures (expressions, cycles, the `tokensDir` drift guard) and a real sync-pushed token tree from a live test repo (1162 CSS properties/theme, correct light/dark divergence). One build per theme from `$manifest.json`, math expressions preprocessed after theme resolution, any cycle/dangling-reference/expression error fails the whole build and writes nothing.
9. **Polish** ✅ **landed 2026-09-04** — scoped per issue #19, shipped via PR #20. Sync status indicator and settings panel needed no new work (already shipped in Phase 6, verified not rebuilt). Delivered: three previously-undesigned error states (corrupt overlay recovery, plugin crash screen, scan-failure handling — see `docs/ux/error-states.md`), an audit-and-fix pass across every phase's documented error table, and Phase 7's outstanding UX-doc amendments applied. Publish target (private vs. Figma Community) deferred from this phase — now folded into Phase 11.
10. **[Penultimate phase — TBD]** — provisional, added 2026-09-04. Scope pending discussion with Shyam.
11. **Figma publishing** — provisional, added 2026-09-04. Decide and execute the publish target (private install vs. Figma Community listing) — the decision explicitly deferred out of Phase 9 (§9 above, PRD §6.7's "decide whether to publish privately or to Figma Community" line moves here from its original home in the old Phase 9 scope).

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
