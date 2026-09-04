# ADR-0002 — Variables-backed token schema and repo layout

**Status**: Accepted
**Date**: 2026-09-01
**Revision**: 3 — amended 2026-09-01, see [Amendment 1](#amendment-1--2026-09-01-phase-2-implementation-feedback); amended 2026-09-04, see [Amendment 2](#amendment-2--2026-09-04--configurable-path-transform-rules)
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

> **Amended by [Amendment 2](#amendment-2--2026-09-04--configurable-path-transform-rules) (2026-09-04).** "Verbatim" is narrowed to "verbatim, unless a declared path rule says otherwise", and a rule may also exclude a variable from import entirely. The token path becomes a pure function of the variable name *and* the committed rule set, rather than of the variable name alone. Everything this paragraph was protecting — no implicit slugging, no implicit casing, no implicit prefixing, one predictable answer per re-scan — still holds; what changes is that the function is now user-declarable and visible in the repo instead of being fixed at identity.

The collection name is deliberately **not** prepended to the token path. Collection identity lives in the manifest and in each token's `$extensions.figma.collectionId`, not in its name. This means a token's reference string survives a variable moving between collections, matches Figma's own model (an alias points at a Variable, not at a variable-in-a-collection), and matches the shape the atlas pipeline already produces.

Merging the set files enabled for a theme yields one document in which every reference resolves natively, so Style Dictionary (Phase 8) can glob-and-merge with no custom resolver. Splitting per mode rather than per collection means a change to `dark` never touches the `light` file — mode-scoped diffs, which is what Phase 6's diff view wants.

Sets in a theme are ordered, last-wins, so a later set can override a token from an earlier one. Import never *generates* an override: any duplicate path it would produce across two sets in the same theme is a cross-collection name clash, and gets reported as a collision (§5). The ordering exists for hand-authored sets later, not as an import behaviour.

### 2. Aliases are plain, mode-free token references

A Figma `VARIABLE_ALIAS` resolves to `{<dotted variable path>}` in `$value` — the target variable's name with `/` replaced by `.`, no collection qualifier. Mode is deliberately not encoded: a Figma alias points at a Variable, not at a Variable-in-a-mode, and the mode is supplied by the active theme. Consequence: a token's `$value` alone does not determine a concrete value; resolution is always theme-scoped.

This is byte-identical to the alias strings the atlas pipeline emits (`{atlas.ref.palette.neutral.black}`), so the only shape change from what Shyam is used to authoring is DTCG's `$value`/`$type` sigils in place of legacy `value`/`type`.

### 3. `$type` and the `com.tokenvault` extension

| Figma `resolvedType` | `$type` | `$value` |
|---|---|---|
| COLOR | `color` | `#rrggbb`, or `#rrggbbaa` when alpha < 1 |
| FLOAT | `number` | raw number, unitless |
| BOOLEAN | `boolean` | `true` / `false` |
| STRING | `string` | string |
| EASING, TIMING | — | not imported in Phase 2 — see [Amendment 1 §A](#a-easing-and-timing-resolved-types-deferred-with-a-landing-zone) |

Number subtype is **not** encoded in `$type`. All numbers stay `$type: "number"` and carry the distinction in the standard DTCG escape hatch (keys alphabetical per §7):

```json
"$extensions": {
  "com.tokenvault": {
    "figma": {
      "collectionId": "VariableCollectionId:12:1",
      "modeId": "12:0",
      "scopes": ["ALL_SCOPES"],
      "variableId": "VariableID:12:34"
    },
    "subtype": "spacing",
    "subtypeSource": "default"
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
- Duration/easing is never auto-detectable **for FLOAT and STRING variables**, and only ever arrives as `subtypeSource: "user"`. Natively-typed TIMING/EASING variables are self-describing and are a separate case — Amendment 1 §A.
- On re-import, existing `subtypeSource: "user"` tags are read from the current token files (keyed by `figma.variableId`) and preserved. Auto and default tags are recomputed.

`$description` is written from `Variable.description` when non-empty, and omitted otherwise. Additive, lossless, and a DTCG core key — no extension needed.

Why not `$type: "dimension"` / `"duration"`: both require a unit in DTCG's object form, and Figma stores a bare number. Inventing `px`/`ms` at import time would be a lossy guess baked into the source of truth. Keeping numbers raw makes import lossless and moves unit synthesis to the Style Dictionary transform layer (Phase 8), where the target platform actually determines the unit. Promoting subtypes to first-class `$type`s later is a pure export-side change.

### 4. Deliberate DTCG divergences

- `boolean` and `string` are not DTCG core types. Tokenvault uses them anyway (Token Studio does the same); documented here rather than shoehorned into a core type. Conformant tools that don't recognise them should ignore them, not misread them.
- Colors are written as hex strings, not DTCG's `{colorSpace, components, alpha}` object. Hex is what every consuming tool reads today, and Figma's UI authors 8-bit hex, so the 8-bit round-trip is exact in practice. Non-sRGB Figma colors are a report entry, not a silent conversion.

### 5. Flagged items: report file plus inline provenance

Both, split by whether the token made it in:

- **Imported but degraded** → inline, via `subtypeSource: "default"`. No separate mechanism needed.
- **Not imported, or contested** → `tokens/$import-report.json`, committed alongside the tokens so unmapped items show up in a PR diff rather than only in a UI that nobody re-opens. Entry kinds: `collision`, `unmappable-value`, `unsupported-type`, plus `theme-composition` and `dangling-reference` added in Amendment 1 §C and §G.

Four collision kinds are detected (`set-slug` added in Amendment 1 §E), all treated the same way:

- **Set slug** — two collections whose names slugify to the same `tokens/<slug>/` directory (`Core`, `core!`).
- **Within a set** — case-only name clashes (`color/Brand` vs `color/brand`).
- **Token/group** — a variable whose path is also a group prefix of another (`color/brand` and `color/brand/primary`). DTCG cannot represent a node that is both.
- **Across sets in one theme** — the same path produced from two different collections, which is a name clash rather than an intentional override (see §1).

Resolution is deterministic and **every** participant, winner included, is recorded in the report with its variable id and the contested path. Losers are not written and not renamed: no silent drop, no mangled name. The fix is a rename in Figma.

> **Superseded by Amendment 1 §F.** The original winner rule — "first wins, sorted by collection name then variable name" — is replaced by a blast-radius-minimising comparator. Everything else in this section stands.

### 6. Themes in the manifest

`$manifest.json` records collections, modes, and set files truthfully, and generates themes only for the unambiguous case: one multi-mode collection combined with the single mode of every single-mode collection. Two or more multi-mode collections make theme composition a product question (which combinations are real themes?) — import writes no themes and files a report entry instead of guessing a cartesian product. Full theme composition is Phase 7.

> **Amended by Amendment 1 §C and §D**: the report entry gets its own `theme-composition` kind, and the zero-multi-mode-collection case generates a single synthesised `Default` theme rather than none.

Set identifiers follow the atlas/Tokens Studio convention: `"<Collection>/<Mode>"` using original Figma names (`"Theme/Light"`), with a flat `tokenSetOrder` array alongside the richer `collections` block so the file stays legible to anyone used to a `$metadata.json`. Each mode entry carries `$figmaCollectionId` and `$figmaModeId` back-references to the Figma source, same idea as atlas's `$themes.json`.

### 7. Determinism

Output is 2-space indented, keys sorted alphabetically at every level, trailing newline. Re-running import against an unchanged file produces a byte-identical tree.

Alphabetical means *every* key, with no exception for DTCG's `$`-prefixed ones — `$description`, `$extensions`, `$type`, `$value` sort in that order, ahead of any group child. One rule, one serializer, no special cases for a future writer to rediscover. **Array** order is meaningful data (`tokenSetOrder`, `modes`, `selectedTokenSets`) and is never sorted.

Byte-identical also requires normalising float32 noise — Amendment 1 §H.

## Example

Figma: collection **Core** (single mode `Value`) with `tv/ref/palette/blue-500`, `tv/ref/palette/white`, `tv/ref/palette/grey-900`, `tv/global/space/4` (unscoped), `tv/global/opacity/disabled` (scoped `OPACITY`), `tv/global/motion/duration-fast` (user-flagged duration); collection **Theme** (modes `Light`, `Dark`) with `tv/color/bg/canvas`, `tv/color/text/accent` (both aliasing Core), and boolean `tv/flag/high-contrast`.

**`tokens/core/value.json`** (abridged — `tv.ref.palette.grey-900` and `.white` follow the same shape)

```json
{
  "tv": {
    "global": {
      "motion": {
        "duration-fast": {
          "$extensions": { "com.tokenvault": { "figma": { "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["ALL_SCOPES"], "variableId": "VariableID:1:15" }, "subtype": "duration", "subtypeSource": "user" } },
          "$type": "number", "$value": 150 }
      },
      "opacity": {
        "disabled": {
          "$extensions": { "com.tokenvault": { "figma": { "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["OPACITY"], "variableId": "VariableID:1:14" }, "subtype": "opacity", "subtypeSource": "auto" } },
          "$type": "number", "$value": 0.4 }
      },
      "space": {
        "4": {
          "$extensions": { "com.tokenvault": { "figma": { "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["ALL_SCOPES"], "variableId": "VariableID:1:13" }, "subtype": "spacing", "subtypeSource": "default" } },
          "$type": "number", "$value": 4 }
      }
    },
    "ref": {
      "palette": {
        "blue-500": {
          "$description": "Primary accent ramp, step 500.",
          "$extensions": { "com.tokenvault": { "figma": { "collectionId": "VariableCollectionId:1:1", "modeId": "1:0", "scopes": ["ALL_SCOPES"], "variableId": "VariableID:1:10" } } },
          "$type": "color", "$value": "#2d7ff9" }
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
        "canvas": {
          "$extensions": { "com.tokenvault": { "figma": { "collectionId": "VariableCollectionId:2:1", "modeId": "2:0", "scopes": ["ALL_SCOPES"], "variableId": "VariableID:2:10" } } },
          "$type": "color", "$value": "{tv.ref.palette.white}" }
      },
      "text": {
        "accent": {
          "$extensions": { "com.tokenvault": { "figma": { "collectionId": "VariableCollectionId:2:1", "modeId": "2:0", "scopes": ["ALL_SCOPES"], "variableId": "VariableID:2:11" } } },
          "$type": "color", "$value": "{tv.ref.palette.blue-500}" }
      }
    },
    "flag": {
      "high-contrast": {
        "$extensions": { "com.tokenvault": { "figma": { "collectionId": "VariableCollectionId:2:1", "modeId": "2:0", "scopes": [], "variableId": "VariableID:2:12" } } },
        "$type": "boolean", "$value": false }
    }
  }
}
```

**`tokens/theme/dark.json`** — identical shape, `modeId: "2:1"`, `bg.canvas` → `{tv.ref.palette.grey-900}`, `high-contrast` → `true`.

Note that the `tv` root here comes from the variable *names*, not from the collection — both files root at `tv` because both collections' variables are named that way, and the two sets never collide because their sub-paths differ.

**`tokens/$manifest.json`**

```json
{
  "collections": [
    { "$figmaCollectionId": "VariableCollectionId:1:1",
      "modes": [{ "$figmaModeId": "1:0", "file": "core/value.json", "name": "Value", "set": "Core/Value", "slug": "value" }],
      "name": "Core", "slug": "core" },
    { "$figmaCollectionId": "VariableCollectionId:2:1",
      "modes": [
        { "$figmaModeId": "2:0", "file": "theme/light.json", "name": "Light", "set": "Theme/Light", "slug": "light" },
        { "$figmaModeId": "2:1", "file": "theme/dark.json", "name": "Dark", "set": "Theme/Dark", "slug": "dark" }
      ],
      "name": "Theme", "slug": "theme" }
  ],
  "generatedBy": "tokenvault",
  "themes": [
    { "name": "Light", "selectedTokenSets": ["Core/Value", "Theme/Light"] },
    { "name": "Dark", "selectedTokenSets": ["Core/Value", "Theme/Dark"] }
  ],
  "tokenSetOrder": ["Core/Value", "Theme/Light", "Theme/Dark"],
  "version": 1
}
```

**`tokens/$import-report.json`**

```json
{
  "counts": { "flagged": 0, "tokens": 11, "unconfirmedSubtypes": 1 },
  "entries": [],
  "figmaFileKey": "abc123",
  "importedAt": "2026-09-01T00:00:00.000Z",
  "version": 1
}
```

## Consequences

- `@frontend-engineer` can implement Phase 2 directly against this: the shape, the extension fields, the tagging rules, and the output determinism are all pinned.
- Token files are Figma-file-specific — `figma.variableId` does not survive copying tokens into a different Figma file. Accepted: those ids are what make re-import matching and Phase 5 drift detection work, and the tokens are the source of truth for *this* file.
- Style Dictionary gets a merged document with valid native references and no custom resolver, but will need a Phase 8 transform that reads `com.tokenvault.subtype` to attach units.
- Every token carries an `$extensions` block, so files are more verbose than hand-written token JSON. Deterministic key ordering keeps the diffs readable anyway.
- Theme composition beyond the single-multi-mode-collection case is deferred and visible in the report, not silently invented. A file with no multi-mode collection still gets one usable theme, whose name — and only its name — is synthesised (Amendment 1 §D).
- Motion variables (`EASING`, `TIMING`) round-trip as report entries, not tokens, until a later phase (Amendment 1 §A). A file that leans on Figma's motion variables will see them all flagged.
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
- **Name-prefix filtering and platform scoping.** The atlas pipeline treated only `atlas/`-prefixed variables as real tokens, excluded `*`-prefixed segments as design-tooling scaffolding, and parsed a `web`/`app`/`ios`/`android` segment out of the path. Issue #2 asks for none of this and Phase 2 imports every variable, but it is adjacent to collision handling and will resurface if a real file turns out to be full of non-token variables. Deferred, not designed for. **Answered in full by Amendment 2 (2026-09-04)**: the path-parsing half is now a declared rule engine (§A–§D), and the filtering half is the `exclude` action (§I). This question is closed.

## Amendment 1 — 2026-09-01 (Phase 2 implementation feedback)

Building Phase 2 (issue #2) surfaced seven points where this ADR was ambiguous, self-contradictory, or silent. Each is resolved below. The sections above have been edited in place where they were simply *wrong* (the examples' key order); everything else is amended here and cross-referenced from the section it changes.

### A. EASING and TIMING resolved types: deferred, with a landing zone

Confirmed against `@figma/plugin-typings@1.137.0`: `VariableResolvedDataType` is `'BOOLEAN' | 'COLOR' | 'EASING' | 'FLOAT' | 'STRING' | 'TIMING'`. These are real, first-class variable types backing Figma's motion/animation features, not legacy or reserved values — `figma.variables.createVariable()` accepts them, `VariableValue` includes `MotionEasing`, and `AnimationStyle` properties bind to them.

**Decision: Phase 2 does not import them.** A variable of either type produces an `unsupported-type` report entry and is not written. Reasons, so this is not re-derived:

- **EASING** is not a scalar. `MotionEasing` is a tagged object — a named curve (`GENTLE`, `EASE_IN_AND_OUT`, `HOLD`, …), a cubic bézier, or a normalised spring. Mapping it needs a `$value` shape decision that DTCG only half-covers (`cubicBezier` exists; springs and named curves do not), which is a schema decision in its own right and not one Phase 2 needs.
- **TIMING** is a scalar but its unit is unstated in the API, and §3's whole argument is that import must not bake a unit guess into the source of truth.

**Intended landing zone** (not decided now, but recorded so the shape is not re-litigated): TIMING folds into the existing number mechanism — `$type: "number"`, `$value` the raw scalar, `subtype: "duration"`, `subtypeSource: "auto"`, since a natively-typed TIMING variable *is* self-describing. EASING needs its own ADR covering the `MotionEasing` → `$value` mapping. Neither is a new `$type`, consistent with §3.

**Does this undercut §3's "duration/easing is never auto-detectable"?** Partly, and §3 has been narrowed. The original claim — from `e7098cf`/`eb32ea9` and PRD §6.1 — is about `VariableScope`, and that part still holds: there is no `DURATION` or `EASING` scope, so a FLOAT variable used as a duration remains undetectable, which is the common Tokens-Studio-shaped case and the one the flag/tag step exists for. What is now false is the unqualified "never auto-detectable, scoped or not": a TIMING or EASING variable is auto-detectable by `resolvedType`. **PRD §6.1's asymmetry bullet needs the same narrowing** — flagged to Shyam rather than edited here, since the PRD is not this agent's document.

### B. Key order: §7 wins everywhere; the examples were wrong

Alphabetical at every level, `$`-prefixed DTCG keys included. The examples in §3 and the worked Example section have been rewritten to match; they were the inconsistency, not §7.

Rejected: `$type`/`$value` first for readability. It buys a little skimmability at the cost of a two-rule serializer — a leaf exception plus a general sort — that every future writer (Phase 4's editor, Phase 6's sync) has to implement identically or produce spurious diffs. §7's byte-identical guarantee is load-bearing for the diff view; readability is not.

### C. `theme-composition` is a fourth report entry kind

§5's three kinds are all *token*-scoped. A theme-composition problem is file-scoped: no token failed, no participant list exists, and calling it `unmappable-value` misleads anything filtering the report by kind. New kind `theme-composition`, with `reason` one of `ambiguous` (2+ multi-mode collections, §6), `synthesized-default` (§D below), or `no-collections`. Entries carry `message` only — no `path`, `set`, or `participants`.

### D. Zero multi-mode collections: synthesise one `Default` theme

There is exactly one possible composition, and §6's rule is against guessing *composition*, not against naming. Writing no themes for the very common simple-file case leaves the manifest useless to Phase 8's export, which globs by theme — a real usability cost paid to avoid inventing a five-letter string.

So: when no collection has more than one mode and at least one collection was imported, generate a single theme named `Default` whose `selectedTokenSets` is every set in `tokenSetOrder`, plus a `theme-composition` / `synthesized-default` report entry recording that the *name* was invented and is safe to rename. With zero collections imported, write no themes and file `theme-composition` / `no-collections`.

`Default` is a placeholder identifier, not product copy — `@ux-designer` or Shyam may rename it, and nothing depends on the string.

### E. `set-slug` is a fourth collision kind

Formally added to §5. Two collections whose names slugify to the same value would write to the same `tokens/<slug>/` files; the second silently clobbering the first is exactly the silent loss PRD §6.5.1 rules out. Same treatment as the other three: one collection wins, the others are not written, every participant is reported. Participants for this kind carry collection identity with empty `variableId`/`variableName`, since the contest is between collections.

### F. Collision winner selection — minimise blast radius, not alphabetical order

Supersedes §5's "first wins, sorted by collection name then variable name". Alphabetical order has no relationship to which token is correct, and in practice a junk or test collection sorting early can evict the legitimate token — taking every alias that pointed at it down with it.

The ordering cannot make the *right* choice; only a rename in Figma can. What it can do is pick the loser whose removal breaks least. New comparator, applied to `same-set-case`, `cross-set`, and `token-group`; first criterion to differentiate wins:

1. **Inbound alias count** — the number of distinct variables in the file whose value in any mode aliases this variable. Higher wins. This is the actual harm: dropping the referenced token cascades into every referrer.
2. **Namespace ownership** — the number of other surviving variables in the same collection sharing the contested path's parent prefix. Higher wins. A collection that owns the surrounding namespace is the more likely home for the token.
3. **Name order** — collection name, then variable name, then variable id. Unchanged, and still what guarantees a total, reproducible order.

The report entry records which criterion decided it, as `winnerRule`: `"alias-references" | "namespace-majority" | "name-order"`. A winner nobody can explain is worse than a loser, and this keeps the report self-justifying.

For `set-slug`, the collection-level analogue: more variables wins, then collection name, then id; `winnerRule` is `"variable-count"` or `"name-order"`.

Rejected: ordering by `tokenSetOrder` position. That array is itself derived from collection-name sorting, so it carries no independent signal. Also rejected: Figma's `getLocalVariableCollectionsAsync()` return order — undocumented as stable, so nothing should be built on it.

### G. Dangling aliases: write the reference, report it as its own kind

Blessed as implemented, with the entry kind corrected. When a token's `$value` aliases a variable that was not written (a collision loser, or an unsupported type), the reference is still written — the target's name is real in Figma, the fix is a Figma-side rename, and after that rename the reference resolves with no further edit. Excluding the referring token instead would cascade: its own referrers would dangle, and one junk variable could unwrite a whole branch.

But it is not an `unmappable-value` — the token *was* mapped and written. New kind `dangling-reference`, reason `alias-target-skipped`, on the written token. `alias-target-unknown` (target not in the file and not nameable) stays `unmappable-value`, because there it genuinely blocks the token.

§F makes this rarer: the most-referenced variable now wins its collisions, so the common case no longer drops an alias target.

### H. Float32 normalisation (no decision needed, recorded so nobody rediscovers it)

Figma stores FLOAT variable values as 32-bit floats, so a variable a designer typed as `0.4` reads back as `0.4000000059604645`. Writing that verbatim is technically §3's "raw number" but defeats §7 — it makes numeric tokens unreadable and turns any Figma-side re-save into a spurious diff. Import writes the shortest decimal whose float32 rounding is bit-identical to the stored value. This is exact, not a rounding guess: the value still round-trips into Figma unchanged, and if a human typed it, that decimal is what they typed.

### Implementation deltas

Against the Phase 2 branch as built, four things change: the `theme-composition` kind (§C), the synthesised `Default` theme (§D), the `dangling-reference` kind (§G), and the winner comparator plus `winnerRule` field (§F). §A, §B, §E and §H bless what is already there.

## Amendment 2 — 2026-09-04 — configurable path transform rules

**Status of this amendment**: Accepted 2026-09-04, no open questions. Shyam resolved four, three of them against this amendment's own recommendation: **exclusion is in** (§I), **all four transform actions ship** rather than stripping alone (§B), and **an exclusion that leaves a reference dangling blocks the push** (§I). Rule-set mismatch **blocks** (§F), as recommended.

Phase 10 (PRD §9 item 10) asks for configurable token naming rules: a pattern match against a Figma variable's name that transforms the resulting token path — `xyz/base/color/bg/primary` → `base.color.bg.primary`, `semantic/typography/xyz/title` → `semantic.typography.title` — configured once and re-evaluated on every scan, never baked into a token's stored data.

That contradicts §1 as written, so it is amended here rather than decided in code. ADR-0008 (multi-repo push routing) depends on §A's matcher and is a separate decision.

### A. Source name and token path become two things; the matcher is shared

| Term | Meaning | Stability |
|---|---|---|
| **Source name** | The Figma variable's `/`-delimited name, verbatim | Figma's; changes only when a designer renames |
| **Token path** | `pathRules(sourceName)`, `/` → `.` | Derived, recomputed on every scan |

The identity key is unchanged: it is still `$extensions.com.tokenvault.figma.variableId` (§3), never the path. Rules therefore cannot break re-import matching, drift detection or apply targeting, all of which key on the id.

**A rule is never stored on a token.** Nothing in a token file records which rules produced its path — that is the "re-evaluated live" requirement, and it is also what keeps §7's determinism intact. Rename a variable in Figma so it still matches the same rule, and the next scan produces the same transformation.

The matcher, used here and by ADR-0008:

```jsonc
{ "kind": "segment", "value": "xyz", "caseSensitive": false }   // any name containing that exact segment
{ "kind": "name",    "pattern": "^semantic/.*/(ios|android)$" } // regex over the whole /-delimited name
```

`segment` is the common case and is not a regex, so a name containing `.` or `(` needs no escaping. `name` is the escape hatch. **The match text has no required relationship to what the action does** — that asymmetry is the point, and nothing in the engine assumes otherwise.

### B. Three actions, applied as an ordered pipeline

```jsonc
{
  "id": "strip-xyz",
  "enabled": true,
  "match":  { "kind": "segment", "value": "xyz" },
  "action": { "kind": "drop-matched-segments" },
  "note":   "xyz/ is a Figma-side grouping convention, not part of the token path"
}
```

**All four actions ship** *(resolved 2026-09-04 — Shyam, over this amendment's recommendation to ship stripping alone)*:

| Action | Effect |
|---|---|
| `drop-matched-segments` | Removes every segment the match selected, wherever it occurs |
| `replace-segment` (`with`) | Rewrites every matched segment to a literal |
| `rewrite` (`pattern`, `replacement`) | Regex replace over the whole `/`-delimited name, `$1` capture groups |
| `exclude` | The variable is **not imported at all** — §I |

Insertion needs no fifth action; it is `rewrite` with a replacement that keeps its capture. Prepending `brand/` to everything under `color/` is `{ "pattern": "^color/(.*)$", "replacement": "brand/color/$1" }`. Shipping the general form rather than a `prepend`/`append` pair keeps the action list closed — anything positional is expressible, and there is no next amendment adding `insert-at`.

**Rules are an ordered list and every enabled rule runs, in order, each on the previous rule's output.** A pipeline, not first-match-wins. Both of Shyam's examples are one rule applied at two positions, so position-independence is required; and a pipeline makes "two rules disagree" a non-question — the later rule operates on what the earlier one produced, and precedence is the array order. Order is meaningful data and is never sorted, per §7's array rule.

**`exclude` short-circuits the pipeline** for that variable. Later rules do not run — there is no path left to transform — so a rule set is read top-to-bottom and an `exclude` is a terminal statement about everything below it, for the variables it matched.

The pipeline runs **once** per variable per scan. It is a pure function of the source name and the rule set, so re-scan determinism does not depend on any individual rule being idempotent.

### C. Where it runs: before path splitting, therefore before collision detection

```
scan → sourceName → pathRules ─┬─ excluded → not imported (§I)
                               └─ tokenPath → split on "/" → §5 collision detection → build → serialize
```

Rules run at the one place a name becomes a path, inside the pure build layer, before §5. That ordering is required rather than convenient: **rules create collisions**, and they must arrive at the existing detector as ordinary collisions rather than as a new failure mode. Stripping `xyz/` from one variable when an un-prefixed twin already exists is a `cross-set` or `same-set-case` collision like any other, resolved by Amendment 1 §F's comparator, every participant reported, nothing renamed and nothing silently dropped.

Two additions to the report, so a rule-induced collision explains itself:

- Each collision participant gains `sourceName`, alongside the existing variable id and contested path. Without it a report saying two variables collided at `base.color.bg.primary` is unreadable when neither is *named* that.
- New report kind **`path-rule`**, reason `invalid-result`: a rule pipeline that produces an empty path, an empty segment, or a leading/trailing separator. **The transform is not applied for that variable — the verbatim source name is used — and the entry records the rule id.** A mangled path is never written; §5's "no silent drop, no mangled name" rule applies to rules too.

### D. References are transformed by the same function, or the feature is broken

§2 resolves a `VARIABLE_ALIAS` to the target variable's dotted name. If paths are rewritten and reference strings are not, **every alias in the file dangles.** So the alias target's *source name* goes through the same pipeline: `{xyz.base.color.bg.primary}` is written as `{base.color.bg.primary}`.

This is the load-bearing consequence of the whole amendment, and it is what keeps §2's claim ("a reference survives a variable moving between collections") true — a reference now also survives a rule change, because both ends move together.

### E. The transform is one-way and is never inverted

`drop-matched-segments` is not injective; nothing recovers `xyz/base/…` from `base.…`. That is acceptable because **Tokenvault never needs to compute a Figma variable name from a token path**: apply writes by `figma.variableId` (ADR-0005), and pull matches by set + path against tokens that already have provenance (ADR-0006 §5).

One place is affected, and it is already deferred: ADR-0006 §11's `pull-unmatched` — creating a Figma Variable for a pulled token with no counterpart. Whoever builds that (PRD §9 Phase 11) **must ask for the Figma name rather than derive it from the path.** Recorded here so it is not rediscovered as a bug.

### F. Rules are committed: `tokens/$rules.json`

The rule set determines the shape of the committed tree. A second machine, or a teammate, that pulls without it computes different paths for the same variables and reads the entire tree as diverged. Phase 10 already carries one instance of exactly this bug (subtype confirmations not surviving a push/pull — PRD §9 item 10), so the precedent is established rather than hypothetical.

`tokens/$rules.json` therefore commits, alongside `$manifest.json`. It is **not** in the class of `$import-report.json`, which ADR-0006 §5 keeps local because it is per-scan machine state; a rule set is authored configuration that the tree cannot be reproduced without.

```jsonc
{ "generatedBy": "tokenvault", "pathRules": [ /* ordered, per §B */ ], "version": 1 }
```

Serialized by §7's rules, with `pathRules` order preserved. `clientStorage` holds the working copy under `tokenvault:rules:<file-id>` — a few KB, the same relationship the edit overlay has to the committed tree (ADR-0004 §2), and negligible against ADR-0004 §1's 5MB budget.

**A repo whose `$rules.json` differs from the local one blocks both push and pull for that repo, and says so** *(resolved 2026-09-04 — Shyam, as recommended)*. Pulling under a mismatched rule set would mis-match every token by path, and pushing under one would overwrite a tree built to different paths; both are the silently-wrong class this project refuses everywhere. It is resolved the way every other divergence is — ADR-0006 §6's pick-a-side, here over one file: take the repo's rules, or push yours over them.

Unlike a diverged token file, this blocks the **whole** repo rather than one file, because the rule set determines the path of every token in the tree; there is no subset of files it leaves trustworthy. Other connected repos are unaffected (ADR-0008 §4).

### G. A rule edit is a mass rename, and it is previewed rather than discovered

Editing a rule can move every matching token's path at once. Left alone this surfaces as ADR-0006 §4 marking most files locally changed and §8's diff view showing hundreds of deletes and adds — technically correct, unreadable, and the user learns what they did after committing it.

So: **a rule-set edit is never saved without a preview**, computed before the write:

```
PathRemap = { variableId, from, to }[]      // ids are stable across the change, §A
```

The preview reports how many tokens change path, how many references are rewritten (§D), and any new collisions or `path-rule` entries the change introduces. It can still be saved with collisions present — a second rule may be the fix, and §5 already reports rather than blocks — but it is never applied silently.

**Reusable by Phase 11's manual path rename.** A manual rename is one `PathRemap` entry; a rule edit is many. The reference-rewriting pass and the preview are the same code for both, and this is the reference-rewriting work PRD §9 item 11 names as manual rename's blocker. The one thing a manual rename needs that rules do not is somewhere to *store* the rename (an ADR-0004 overlay op), because a rule set is its own store.

### H. What this costs, and what it does not

- **`build()` gains a third input.** It was a pure function of (scan, `userSubtypes`); it becomes a pure function of (scan, `userSubtypes`, `pathRules`). ADR-0004's statement that a build is reproducible from the Figma file plus `userSubtypes` needs that one word added. §7's byte-identical guarantee is unchanged — same three inputs, same bytes.
- **Drift (ADR-0005 §7, ADR-0006 §7) is unaffected in mechanism and noisy on rule edits.** A re-pathed token reads as `drift-removed` plus `drift-added` against the old baseline. §G's preview is the mitigation; no drift-side change is made, because the drift comparator is correct and the confusion is entirely upstream of it.
- **Excluding variables is in scope** (§I), which closes this ADR's long-standing name-prefix-filtering deferral.
- **Authoring UI is `@ux-designer`'s.** This amendment fixes the rule shape, the ordering semantics, the storage location and the preview requirement. What the rules editor looks like, how a rule is tested against the live file, and how the preview is presented are not decided here.

### I. `exclude`: the deferred name-prefix filter, now built *(resolved 2026-09-04)*

Shyam's call, over this amendment's recommendation to defer it. An `exclude` action means the variable produces **no token**: nothing in any set file, nothing in the manifest, nothing pushed. It closes this ADR's original open question about the atlas pipeline's prefix filtering, which treated only `atlas/`-prefixed variables as real tokens and discarded `*`-prefixed tooling scaffolding — the case that made this deferral worth recording in the first place.

Excluding is a bigger act than re-pathing, so three guards, none of them new machinery:

- **Exclusions are reported in aggregate, not per variable.** §5's "no silent drop" rule applies, but a file that excludes 400 scaffolding variables must not produce 400 report entries — that is how a report stops being read. One entry per rule: kind `path-rule`, reason `excluded`, carrying `ruleId` and `count`. Attributable, countable, and one line.
- **A reference to an excluded variable dangles.** At *import* time Amendment 1 §G already covers it and is unchanged: the reference is still written, the token is still imported, and the report gains one new reason on the existing `dangling-reference` kind, `alias-target-excluded`. Import stays lossless and stays a report, not a refusal.
- **§G's preview counts exclusions before the rule is saved.** "This rule excludes 412 variables and leaves 6 references dangling" is the number that has to be visible *before* the write, because after it those variables are simply absent and the mistake is invisible.

Exclusion is a content decision — it changes what the tree contains — so it lives in the committed `$rules.json` like every other rule (§F).

**An exclusion that leaves a reference dangling blocks the push** *(resolved 2026-09-04 — Shyam, over this amendment's recommendation to warn instead)*. Symmetric with ADR-0008 §3's routing wall, and mechanically identical to it:

- Computed **before any network call**, from the local tree, and surfaced in the Review & push screen as a pre-push block — never a failure discovered after a repo has already committed.
- Reported as `dangling-reference` / `alias-target-excluded`, the same entry the import already files. The push gate reads that entry; it does not need its own detector.
- **It blocks every connected repo**, because unlike a routing dangle the breakage is in the local tree itself and is therefore identical in every projection. There is no repo for which the tree is intact.
- Caught earlier still in §G's rule preview, which is where the user should meet it.

The reasoning, since this overrides the recommendation: a dangling reference fails a Phase 8 export build outright, so warning-and-committing breaks CI in every repo at once — the exact outcome the routing wall exists to prevent, and no less bad for arriving by a different route.

**The gate is on rule-induced dangles only, and the boundary is deliberate.** A dangle caused by an exclusion (here) or by routing (ADR-0008 §3) is the direct result of a rule the user wrote, is visible in that rule's preview, and is fixed by editing it in the plugin. A dangle caused by Figma's own state — a collision loser, an unsupported type (Amendment 1 §G) — needs a rename in Figma, and blocking push on it would strand a user with an unfixable-from-here repo until they can get back into the file. Those keep §G's write-and-report treatment, unchanged.

### Open questions (Amendment 2)

**None.** All four questions were resolved by Shyam on 2026-09-04 and are folded into the sections above: **exclusion is in** (§I, overriding the recommendation to defer), **all four actions ship** (§B, overriding the recommendation to ship stripping alone), **rule-set mismatch blocks** (§F, as recommended), and **an exclusion dangle blocks the push** (§I, overriding the recommendation to warn).

The one judgement this amendment made on its own rather than asking, recorded because it is a boundary someone will test: the push gate covers **rule-induced** dangling references only, not the Figma-state ones Amendment 1 §G writes and reports. §I says why.

## Precedent checked

Validated against `~/Desktop/atlas/` (read-only), an older Tokens Studio–format pipeline over the same Figma-Variables source model:

- `tokenizer/projector/real-out/android/Theme/Light.json` — nested-by-path-segment tree with `{dot.path}` alias strings. This schema's structure matches; only `value`/`type` → `$value`/`$type` differs.
- `subzero-tokens-web/src/atlas-tokens/web/$metadata.json` and `$themes.json` — one file per collection/mode, `tokenSetOrder`, themes referencing `selectedTokenSets` plus `$figmaModeId`/`$figmaCollectionId`. Adopted: the set-id convention, `tokenSetOrder`, `selectedTokenSets`, and the `$figma*` back-reference naming.
- `tokenizer/projector/fixture.json` — raw `valuesByMode` / `VARIABLE_ALIAS` source shape, consistent with the import-side model assumed here.

Atlas's larger machinery (platform variants, multi-repo fan-out, program-token special-casing) is deliberately not replicated.

## References

- PRD §6.1, §6.2, §6.5.1, §9 Phase 2: `docs/prd.md`
- GitHub issue #2 (Phase 2 acceptance criteria)
- Clarification commits `e7098cf`, `eb32ea9` (opacity vs. duration/easing asymmetry — narrowed by Amendment 1 §A)
- `@figma/plugin-typings@1.137.0` — `VariableResolvedDataType`, `VariableValue`, `MotionEasing`, `VariableScope`
- Prior-art pipeline: `~/Desktop/atlas/` (local, read-only — see "Precedent checked")
- DTCG format spec (`$type`/`$value`/`$description`/`$extensions`, `{dot.path}` references)
