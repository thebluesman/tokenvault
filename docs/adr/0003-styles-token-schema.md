# ADR-0003 — Styles-backed token types and the Styles import path

**Status**: Proposed
**Date**: 2026-09-01
**Owner**: @tech-lead

## Context

Phase 3 (PRD §9, issue #3) adds the second import path: Figma Styles → token JSON, covering paint, text, effect, and grid styles. Styles are a separate API and a separate data model from Variables, and they carry the token types Variables cannot express — typography, shadow/effect, grid (PRD §6.1, §6.5.1).

ADR-0002 fixed the schema for the Variables-backed types (color, number, boolean, string), the repo layout, the extension block, collision handling, and determinism. **This ADR is additive on top of ADR-0002 and does not reopen it.** Where a rule from ADR-0002 is extended rather than restated, the section is named.

Three properties of Styles drive everything below:

- **Styles have no collection and no mode.** There is one flat, file-global list per kind. ADR-0002's `tokens/<collection>/<mode>.json` layout has no natural slot for them.
- **Styles are composite.** A text style is five-ish properties; an effect style is an ordered list of effects. Flattening either loses the thing that makes it a style.
- **Styles carry units.** Unlike a FLOAT Variable, a text style states that `fontSize` is px and that `lineHeight` is px, a percentage, or auto. ADR-0002 §3's "never invent a unit" argument does not apply here, because nothing is being invented.

Styles are also the *legacy* system: real files commonly hold a paint style and a Variable that mean the same thing. Import has to say something sensible about that without drowning the report.

## Decision

### 1. Styles are four synthetic, mode-free sets under `tokens/styles/`

```
tokens/
  $manifest.json
  $import-report.json
  core/value.json          # Variables, unchanged (ADR-0002 §1)
  theme/light.json
  theme/dark.json
  styles/effect.json       # new
  styles/grid.json
  styles/paint.json
  styles/text.json
```

One file per style kind, written only when that kind has at least one importable style. Set identifiers are `Styles/Paint`, `Styles/Text`, `Styles/Effect`, `Styles/Grid`.

Per-kind files rather than one `styles.json`: the four kinds are scanned independently and change independently, so a re-import that only touched effects should only diff `styles/effect.json` — the same blast-radius argument ADR-0002 §1 used for splitting per mode.

Styles are **not** modelled as a collection with four modes. Modes are alternatives a theme picks between; style kinds are not alternatives, and encoding them as modes would make a theme select one kind. Instead `$manifest.json` grows a sibling top-level key:

```json
"styleSets": [
  { "file": "styles/text.json", "kind": "TEXT", "name": "Text", "set": "Styles/Text", "slug": "text" }
]
```

`collections` keeps its exact ADR-0002 shape. Style sets have no `$figmaCollectionId`/`$figmaModeId` because there is nothing to point at. **`$manifest.json` `version` goes to `2`** — a new top-level key changes the contract for the Phase 8 export reader, so it should not be silently inferred.

Style sets are appended to `tokenSetOrder` after all Variables sets, and are added to **every** theme's `selectedTokenSets`, in first position. Styles are mode-free, so they belong to every theme equally; putting them first means that if a hand-authored override ever does land on the same path (import never generates one — §5), the Variables side wins by last-wins ordering, which matches Figma's own direction of travel.

`styles` becomes a **reserved set-slug**. A Variables collection named `Styles` (or `styles!`) would otherwise write into the same directory. That is exactly the `set-slug` collision from ADR-0002 Amendment 1 §E, with a fixed winner: the reserved directory wins, the collection is not written, and every participant is reported as usual.

### 2. Naming and identity

`/`-delimited style names split into nested DTCG groups verbatim — same `splitVariableName`, same rules, no slugging, no casing, and **no kind prefix**. A paint style named `brand/primary` becomes `brand.primary`, exactly as the equivalent Variable would. Prefixing style tokens with their kind to dodge collisions was rejected: it mangles the round-trip path, which ADR-0002 §1 makes the identity, and buys only the appearance of no collisions.

Provenance goes in the same `$extensions["com.tokenvault"].figma` block, structurally discriminated by which id is present — no new `kind` or `source` discriminator key, because adding one would change the bytes of every existing Variables token and break ADR-0002's byte-identical re-import:

```json
"$extensions": {
  "com.tokenvault": {
    "figma": {
      "styleId": "S:9f2c…,",
      "styleKey": "9f2c…",
      "styleType": "TEXT"
    }
  }
}
```

`styleId` is the re-import matching key (the analogue of `variableId`), so renaming a style in Figma moves a token rather than creating one. `styleKey` is carried because it is the id that survives library publication and is what Phase 5's apply/drift path will need. `subtype`/`subtypeSource` are not used by style tokens — style types are self-describing, so there is no flag/tag step for Styles and no new `SubtypeCandidate`s.

`$description` is written from `style.description` when non-empty, omitted otherwise. Key ordering, float32 normalisation, and the byte-identical guarantee are unchanged (ADR-0002 §7, Amendment 1 §B and §H).

### 3. Value mapping, per kind

**Paint (`$type: "color"`).** A style whose single visible paint is `SOLID` maps to a color token. Effective alpha is `paint.opacity × color.a`, written as `#rrggbbaa` when < 1, per ADR-0002 §3. If that paint is bound to a Variable (`paint.boundVariables.color`), `$value` is the alias reference `{dot.path}` rather than a hex literal — the semantic link is the point, and resolving it to hex would throw away exactly what the tool exists to preserve.

Not written, reported as `unmappable-value`: gradients (`gradient-paint`), image/video/pattern fills (`image-paint`), a style with two or more visible paints (`multi-paint`), a style with no visible paint (`empty-paint`). Gradients have a plausible landing zone — DTCG's draft `gradient` type — but choosing a stop representation is its own decision and Phase 3 does not need it.

**Text (`$type: "typography"`).** DTCG's composite typography token:

```json
"$value": {
  "fontFamily": "Inter",
  "fontSize": { "unit": "px", "value": 16 },
  "fontWeight": 600,
  "letterSpacing": { "unit": "em", "value": 0.01 },
  "lineHeight": 1.5
}
```

- `fontFamily` ← `fontName.family`.
- `fontWeight` ← `fontName.style` mapped through a fixed keyword table to a 100–900 number (`Semibold` → 600). The raw style string is **always** kept at `figma.fontStyle`, because it is the round-trip identity (`"Bold Italic"` is not recoverable from `700`) and because Phase 5 has to hand it back to Figma verbatim. An unrecognised style string leaves `fontWeight` as that string and files a degraded entry — DTCG permits a string there.
- `fontSize` ← px dimension object.
- `letterSpacing` ← `PIXELS` → px dimension; `PERCENT` → `em` dimension with value `pct / 100`, since Figma's percentage is a percentage of font size.
- `lineHeight` ← `PERCENT` → plain number `pct / 100` (DTCG's multiplier form); `PIXELS` → px dimension object; `AUTO` → sub-key **omitted**, with a `partial-token` report entry. Auto line height is a Figma layout behaviour, not a value.

Everything Figma carries that DTCG typography does not — `textDecoration`, `textCase`, `paragraphSpacing`, `paragraphIndent`, `listSpacing`, `hangingPunctuation`, `leadingTrim`, `fontVariations`, `openTypeFeatures` — is written verbatim under `figma.text`, and any of them bound to a Variable is recorded there too. Import stays lossless; nothing about the DTCG surface has to grow to make Phase 5 possible.

**Effect (`$type: "shadow"`).** `$value` is a single shadow object when the style has one visible shadow, and an **array** in source order when it has several — DTCG's own multi-shadow form, so composite-ness survives (issue #3's acceptance criterion). Each entry:

```json
{ "blur": { "unit": "px", "value": 8 }, "color": "#00000029",
  "inset": false, "offsetX": { "unit": "px", "value": 0 },
  "offsetY": { "unit": "px", "value": 2 }, "spread": { "unit": "px", "value": 0 } }
```

`INNER_SHADOW` sets `inset: true`. Invisible effects are skipped silently — a `visible: false` effect is off in Figma too. `LAYER_BLUR`, `BACKGROUND_BLUR`, noise, texture and anything Figma adds later have no DTCG representation: a style made only of those is not written (`unmappable-value` / `unsupported-effect`); a style mixing shadows with them writes the shadows and files a `partial-token` entry naming what was left out.

**Grid (`$type: "grid"`).** No DTCG type exists. Rather than invent a namespaced `$type` or drop the kind, `grid` joins `boolean` and `string` as a **declared divergence** (ADR-0002 §4): a non-core type a conformant tool should ignore rather than misread. `$value` is an array of layout-grid objects in source order — `{ alignment, count, gutter, offset, pattern, sectionSize }`, `pattern` one of `columns | rows | grid`, dimensions as px objects, keys absent where Figma leaves them absent. Grid tokens are imported for completeness and round-trip; no export target is expected to consume them in Phase 8.

### 4. Provable mirrors are not collisions

The common real-world case is a paint style and a Variable that mean the same thing, often at the same path. Reporting every one of those as a collision would make the report useless on the first real file.

So: when a paint style's single paint is bound to a Variable **and** the style's token path equals that Variable's token path, the style token is not written and the pair is reported as `redundant-style` / `mirrors-variable` — informational, not a failure. The Variable is the better token (it has modes, it can be aliased), and the style adds nothing.

This is deliberately narrow. It fires only on a *proven* binding, never on a name match, because two things that merely share a name are exactly the case a designer needs to see.

### 5. Collisions across sources: Variables win, always reported

Collision detection is lifted from "over prepared variables" to "over prepared token candidates" — a source-agnostic record of `{ path, set, source: "variable" | "style", id, name, container }` — so all four ADR-0002 collision kinds (`set-slug`, `same-set-case`, `token-group`, `cross-set`) apply unchanged to style tokens, both among themselves and against Variables tokens. `src/tokens/collisions.ts` generalises; its rules do not change.

For a contest with participants from **both** sources, ADR-0002 Amendment 1 §F's comparator does not apply — a style token has no inbound aliases (nothing can reference it) and no collection namespace to own, so the comparator would decide on name order, which is noise. Instead:

**The Variables-derived token wins, unconditionally.** New `winnerRule: "source-precedence"`. The reasoning is the same blast-radius argument §F used: a Variable can be an alias target and a style cannot, so dropping the Variable can cascade through the file while dropping the style token cannot. It is also the direction Figma is moving.

Every participant is still recorded with its id and outcome, and the loser is neither written nor renamed. Same-source contests keep their existing comparator; among two style tokens it degrades to name order, which is honest — there is no better signal available.

`ReportParticipant` gains style-shaped participants: `variableId`/`variableName` stay empty for them (the precedent Amendment 1 §E set for collection participants), with `styleId`/`styleName` alongside.

### 6. Report additions

`$import-report.json` keeps `version: 1` — every addition is additive. Two new kinds:

- **`partial-token`** — the token was written but one or more sub-values were not (auto line height, a blur inside an effect style, an unmapped font style string). Carries `path`, `set`, and the omitted sub-keys. This is the composite-type analogue of `subtypeSource: "default"`: imported, but degraded, and it needs to be visible without being an outright failure.
- **`redundant-style`** — §4's provable mirror. Not a failure at all; a distinct kind so anything filtering the report by severity can drop it.

New `unmappable-value` reasons: `gradient-paint`, `image-paint`, `multi-paint`, `empty-paint`, `unsupported-effect`, `empty-grid`. `counts` gains `styles` and `partialTokens`.

### 7. Module layout — one boundary, two scanners, one merge

Following ADR-0002's boundary precedent exactly:

```
src/figma/scan.ts            unchanged — Variables → FileSnapshot
src/figma/scanStyles.ts      NEW — the only module that touches figma.get*StylesAsync
src/tokens/build.ts          unchanged — FileSnapshot → Variables token files
src/tokens/buildStyles.ts    NEW — StylesSnapshot → style token files (pure)
src/tokens/styleValues.ts    NEW — paint/text/effect/grid value mapping (pure)
src/tokens/collisions.ts     generalised to source-agnostic candidates
src/tokens/merge.ts          NEW — composes both builds, runs the shared collision
                                   pass, emits the merged manifest and report
src/tokens/paths.ts          reused verbatim
src/tokens/serialize.ts      reused verbatim
```

A separate module, not an extension of `build.ts`: the two paths share almost no logic (no modes, no aliases-by-mode, no subtypes on the styles side) and `build.ts` is already 750 lines. What they share is the pure helpers, which is the right seam.

The **merge step owns the collision pass**, and neither builder writes a file directly. Each builder emits candidate tokens plus its own report entries; `merge.ts` runs collision detection across the union, drops losers, and serialises. This is the only way collisions can be cross-source at all, and it keeps "who wins" in one place rather than split across two builders.

The single Figma-side entry point becomes one scan returning `{ variables: FileSnapshot, styles: StylesSnapshot }`. Styles are read with `getLocalPaintStylesAsync` / `getLocalTextStylesAsync` / `getLocalEffectStylesAsync` / `getLocalGridStylesAsync`, sorted by name then id before conversion so output does not depend on Figma's undocumented return order (ADR-0002 Amendment 1 §F rejected relying on that for collections; same applies here).

## Consequences

- `@frontend-engineer` can build Phase 3 against this: layout, `$type`s, value mappings, provenance, precedence, and report shape are all pinned.
- Style tokens are mode-free, so a file that expresses light/dark as two paint styles gets two independently named tokens, not one token with two modes. That is a faithful import of what the file says; folding them into modes would be a guess. Converting styles to Variables is a Figma-side migration, not an import feature.
- `$manifest.json` version 2 means the Phase 8 export reader must handle both — cheap now, and cheaper than an unversioned change.
- Grid tokens exist in the JSON with a non-DTCG `$type` that nothing downstream consumes yet. Accepted: importing them losslessly costs little, and re-deriving them later from a file whose styles have drifted costs a lot.
- Effect and typography tokens carry Figma-specific detail in `$extensions` that the DTCG surface does not model. Files get more verbose; deterministic key ordering keeps diffs readable, and Phase 5 apply is only possible because of it.
- Cross-source precedence means a Variable silently outranks a style at the same path — silently in *behaviour*, but never in the report, which names both participants and the rule.
- No infra implication. Still files in a git repo, so PRD §8's zero-recurring-cost constraint is untouched.

## Alternatives considered

- **One `tokens/styles.json` for all four kinds.** Rejected — every re-import rewrites one file, the worst case for the Phase 6 diff view, and the same reason ADR-0002 §1 split per mode.
- **Model Styles as a synthetic collection with four modes.** Rejected — modes are theme alternatives; a theme would end up selecting one style kind.
- **Prefix style token paths with their kind (`text/`, `effect/`).** Rejected — mangles the round-trip identity that ADR-0002 §1 makes load-bearing, and hides real collisions instead of reporting them.
- **Flatten typography to `typography/body/font-size` style leaf tokens.** Rejected outright by issue #3's acceptance criteria, and it discards the grouping that makes a text style applicable as a unit in Phase 5.
- **Resolve a Variable-bound paint style to a hex literal.** Rejected for the same reason ADR-0002 §2 refuses to resolve aliases: it destroys the semantic layer.
- **Import gradients as a bespoke `$value` shape now.** Rejected — DTCG's gradient type is still draft, nothing downstream consumes it in Phase 3, and a reported non-import is reversible where a wrong shape baked into the source of truth is not.
- **Skip grid styles entirely as `unsupported-type`.** Rejected — issue #3 asks for all four kinds, and the data is cheap to carry losslessly.
- **Apply Amendment 1 §F's comparator to cross-source collisions.** Rejected — both of its real criteria are undefined for style tokens, so it would silently degrade to alphabetical order, which §F itself argues has no relationship to correctness.
- **Name-similarity-based mirror detection** (treat any style whose path matches a Variable as redundant). Rejected — that is a guess, and it would suppress exactly the collisions a designer needs to see. Only a provable binding counts (§4).

## Open questions (not decided here)

- **Report volume on a real file.** §4 de-noises the provable-mirror case, but a file where styles and Variables were maintained in parallel *without* bindings will still produce a long `cross-set` collision list. If that turns out to be the norm on Shyam's real file, the answer is probably an import-time source filter (Variables only / Styles only / both) — which is a product decision for `@ux-designer` or Shyam, not a schema one. Deferred until there is evidence from a real import.
- **Whether style import should be opt-in per kind.** Same shape of question, same owner. Phase 3 imports all four kinds unconditionally.
- **Font weight keyword table coverage.** The mapping from Figma's free-text `fontName.style` to a numeric weight is inherently incomplete (foundry-specific names, variable-font instances). This ADR fixes the *behaviour* on a miss — keep the string, flag it — not the table's contents, which can grow without an amendment.
- **Whether `grid` should eventually move behind a namespaced extension** rather than a divergent `$type`, if DTCG ever standardises something adjacent. Revisit at Phase 8 if an export target ever wants grids.
- **PRD §6.1's type list** ("shadow", "typography") does not mention grid, which Phase 3 imports. A one-line PRD touch-up, flagged rather than made here — the PRD is not this agent's document.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §1 layout, §2 aliases, §3 `$type`/extensions, §4 divergences, §5 collisions, §7 determinism; Amendment 1 §B, §E, §F, §H
- PRD §6.1, §6.5.1, §9 Phase 3, §11 (import fidelity — "fail loud and specific"): `docs/prd.md`
- GitHub issue #3 (Phase 3 acceptance criteria)
- Phase 2 implementation: `src/figma/scan.ts`, `src/tokens/build.ts`, `src/tokens/collisions.ts`, `src/tokens/paths.ts`
- `@figma/plugin-typings` — `PaintStyle`, `TextStyle`, `EffectStyle`, `GridStyle`, `Paint`, `Effect`, `LayoutGrid`, `LineHeight`, `LetterSpacing`
- DTCG format spec — `typography` and `shadow` composite types, `dimension` and `fontWeight` types, `gradient` (draft)
