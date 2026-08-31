# ADR-0002 — Variables-backed token schema and repo layout

**Status**: Accepted
**Date**: 2026-09-01
**Owner**: @tech-lead

## Context

Phase 2 (PRD §9, issue #2) needs a concrete token schema before the Variables → JSON import can be built. The schema must be DTCG-compatible (PRD §6.1), preserve Figma Variable aliases as references rather than resolved values, map collections/modes onto token sets/themes (§6.2), carry the opacity vs. duration/easing type distinction clarified in `eb32ea9`/`e7098cf`, and produce output that re-imports stably and diffs cleanly in git ahead of Phase 6 sync.

Figma's model: a `VariableCollection` has N modes; a `Variable` has one value per mode; names are `/`-delimited; number Variables carry an optional `VariableScope` that is the only auto-detect signal available, and only for some subtypes.

Scope here is the four Variables-backed types only — color, number, boolean, string. Styles-backed types (typography, shadow/effect, grid) are Phase 3.

## Decision

### 1. One file per (collection, mode); token path is the variable name, unprefixed

```
tokens/
  $manifest.json          # collections, modes, set files, theme composition
  $import-report.json     # flagged items from the last import
  core/value.json
  theme/light.json
  theme/dark.json
```

Path is always `tokens/<collection-slug>/<mode-slug>.json`, including single-mode collections — no rename churn when a second mode is added later. Slugs are lowercased with non-alphanumerics collapsed to `-`; original names live in the manifest.

Inside a file, the `/`-delimited variable name splits directly into nested DTCG groups, segments verbatim from Figma — the token path is the round-trip identity, so it is never slugged, cased, or prefixed. A variable named `atlas/ref/palette/neutral/black` becomes `atlas.ref.palette.neutral.black` regardless of which collection or mode file it lands in.

The collection name is deliberately **not** prepended to the token path. Collection identity lives in the manifest and in each token's `$extensions.figma.collectionId`, not in its name. This means a token's reference string survives a variable moving between collections, matches Figma's own model (an alias points at a Variable, not at a variable-in-a-collection), and matches the shape the atlas pipeline already produces.

Merging the set files enabled for a theme yields one document in which every reference resolves natively, so Style Dictionary (Phase 8) can glob-and-merge with no custom resolver. Splitting per mode rather than per collection means a change to `dark` never touches the `light` file — mode-scoped diffs, which is what Phase 6's diff view wants.

Sets in a theme are ordered, last-wins, so a later set can override a token from an earlier one. Import never *generates* an override: any duplicate path it would produce across two sets in the same theme is a cross-collection name clash, and gets reported as a collision (§5). The ordering exists for hand-authored sets later, not as an import behaviour.

### 2. Aliases are plain, mode-free token references

A Figma `VARIABLE_ALIAS` resolves to `{<dotted variable path>}` in `$value` — the target variable's name with `/` replaced by `.`, no collection qualifier. Mode is deliberately not encoded: a Figma alias points at a Variable, not at a Variable-in-a-mode, and the mode is supplied by the active theme. Consequence: a token's `$value` alone does not determine a concrete value; resolution is always theme-scoped.

This is byte-identical to the alias strings the atlas pipeline emits (`{atlas.ref.palette.neutral.black}`), so the only shape change from what Shyam is used to authoring is DTCG's `$value`/`$type` sigils in place of legacy `value`/`type`.

### 3. `$type` and the `com.tokenvault` extension

| Figma | `$type` | `$value` |
|---|---|---|
| COLOR | `color` | `#rrggbb`, or `#rrggbbaa` when alpha < 1 |
| FLOAT | `number` | raw number, unitless |
| BOOLEAN | `boolean` | `true` / `false` |
| STRING | `string` | string |

Number subtype is **not** encoded in `$type`. All numbers stay `$type: "number"` and carry the distinction in the standard DTCG escape hatch:

```json
"$extensions": {
  "com.tokenvault": {
    "subtype": "spacing",
    "subtypeSource": "default",
    "figma": {
      "variableId": "VariableID:12:34",
      "collectionId": "VariableCollectionId:12:1",
      "modeId": "12:0",
      "scopes": ["ALL_SCOPES"]
    }
  }
}
```

- `subtype` — for numbers: `spacing | sizing | radius | opacity | duration | unitless`. For strings, only `easing` is meaningful in Phase 2. Absent means untagged.
- `subtypeSource` — `auto` (derived from `VariableScope`), `user` (explicit flag/tag step), `default` (importer's guess, unconfirmed). This *is* the inline warning channel: a `default` value means "imported, but nobody confirmed the type."
- `figma.variableId` — the identity key for re-import matching, so renaming a Variable in Figma moves a token rather than creating a new one, and for Phase 5 drift detection.

Tagging rules at import, per PRD §6.1:
- `scopes` contains `OPACITY` → `subtype: "opacity"`, `subtypeSource: "auto"`.
- Other useful scopes map where unambiguous (`CORNER_RADIUS` → `radius`; `WIDTH_HEIGHT` → `sizing`; `GAP` → `spacing`), also `auto`.
- `ALL_SCOPES` or anything else → `subtype: "spacing"`, `subtypeSource: "default"`, surfaced in the flag/tag step for confirmation.
- Duration/easing is never auto-detectable and only ever arrives as `subtypeSource: "user"`.
- On re-import, existing `subtypeSource: "user"` tags are read from the current token files (keyed by `figma.variableId`) and preserved. Auto and default tags are recomputed.

Why not `$type: "dimension"` / `"duration"`: both require a unit in DTCG's object form, and Figma stores a bare number. Inventing `px`/`ms` at import time would be a lossy guess baked into the source of truth. Keeping numbers raw makes import lossless and moves unit synthesis to the Style Dictionary transform layer (Phase 8), where the target platform actually determines the unit. Promoting subtypes to first-class `$type`s later is a pure export-side change.

### 4. Deliberate DTCG divergences

- `boolean` and `string` are not DTCG core types. Tokenvault uses them anyway (Token Studio does the same); documented here rather than shoehorned into a core type. Conformant tools that don't recognise them should ignore them, not misread them.
- Colors are written as hex strings, not DTCG's `{colorSpace, components, alpha}` object. Hex is what every consuming tool reads today, and Figma's UI authors 8-bit hex, so the 8-bit round-trip is exact in practice. Non-sRGB Figma colors are a report entry, not a silent conversion.

### 5. Flagged items: report file plus inline provenance

Both, split by whether the token made it in:

- **Imported but degraded** → inline, via `subtypeSource: "default"`. No separate mechanism needed.
- **Not imported, or contested** → `tokens/$import-report.json`, committed alongside the tokens so unmapped items show up in a PR diff rather than only in a UI that nobody re-opens. Entry kinds: `collision`, `unmappable-value`, `unsupported-type`.

Three collision kinds are detected, all treated the same way:

- **Within a set** — case-only name clashes (`color/Brand` vs `color/brand`).
- **Token/group** — a variable whose path is also a group prefix of another (`color/brand` and `color/brand/primary`). DTCG cannot represent a node that is both.
- **Across sets in one theme** — the same path produced from two different collections, which is a name clash rather than an intentional override (see §1).

Resolution is deterministic — first wins, sorted by collection name then variable name — and **every** participant, winner included, is recorded in the report with its variable id and the contested path. Losers are not written and not renamed: no silent drop, no mangled name. The fix is a rename in Figma.

### 6. Themes in the manifest

`$manifest.json` records collections, modes, and set files truthfully, and generates themes only for the unambiguous case: one multi-mode collection combined with the single mode of every single-mode collection. Two or more multi-mode collections make theme composition a product question (which combinations are real themes?) — import writes no themes and files a report entry instead of guessing a cartesian product. Full theme composition is Phase 7.

Set identifiers follow the atlas/Tokens Studio convention: `"<Collection>/<Mode>"` using original Figma names (`"Theme/Light"`), with a flat `tokenSetOrder` array alongside the richer `collections` block so the file stays legible to anyone used to a `$metadata.json`. Each mode entry carries `$figmaCollectionId` and `$figmaModeId` back-references to the Figma source, same idea as atlas's `$themes.json`.

### 7. Determinism

Output is 2-space indented, keys sorted alphabetically at every level, trailing newline. Re-running import against an unchanged file produces a byte-identical tree.

## Example

Figma: collection **Core** (single mode `Value`) with `tv/ref/palette/blue-500`, `tv/ref/palette/white`, `tv/ref/palette/grey-900`, `tv/global/space/4` (unscoped), `tv/global/opacity/disabled` (scoped `OPACITY`), `tv/global/motion/duration-fast` (user-flagged duration); collection **Theme** (modes `Light`, `Dark`) with `tv/color/bg/canvas`, `tv/color/text/accent` (both aliasing Core), and boolean `tv/flag/high-contrast`.

**`tokens/core/value.json`** (abridged — `tv.ref.palette.grey-900` and `.white` follow the same shape)

```json
{
  "tv": {
    "global": {
      "motion": {
        "duration-fast": { "$type": "number", "$value": 150,
          "$extensions": { "com.tokenvault": { "subtype": "duration", "subtypeSource": "user", "figma": { "variableId": "VariableID:1:15", "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["ALL_SCOPES"] } } } }
      },
      "opacity": {
        "disabled": { "$type": "number", "$value": 0.4,
          "$extensions": { "com.tokenvault": { "subtype": "opacity", "subtypeSource": "auto", "figma": { "variableId": "VariableID:1:14", "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["OPACITY"] } } } }
      },
      "space": {
        "4": { "$type": "number", "$value": 4,
          "$extensions": { "com.tokenvault": { "subtype": "spacing", "subtypeSource": "default", "figma": { "variableId": "VariableID:1:13", "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["ALL_SCOPES"] } } } }
      }
    },
    "ref": {
      "palette": {
        "blue-500": { "$type": "color", "$value": "#2d7ff9",
          "$extensions": { "com.tokenvault": { "figma": { "variableId": "VariableID:1:10", "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["ALL_SCOPES"] } } } }
      }
    }
  }
}
```

**`tokens/theme/light.json`**

```json
{
  "tv": {
    "color": {
      "bg": {
        "canvas": { "$type": "color", "$value": "{tv.ref.palette.white}",
          "$extensions": { "com.tokenvault": { "figma": { "variableId": "VariableID:2:10", "collectionId": "VariableCollectionId:2:1", "modeId": "2:0", "scopes": ["ALL_SCOPES"] } } } }
      },
      "text": {
        "accent": { "$type": "color", "$value": "{tv.ref.palette.blue-500}",
          "$extensions": { "com.tokenvault": { "figma": { "variableId": "VariableID:2:11", "collectionId": "VariableCollectionId:2:1", "modeId": "2:0", "scopes": ["ALL_SCOPES"] } } } }
      }
    },
    "flag": {
      "high-contrast": { "$type": "boolean", "$value": false,
        "$extensions": { "com.tokenvault": { "figma": { "variableId": "VariableID:2:12", "collectionId": "VariableCollectionId:2:1", "modeId": "2:0", "scopes": [] } } } }
    }
  }
}
```

**`tokens/theme/dark.json`** — identical shape, `modeId: "2:1"`, `bg.canvas` → `{tv.ref.palette.grey-900}`, `high-contrast` → `true`.

Note that the `tv` root here comes from the variable *names*, not from the collection — both files root at `tv` because both collections' variables are named that way, and the two sets never collide because their sub-paths differ.

**`tokens/$manifest.json`**

```json
{
  "version": 1,
  "generatedBy": "tokenvault",
  "tokenSetOrder": ["Core/Value", "Theme/Light", "Theme/Dark"],
  "collections": [
    { "name": "Core", "slug": "core", "$figmaCollectionId": "VariableCollectionId:1:1",
      "modes": [{ "name": "Value", "slug": "value", "set": "Core/Value", "$figmaModeId": "1:0", "file": "core/value.json" }] },
    { "name": "Theme", "slug": "theme", "$figmaCollectionId": "VariableCollectionId:2:1",
      "modes": [
        { "name": "Light", "slug": "light", "set": "Theme/Light", "$figmaModeId": "2:0", "file": "theme/light.json" },
        { "name": "Dark", "slug": "dark", "set": "Theme/Dark", "$figmaModeId": "2:1", "file": "theme/dark.json" }
      ] }
  ],
  "themes": [
    { "name": "Light", "selectedTokenSets": ["Core/Value", "Theme/Light"] },
    { "name": "Dark", "selectedTokenSets": ["Core/Value", "Theme/Dark"] }
  ]
}
```

**`tokens/$import-report.json`**

```json
{
  "version": 1,
  "importedAt": "2026-09-01T00:00:00.000Z",
  "figmaFileKey": "abc123",
  "counts": { "tokens": 11, "flagged": 0, "unconfirmedSubtypes": 1 },
  "entries": []
}
```

## Consequences

- `@frontend-engineer` can implement Phase 2 directly against this: the shape, the extension fields, the tagging rules, and the output determinism are all pinned.
- Token files are Figma-file-specific — `figma.variableId` does not survive copying tokens into a different Figma file. Accepted: those ids are what make re-import matching and Phase 5 drift detection work, and the tokens are the source of truth for *this* file.
- Style Dictionary gets a merged document with valid native references and no custom resolver, but will need a Phase 8 transform that reads `com.tokenvault.subtype` to attach units.
- Every token carries an `$extensions` block, so files are more verbose than hand-written token JSON. Deterministic key ordering keeps the diffs readable anyway.
- Theme composition beyond the single-multi-mode-collection case is deferred and visible in the report, not silently invented.
- No infra implication — everything here is files in a git repo, so the PRD §8 zero-cost constraint is untouched.

## Alternatives considered

- **Legacy Tokens Studio `value`/`type` leaf shape**, as used by the atlas pipeline. Rejected — PRD §6.1 requires DTCG specifically. The structural shape (nested-by-path-segment objects, `{dot.path}` alias strings) is identical either way, so the only visible difference is the `$` sigils.
- **Prefixing the token path with the collection slug** (`{core.tv.ref.…}`). Rejected after checking the atlas precedent — it breaks reference stability when a variable moves collection, doesn't match Figma's alias model, and produces reference strings unlike the ones Shyam already authors against. Cross-collection path clashes are handled by the collision detector instead.
- **One file per collection with modes nested inside each token** (`{"$value": {"light": …, "dark": …}}`). Rejected — not DTCG, and every mode edit touches every token's diff hunk.
- **Encode number subtypes in `$type` as `dimension`/`duration`.** Rejected — both require a unit Figma doesn't store, so import would bake a guess into the source of truth. Revisit at Phase 8 if export ergonomics demand it.
- **Resolve aliases to raw values at import.** Rejected outright by issue #2's acceptance criteria, and it would destroy the semantic layer the whole tool exists to manage.
- **Report only in the plugin UI, nothing committed.** Rejected — a flagged item that only exists in a dismissed dialog is a silently dropped item by Phase 6.
- **Suffix-rename colliding tokens (`primary-2`).** Rejected — that is the "mangling" §6.5.1 rules out; a reported non-write is louder and reversible.
- **A single `tokens.json` with all sets nested.** Rejected — every import rewrites one large file, which is the worst case for the Phase 6 diff view.

## Open questions (not decided here)

- **Theme naming and composition UX** when multiple multi-mode collections exist — product/UX call for `@ux-designer` or Shyam, deferred to Phase 7.
- **The flag/tag step's interaction design** (bulk-tag by name pattern? per-token?) — `@ux-designer`'s call; this ADR only fixes what that step writes.
- **Name-prefix filtering and platform scoping.** The atlas pipeline treated only `atlas/`-prefixed variables as real tokens, excluded `*`-prefixed segments as design-tooling scaffolding, and parsed a `web`/`app`/`ios`/`android` segment out of the path. Issue #2 asks for none of this and Phase 2 imports every variable, but it is adjacent to collision handling and will resurface if a real file turns out to be full of non-token variables. Deferred, not designed for.

## Precedent checked

Validated against `~/Desktop/atlas/` (read-only), an older Tokens Studio–format pipeline over the same Figma-Variables source model:

- `tokenizer/projector/real-out/android/Theme/Light.json` — nested-by-path-segment tree with `{dot.path}` alias strings. This schema's structure matches; only `value`/`type` → `$value`/`$type` differs.
- `subzero-tokens-web/src/atlas-tokens/web/$metadata.json` and `$themes.json` — one file per collection/mode, `tokenSetOrder`, themes referencing `selectedTokenSets` plus `$figmaModeId`/`$figmaCollectionId`. Adopted: the set-id convention, `tokenSetOrder`, `selectedTokenSets`, and the `$figma*` back-reference naming.
- `tokenizer/projector/fixture.json` — raw `valuesByMode` / `VARIABLE_ALIAS` source shape, consistent with the import-side model assumed here.

Atlas's larger machinery (platform variants, multi-repo fan-out, program-token special-casing) is deliberately not replicated.

## References

- PRD §6.1, §6.2, §6.5.1, §9 Phase 2: `docs/prd.md`
- GitHub issue #2 (Phase 2 acceptance criteria)
- Clarification commits `e7098cf`, `eb32ea9` (opacity vs. duration/easing asymmetry)
- Prior-art pipeline: `~/Desktop/atlas/` (local, read-only — see "Precedent checked")
- DTCG format spec (`$type`/`$value`/`$description`/`$extensions`, `{dot.path}` references)
