# UX: Local editor (Phase 4)

**Status:** Implemented — Phase 4 shipped 2026-09-02 (PR #8) and was validated live in Figma. All five of §10's questions are closed, and the build followed this doc without a design deviation worth recording. Still the live spec: amend it when the design changes.
**Owner:** `@ux-designer`
**Covers:** PRD §6.1 (token CRUD, minus create — deferred, see §2), §6.7 (plugin panel), build plan §9 Phase 4.
**Grounded in:** `src/tokens/types.ts`, ADR-0002 (rev 2), ADR-0003, ADR-0004 (local edit persistence), and the real import fixture in `test/fixtures/styles-import/`.

---

## 1. What we're designing against

Not a hypothetical token file. The Phase 3 fixture is a real capture of the Folio file, and it sets the constraints:

| Fact | Source | What it forces |
|---|---|---|
| **1,316 tokens** in one import | `$import-report.json` counts | A flat list is unusable. Grouping and search are load-bearing, not nice-to-have. |
| **11 sets** across 4 collections + 4 style kinds | `$manifest.json` | Sets overlap on path: `Theme/Light` and `Theme/Dark` hold the same 289 dotted paths with different values. A merged browser (§10.2) has to fold those into one row instead of listing them twice. |
| Panel is **460 × 640 px** | `src/code.ts` `figma.showUI` | No two-pane master/detail. One column, with the editor as an overlay. |
| Token paths are **6–7 segments deep** (`folio.ref.palette.transparent.red-warm.50.30`) | `theme/light.json` | Full paths don't fit on a row. The tree has to carry the prefix so the row only shows the leaf. |
| **132 unconfirmed subtypes**, **13 flagged**, **3 partial** | report counts | Import-quality state has to be visible *inside* the browser, not only on the post-scan report screen. |
| Many `$value`s are already references (`{folio.ref.palette.red-warm.50}`) | `theme/light.json` | Aliasing is Phase 7, but aliased *data* exists in Phase 4. The editor must render references honestly without pretending it can resolve or edit them. |
| Composite values carry 5–15 fields plus read-only provenance (`text` extras, `boundVariables`) | `styles/text.json` | Typography/shadow/grid can't be edited on a list row. |

**The shape of one token** (what every screen below is editing):

```jsonc
"Body Large": {
  "$type": "typography",
  "$value": { … },
  "$description": "optional",
  "$extensions": { "com.tokenvault": {
    "subtype": "spacing", "subtypeSource": "auto" | "user" | "default",
    "figma": { /* variableId+collectionId+modeId+scopes | styleId+styleKey+styleType+fontStyle+text+boundVariables */ }
  }}
}
```

The `figma` block is **provenance, not user content**. It's the re-import matching key (ADR-0002 §7 / ADR-0003 §2), so the editor never lets it be typed into and never drops it on edit.

---

## 2. Scope

### In scope (Phase 4)
Browse, search, edit, delete tokens in the imported tree, in-plugin, in one merged view spanning every set (§10.2).

### Explicitly out of scope — do not build these in Phase 4

| Not this phase | Where it lives | What that means for Phase 4 |
|---|---|---|
| **Creating a token by hand** | Its own future ticket, once Phase 5/6 exist | Nothing could consume a hand-authored token: it can't be applied to Figma until Phase 5 or committed until Phase 6. Every token in Phase 4 arrives from import, so every token has `figma` provenance. *(Shyam, 2026-09-01 — see §10.4.)* |
| Writing tokens back to Figma Variables/Styles | Phase 5 (§6.5.2) | Editing a token changes **nothing** on the canvas. The panel must say so, not imply live application. |
| Drift detection | Phase 5 (§6.5.3) | No "this diverged from Figma" state. Provenance is displayed, not diffed. |
| Git push/pull, commit, diff view | Phase 6 (§6.4) | No sync status pill in the header. The header's state slot holds the **Local edits · N** chip (§5.4) instead — which is the honest Phase 4 reading of the same slot, and the state Phase 6's pill will eventually absorb as "uncommitted". |
| Theme composition, aliasing UI, math expressions | Phase 7 (§6.2, §6.3) | Existing reference values are **displayed and preserved verbatim**, and are read-only in the value editor. No reference picker, no `{a} * 2` evaluation, no circular-reference checking. |
| Style Dictionary export | Phase 8 | The existing "Copy whole tree as JSON" stays the only way tokens leave the plugin — and, per ADR-0004, the only *durable* one: the edit overlay lives in `clientStorage`, which is per-device and clearable. |

The one place this line gets blurry is **references**. They are in the data today, so Phase 4 has to show them. The rule: *render the reference string, badge it, and refuse to edit it.* Anything beyond that is Phase 7.

---

## 3. Screen inventory

```
Import (existing, Phase 2/3)      Editor (new, Phase 4)
┌────────────────────────┐        ┌────────────────────────┐
│ Scan file              │        │ ⌕ search   [Sets ▾]   │  A. Browser
│ Summary counts         │───────▶│ ▸ folio               │  (one merged tree,
│ Subtype confirm        │        │   ▾ color             │   all sets at once)
│ Flagged report         │        │     ▸ border   12     │
│ Generated files        │        │       accent  L ■ D ■ │
└────────────────────────┘        └────────────────────────┘
                                            │ tap row
                                            ▼
                                  ┌────────────────────────┐
                                  │ ← accent.default    ⋯ │  B. Token detail / editor
                                  │ Theme/Light  [#C33A2E] │     (full-panel overlay)
                                  │ Theme/Dark   [#F0A19A] │     one section per set
                                  │ Source  Variable ⧉     │     holding this path
                                  └────────────────────────┘
```

Two top-level tabs in the header: **Import** and **Tokens**. Import is the existing screen unchanged. Tokens is everything below. Tabs, not a wizard step, because re-import is an ongoing workflow (§6.5.1), not a one-time bootstrap the user graduates from.

The Tokens tab is disabled with the copy *"Scan the file first"* until an import result exists — cached from a previous session (ADR-0004 §1) or freshly scanned. A persisted edit overlay on its own doesn't populate the tab: edits are a diff against an import, and there's nothing to show them against until the scan runs. See §8's empty states for how that reads without implying the edits were lost.

---

## 4. A. Browsing

**One merged tree across every set.** Shyam's call, §10.2 — there is no "current set" and no set-at-a-time mode. Everything below is built around that.

The problem the merge creates, and which the rest of §4 exists to solve: `Theme/Light` and `Theme/Dark` hold **the same 289 dotted paths**. A naive merge lists `folio.color.border.accent.default` twice, adjacent, differing only in a colour swatch — 289 times over. That reads as duplicate spam and it destroys scanning. So the merged tree is **keyed by dotted path, not by token**: one row per unique path, with each set that defines that path contributing a value line inside it.

### 4.1 Layout

```
┌──────────────────────────────────────────────┐
│ Folio design system            Import│Tokens │  header (existing)
├──────────────────────────────────────────────┤
│ [ ⌕ Filter tokens                        ]   │  search
│ [ All sets ▾ ][ All types ▾ ][ ⚑ 12 ][ ● 4 ] │  filter chips
├──────────────────────────────────────────────┤
│ ▾ folio                              412     │
│   ▾ color                            287     │
│     ▾ border                          12     │
│       ■ accent.default                       │  ← multi-set path
│           Light  {…red-warm.50}         ↗    │
│           Dark   {…red-warm-v…}         ↗    │
│       ■ accent.strong                        │
│           Light  #c33a2e                     │
│           Dark   #f0a19a                     │
│       ■ subtle        #c33a2e33      Light   │  ← single-set path
│     ▸ background                      64     │
│   ▸ spacing                           38  ⚑  │
└──────────────────────────────────────────────┘
```

### 4.2 The merged row — path first, sets inside it

Two row shapes, chosen per path by how many sets define it:

**Single-set path** (the majority — `Base`, the spacing/sizing collections, and all four style kinds are unique paths). One line, exactly the row that exists today: type glyph, leaf segment, value preview, state badge — plus a **muted set code** right-aligned. Same height, same density, no cost paid for the merge.

**Multi-set path.** A name line carrying the glyph and leaf segment, then one indented **value line per set**: set code, value preview, state badge. The path is stated once, the values sit stacked under it, and the visual connection between them is the indent — no repeated path text anywhere.

```
■ accent.default
    Light  {…red-warm.50}    ↗
    Dark   {…red-warm-v…}    ↗
```

Why stacked lines and not a Light | Dark column pair: there are **11 sets, not 2**. A column layout has to pick which sets get columns, breaks the moment a path appears in three, and at 460px a second value column leaves ~90px for the token name — which is the one thing the user is actually scanning. Stacking generalizes to any number of sets, costs width only for the set code, and degrades to today's row for the common single-set case.

Cost of the stack: multi-set paths are 2–3 lines tall, so **the tree is variable-height** and virtualization has to handle that (build note in §11). Rough arithmetic on the fixture: 1,316 tokens minus the 289 paths `Theme/Dark` duplicates from `Theme/Light` gives roughly **1,027 rows** — the real figure falls out of the merge, but the shape is "a thousand rows, most of them one line".

**Set codes.** Short labels derived from `manifest.tokenSetOrder`, dropping the collection prefix where the mode name is unambiguous and dropping `Mode 1` entirely: `Base`, `Light`, `Dark`, `Spacing`, `Sizing`, `Text`, `Effect`, `Grid`. Full set name on hover. Style-derived codes are styled as the derived things they are (ADR-0003 §1) — muted, italic — because the user never authored a set called "Text".

**When two sets disagree on `$type`** at the same path, the name line drops its shared glyph and each value line carries its own. No badge, no new report kind — it's a visual signal that these are not really the same token, not an error we have a vocabulary for.

**Ordering.** Value lines follow `manifest.tokenSetOrder`, always — so `Light` precedes `Dark` on every row in the tree, and the eye can rely on position instead of re-reading the code each time.

### 4.3 The set filter — what's left of the switcher

The switcher is gone as a navigation control; it comes back as a **filter chip**, `[ All sets ▾ ]`, opening the same grouped list it used to be, now multi-select with all sets on by default:

```
Variables                        ☑ all
  ☑ Base / Mode 1                    612
  ☑ Theme / Light                    289
  ☑ Theme / Dark                     289
  ☑ Spacing / Mode 1                  24
  ☑ Sizing / Mode 1                   18
Styles
  ☑ Text                              31
  ☑ Effect                            12
  ☑ Grid                               1
```

Deselecting a set removes its value lines; a path left with no lines drops out of the tree. Turning off everything but `Light` and `Dark` is the "compare the two themes" view, and turning off everything but one set reproduces the old single-set browse — as a filter the user reached for, not a mode they're stuck in. The chip reads `All sets` or `2 of 11 sets`, so a filtered tree can never be mistaken for the whole tree.

This is closer to Tokens Studio's multi-select checkbox column than the single-select we originally proposed, but it deliberately does **only** the "what am I looking at" half. Tokens Studio's checkboxes also pick what a theme composes from; Phase 4 has no theme composition (Phase 7), so this control never claims to.

Counts in the popover are **token counts per set** (they sum to 1,316), which is why they don't match the tree's row counts. Group rows in the tree count **paths**.

### 4.4 The tree

Nested disclosure rows following the DTCG group nesting exactly, since a node is a group iff it has no `$value` (`isToken` in `paths.ts`). Groups merge by name across sets, the same way paths do: `folio.color.border` is one group row even though four sets contribute tokens under it.

- **Group rows**: caret, segment name, descendant **path** count on the right. A `⚑` badge if any descendant has a report entry, in any set.
- **Token rows**: the two shapes in §4.2.
- Default expansion: top level expanded, everything below collapsed. At ~1,027 rows, opening fully expanded is a wall of text.
- Expansion state persists while the panel is open. It resets on rescan (the tree may not have the same shape).
- Long lists virtualize, with variable row heights.

### 4.5 Value previews on a line

| `$type` | Preview | Notes |
|---|---|---|
| `color` | 12px swatch (checkerboard behind, alpha is real — `#C33A2E33`) + hex, monospace | Reference values show the swatch as an outline, not a fill — we can't resolve it in Phase 4. |
| `number` | `16` + subtype tag (`spacing`, `radius`, …) | Subtype tag is muted; `default`-sourced ones get the existing `.badge.needs` amber treatment. |
| `boolean` | `true` / `false`, monospace | |
| `string` | truncated, quoted | |
| `typography` | `Urbanist 20/24 · 500` | Compressed from `$value`; enough to tell two styles apart. |
| `shadow` | `2 shadows` or `0 4 4 #00000040` for a single | `$value` is a single object *or* an array — the row copy must handle both. |
| `grid` | `columns · 4 · 8px` | |
| reference | `{folio.ref.palette.red-warm.50}` in monospace, muted, with a `↗` link glyph | The path is truncated **from the left** (`{…palette.red-warm.50}`) — the tail carries the meaning. |

### 4.6 Search and filter

- **Search** covers **everything in view** — there's no "current set" left to scope to, and no cross-set opt-in, because the merge already removed the reason we wanted one. The old worry was that searching `accent.default` would return a `Theme/Light` hit and a `Theme/Dark` hit that look like duplicates; under §4.2 that's one result row with two value lines, which is exactly what the user wanted to see.
- Matching is against the full dotted path and `$description`, case-insensitive, substring (not fuzzy — with paths this structured, fuzzy matching produces noise). While searching, the tree flattens to a result list showing full dotted paths, with matched substrings emphasised, each result keeping its value lines. Group headers disappear; hierarchy stops being the point once you've typed.
- Search runs **after** the set filter, so a filtered tree searches only what it's showing. When a query has hits in sets the filter is hiding, a secondary line says so rather than silently under-reporting: *"18 more in 3 hidden sets — show all sets"*.
- **Type filter**: a multi-select of the seven `TokenType`s present in the tree, each with a count.
- **Two state chips**, toggling filters rather than opening dialogs:
  - `⚑ 12 flagged` — tokens with a report entry at their path (`collision`, `partial-token`, `dangling-reference`, `redundant-style`, and after a rescan, `edit-conflict` / `orphaned-edit` — see §5.5). Flags land on the **value line**, not the path: a token can be flagged in `Dark` and clean in `Light`, and filtering to flagged keeps the path row but shows only its flagged lines.
  - `● 4 unconfirmed` — number/string tokens with `subtypeSource: "default"`. Deep-links back to the Import tab's confirm step rather than duplicating that control here; it already works and there's no reason to build a second one.

---

## 5. B. Editing a token value

### 5.1 Inline vs. overlay — the split

**Inline on the value line** for `color`, `number`, `boolean`, `string`: one value, one field. Click the value, it becomes an input in place; Enter or blur commits, Escape reverts. On a multi-set path each value line edits **its own set's token** — editing the `Dark` line never touches `Light`. This is the merged view's main payoff: retuning a colour in both themes is two clicks on two adjacent lines instead of two trips through a set switcher.

**Full-panel overlay** for `typography`, `shadow`, `grid`, and for *any* token where the user wants description, subtype, or provenance. Reached by clicking the path name (as opposed to a value), or via `⋯ → Edit`.

**A multi-set path opens one overlay covering all its sets** — the path as the title, then one section per set in `tokenSetOrder`, each with that set's value editor, description, subtype, and Source block. Opening a separate overlay per set would make the user back out and re-enter to compare `Light` against `Dark`, which is the thing the merged view was chosen to make easy. `⋯ → Edit` on an individual value line opens the same overlay scrolled to that set's section.

Tokens Studio puts everything in a modal. We diverge for scalars because the dominant Phase 4 task is "nudge a spacing value" and a modal round-trip for one number is three clicks too many in a 460px panel. We keep the overlay for composites because typography carries 5 editable fields plus 11 read-only `text` extras, which cannot be a row.

"Overlay", not "modal": it slides over the full panel, keeps the tree's scroll position, and has a back arrow. At 460×640 a centred modal with a dimmed backdrop wastes a third of the panel on chrome.

### 5.2 Per-type editors

| `$type` | Control | Validation |
|---|---|---|
| `color` | Hex text field (source of truth) + a native `<input type="color">` swatch. 8-digit hex accepted for alpha, since the importer emits it (`#00000040`). | Reject anything not `#RGB`/`#RRGGBB`/`#RRGGBBAA`. Normalize to lowercase 6- or 8-digit on commit, matching `rgbaToHex`. |
| `number` | Numeric field + the subtype dropdown (same options as the existing confirm step: 6 number subtypes, `untagged`, `auto-detect`). | Finite number required. Warn — don't block — when the value contradicts the subtype (`opacity: 4`, negative `radius`). The user may know something we don't. |
| `boolean` | Two-state segmented control. | None possible. |
| `string` | Single-line field; the `easing` subtype gets the same dropdown treatment. | Non-empty. |
| `typography` | fontFamily (text), fontSize (number + unit `px`), fontWeight (number 100–900 **or** free string — the type is `number \| string`), letterSpacing (number + `px`/`em`), lineHeight (number, `px`, or **absent**). | `lineHeight` needs an explicit "Auto" affordance that *removes the key*, since ADR-0003 §3 omits it entirely rather than writing a sentinel. |
| `shadow` | A repeatable list of shadow rows (offsetX, offsetY, blur, spread, color, inset). Add/remove/reorder. | Single-shadow values stay a bare object; only write an array when count > 1, matching what the importer emits. Don't silently promote a single shadow to a one-element array — it changes the bytes. |
| `grid` | A repeatable list of grid rows: pattern (`columns`/`rows`/`grid`), and only the fields valid for that pattern. | Absent keys stay absent (ADR-0003 §3). Switching pattern to `grid` removes `count`/`alignment` rather than zeroing them. |

**Read-only, always shown, never editable:**

- **Source** — `Variable · Theme/Light` or `Style · TEXT`, with the id available on hover/copy. Every Phase 4 token has one, since every token came from import; there is no provenance-less `Local` state until token creation ships (§2).
- **`boundVariables`** — for style-derived tokens, listed as `fontSize → {folio.typography.font-size.70}`. This is why a text style's numbers look "already aliased"; hiding it makes the value editor look broken.
- **`text` extras** — collapsed behind *"11 Figma text properties"*, expandable. They round-trip but have no DTCG home.

### 5.3 Editing a reference value

When `$value` is `{…}`, the value field is **disabled**, styled as a reference chip, with:

> Points at `folio.ref.palette.red-warm.50`. Editing references lands in Phase 7 — for now, change the token it points at.

A `Go to target` action jumps to that path if it exists in any set; if it doesn't, the chip shows the existing `dangling-reference` treatment instead. There is deliberately no "break the link and type a literal" escape hatch in Phase 4 — that's an aliasing decision, and it belongs to Phase 7.

### 5.4 Commit, revert, and where edits go

Edits apply to the tree immediately and are **persisted** — written to `clientStorage` as edit intent (target + op + value + base), keyed by `variableId + modeId` or `styleId`, per ADR-0004 §1–2. They survive closing the panel and reopening the file.

The header gains a **Local edits · 7** chip. Tapping it opens the **local-edits list**: one row per overlay entry, showing the path, its set, the imported value and the current one, with *Revert* per row and *Undo all* at the top. Edited tokens also get *Revert to imported value* directly in the row's `⋯` menu; the list exists because deletions have no row left to hang a menu off, and because "what have I actually changed?" is a question with 7 answers and no other place to ask it.

**"Local edits", not "unsaved changes".** `clientStorage` is per-device and unsynced: the edits are durable on this machine, invisible on another, and not committed anywhere. Calling them "unsaved" implies a Save button that doesn't exist until Phase 6; calling them "saved" implies they're somewhere safe, which they aren't. "Local" is the honest word for both facts at once. The word *saved* is reserved for Phase 6's git commit.

Because of that, the panel keeps offering **Copy whole tree as JSON** prominently — until Phase 6 it is the only durable exit, and clearing browser data destroys the overlay (ADR-0004 §Consequences).

If a write fails on quota, say so rather than losing it quietly:

> **Couldn't save your edits — plugin storage is full.** Your changes are still in this session. Copy the tree as JSON before closing the panel.

### 5.5 Rescan — merged, not destructive

**Rescan destroys nothing and does not ask permission.** It rebuilds the tree from Figma and three-way-merges the persisted overlay back over it (ADR-0004 §4): where Figma hasn't moved, the edit reapplies silently; where Figma caught up to the edit, the entry retires silently; where both moved, the local edit wins and is flagged; where the target is gone, the entry is retired and flagged.

No dialog before the scan. Afterwards, a **summary banner above the tree** (the existing `.entry` amber block, dismissible), only when the merge did something worth reading:

> **7 edits reapplied · 2 conflicts · 1 orphaned**  `[ Review ]`  `[ Dismiss ]`

- The silent-success case (all edits reapplied, nothing flagged) gets a plain toast instead — *"7 local edits reapplied."* — not a banner. Nothing needs attention, so nothing should hold screen space in a 640px panel.
- Zero edits in the overlay: no banner, no toast. The rescan is just a rescan.
- `[ Review ]` sets the `⚑ flagged` chip to the two new kinds, so the tree filters to exactly the rows that need a decision. Resolution happens in the tree, at leisure — there is no wizard and no per-token prompt during the scan.

**`edit-conflict`** — both your edit and Figma moved from the same base. The affected **value line** keeps its normal preview showing **your** value (local wins), plus a `⚑ conflict` badge; sibling lines on the same path are untouched. The overlay's section for that set shows both sides:

```
┌──────────────────────────────────────────────┐
│ ⚑ Conflict — both you and Figma changed this │
│   Your edit      ■ #c33a2e                   │
│   Now in Figma   ■ #b4342a                   │
│   Your edit is being used.                   │
│   [ Keep mine ]        [ Take Figma's ]      │
└──────────────────────────────────────────────┘
```

*Keep mine* clears the flag and rebases the overlay entry on the freshly imported value (so the same conflict doesn't re-report on every subsequent scan). *Take Figma's* drops the overlay entry entirely and the row reverts to the imported value. Both are one tap, both undoable from the toast. There is deliberately no global "keep mine / take theirs" — across 1,316 tokens the right answer differs per token (ADR-0004 §4).

**`orphaned-edit`** — the Variable or Style the edit targeted no longer exists in Figma. This is the same *"you're pointing at something that isn't there"* shape as `dangling-reference`, and reuses its treatment: `⚠` glyph, muted row, same badge palette. The row is rendered **outside the tree**, in a collapsed *"1 orphaned edit"* section pinned under the summary banner, because the token has no live path to sit at any more:

> `folio.color.border.accent.hover` (was Theme/Light)
> The Variable this edit changed was deleted in Figma. Your value: `#c33a2e`.
> `[ Copy value ]` `[ Discard edit ]`

Discarding is the only way to clear it — we can't reapply an edit to something that doesn't exist — so the copy hands the value back first rather than making the user retype it from a screenshot.

---

## 6. C. Creating a token — deferred

Cut from Phase 4 by Shyam on 2026-09-01. There's no consumer for a hand-authored token until Phase 5 can apply one to Figma or Phase 6 can commit one, so creation becomes its own ticket then. See §2's out-of-scope table and §10.4.

Nothing else in Phase 4 depends on it: every token in the tree arrives from import, with `figma` provenance attached. Section numbering below is unchanged so existing references still land.

---

## 7. D. Deleting a token

`⋯ → Delete` on a value line (deletes that set's token) or on the path name (deletes the path from every set it's in), or from the detail overlay.

**Delete is blocked while anything references the token.** Shyam's call, §10.3. Before offering the action, scan every set for `{<dotted.path>}` in any `$value` (including inside composite sub-values and `boundVariables`).

**No inbound references — delete proceeds:**

> Delete `folio.color.border.accent.hover`?
> `[ Cancel ] [ Delete ]`

A single tap-through, with an **Undo** in the toast for 10 seconds. No typed confirmation — this is a local, unsynced, single-user tree and a typing gate would be theatre.

**With inbound references — the action is disabled.** The `⋯` menu still lists *Delete*, greyed, with the count inline (`Delete — 7 references`); choosing it opens an explanation panel rather than a confirmation:

> **Can't delete `folio.ref.palette.red-warm.50` yet.**
> **7 tokens still reference it.** Deleting it would leave them pointing at nothing.
>
> `folio.color.border.accent.default` — Light, Dark
> `folio.color.border.accent.strong` — Light, Dark
> `folio.color.bg.surface` — Light, Dark
> `folio.color.text.danger` — Light
>
> Phase 4 can't edit a reference, so the only way to clear these is to delete the referencing tokens first — deepest first, since they may have references of their own. Repointing them lands with aliasing (Phase 7).
>
> `[ Close ]`

The referrer list is the whole point of the panel, so it is not truncated to "…and 5 more": each entry is a **tap target that navigates to that token** in the tree, with the sets it references from shown as set codes. A path referencing from both `Light` and `Dark` is one entry, matching §4.2 — the list is the merged tree's vocabulary, not a second one.

**Be honest that this can be a dead end.** There is deliberately **no** "remove all references" or "delete the whole dependency chain" button. Both are reference surgery, which Phase 4 cannot do — the first rewrites `$value`s, the second needs a resolved dependency graph to order the deletions safely, and neither has an overlay op in ADR-0004. So a token deep in the alias graph may simply be undeletable in Phase 4, and the panel says that in as many words rather than dangling an affordance that doesn't exist.

This lines up with rename (§10.5): both are blocked for the same reason — Phase 4 can't safely touch cross-references — and both open up in Phase 7 when references become editable. Blocking rather than warning also means the tree never contains a dangling reference the *user* created; the only `dangling-reference` entries are ones the import found, which keeps that badge meaning exactly one thing.

**Deleting a group**: allowed from a group row, and blocked by the same rule — the confirmation names the count (`Delete folio.color.border and its 12 tokens?`) and aggregates inbound references from **outside the group** across all of them. References *within* the group being deleted don't block, since they're going away together. If anything outside points in, the whole group delete is blocked and the explanation panel lists the external referrers. Undo restores the whole subtree. Mechanically this is one tombstone per descendant token, not a single group-level one (ADR-0004 §2), which has a user-visible consequence worth knowing: a token *added to that group in Figma later* comes back on the next scan rather than being swallowed by the old deletion.

**Style-derived and Variable-derived tokens delete like any other** — which, with creation deferred (§6), is every token in the tree. Nothing is removed from Figma (Phase 5), and the deletion persists as a tombstone in the overlay, so a rescan does **not** bring the token back. The confirmation says both halves:

> This removes it from the local token tree only. Nothing changes in Figma — the Variable is still there — and it stays removed here across rescans until you undo it.

Undo lives in the toast for 10 seconds; after that, the way back is *Undo all* on the header chip, or a per-token restore from the `⋯` menu on the deletion's entry in the local-edits list.

---

## 8. Empty and error states

### Empty states

| When | Copy |
|---|---|
| Tokens tab, nothing imported, no local edits | **No tokens yet.** Scan the file on the Import tab to read its Variables and Styles. `[ Go to Import ]` |
| Tokens tab, no cached import, **but the overlay has edits** (the cache was evicted or another file was opened — ADR-0004 §1) | **Scan the file to see your tokens.** Your 7 local edits are still here and will reapply after the scan. `[ Go to Import ]` — never let this read as "your edits are gone"; the overlay is durable and the import is the part that's re-derivable. |
| Scan produced zero tokens | **Nothing importable in this file.** No Variables or Styles mapped to a token — see the Import tab's report for what was skipped. |
| Set filter leaves nothing | **No tokens in the sets you've selected.** `[ Show all sets ]` |
| Search, no matches in the filtered sets | **No tokens match "shadw" in the 2 sets you've selected.** `[ Search all sets ]` |
| Search, no matches anywhere | **No tokens match "shadw".** Search covers token paths and descriptions. |
| Type/state filter empties the list | **No `boolean` tokens match your filters.** `[ Clear filters ]` |
| All flagged entries cleared | **Nothing flagged.** |

### Error and degraded states

| State | Treatment | Copy |
|---|---|---|
| Invalid value, inline edit | Field goes amber (`--warn`), message below the row, value **not** committed, edit stays open | `Not a hex colour. Use #RRGGBB or #RRGGBBAA.` |
| Value contradicts subtype | Amber note, value **is** committed | `Opacity is usually 0–1. Saved as 4.` |
| Dangling reference | Row badge, `↗` becomes `⚠` | `Points at folio.ref.palette.red-warm.50, which isn't in any set.` |
| Partial token (`partial-token`) | Muted badge `partial` on the row; overlay lists omitted keys | `Imported without lineHeight — Figma's value was Auto, which has no token equivalent.` |
| Collision loser | Not shown in the tree at all (it was never written). Discoverable only in the report. | — |
| Unconfirmed subtype | Existing `.badge.needs` amber on the subtype tag | `Guessed as spacing. Confirm it on the Import tab.` |
| Rescan with local edits | No dialog. Post-scan summary banner, `[ Review ]` filters the tree | see §5.5 |
| `edit-conflict` | `⚑ conflict` badge on the row; both values in the expanded row, local value shown as live | `Both you and Figma changed this. Your value is being used.` |
| `orphaned-edit` | `⚠`, in the pinned "orphaned edits" section, not the tree | `The Variable this edit changed was deleted in Figma.` |
| Overlay write failed (storage full) | `.entry` amber block, edit stays applied in-session | `Couldn't save your edits — plugin storage is full. Copy the tree as JSON before closing.` |
| Editing a reference | Disabled field + chip | see §5.3 |
| Delete blocked by inbound references | `⋯ → Delete` greyed with the count inline; explanation panel listing the referrers, no destructive button on it | `7 tokens still reference it. Phase 4 can't edit a reference — delete those tokens first.` see §7 |
| Two sets disagree on `$type` at one path | Per-line type glyphs, no shared glyph on the name line. No badge — not a report kind. | — |
| Tree too large to render | Never surfaced — virtualize instead | — |

**Circular references and math errors are not Phase 4 states.** PRD §6.3 puts them in Phase 7, and Phase 4 cannot create a cycle because it can neither author a token nor edit a reference. If one arrives in imported data, it renders as an ordinary reference chip. Don't build cycle detection here.

---

## 9. Visual language — continue what's there

`src/ui/index.html` already establishes the panel's vocabulary. Phase 4 extends it rather than restyling:

- 11px Inter body, monospace for anything path- or value-shaped (`.row .name` already does this).
- `--border #e6e6e6`, `--muted #8c8c8c`, `--accent #0d99ff`, `--warn #b8730a` / `--warn-bg #fff6e5`.
- `.row` (flex, 1px bottom border, ellipsised monospace name, trailing control) is exactly the token row. Reuse it.
- `.badge` / `.badge.needs` already encode "state, neutral" vs "state, needs you". The subtype tags, `partial`, and flagged all map onto these two; `conflict` and `orphaned` are `.badge.needs`. **Don't introduce a third badge colour** — a conflict is not a more urgent kind of amber, it's the same "needs you" the report already speaks.
- `.entry` (amber left border) is the error/flag block. Reuse for validation messages and for §5.5's post-scan summary banner.
- The existing toast is the undo surface, and the surface for the silent-success rescan summary.
- The header's right slot holds the **Local edits · N** chip in Phase 4, and is where Phase 6's sync pill lands. Same slot, same role — "what state is my work in" — so the chip isn't a placeholder that gets evicted; it's the first occupant of a permanent one.

Three things Phase 4 has to add: a **disclosure/caret row** for groups, a **colour swatch** with a checkerboard alpha backing, and the merged view's **value line** — an indented, slightly shorter variant of `.row` with no bottom border, so a path's stacked lines read as one block rather than three list items. The set code on it is a `.badge`-weight muted label, not a new colour: which set a value came from is neutral information, never a state that needs you.

---

## 10. Questions — all closed

1. ~~**Does the edited tree persist between plugin sessions** (`clientStorage`), or is it session-only until Phase 6's git sync gives it a real home? Changes §5.4's warning and whether "unsaved" is even the right word. *(Also a tech-lead question — flagging, not deciding.)*~~
   **Resolved 2026-09-01 — Shyam: persist to clientStorage; mechanics in ADR-0004.** Edits are stored as intent, keyed by Figma provenance id, and three-way-merged on rescan. Consequences already folded in above: §5.4's blocking rescan dialog is gone (replaced by §5.5's post-scan summary), the header chip reads **local edits** rather than "unsaved changes", deletion is a persistent tombstone (§7), and two new report kinds — `edit-conflict` and `orphaned-edit` — are designed in §5.5 and §8.
2. ~~**Single-set browsing vs. a merged view.** §4.2 argues for one set at a time. If you routinely need to compare `Theme/Light` against `Theme/Dark` side by side, that's a different screen and worth knowing now.~~
   **Resolved 2026-09-01 — Shyam: merged view across all sets (reverses this doc's original single-set recommendation).** §4 is rebuilt around it: the tree is keyed by **dotted path**, not by token, so the 289 paths `Theme/Light` and `Theme/Dark` share appear once with a stacked value line per set (§4.2) instead of twice. The set switcher survives only as a multi-select **filter chip** (§4.3) — deselecting down to one set reproduces the old browse as a filter, not a mode. Search now covers everything with no cross-set opt-in (§4.6), the detail overlay covers all of a path's sets in one screen (§5.1), and flags/conflicts attach to the value line rather than the path (§4.6, §5.5).
3. ~~**Should delete be blocked outright when references exist**, rather than warning and allowing? §7 allows it because the report already models `dangling-reference`, but that's a taste call about how much the tool should protect you from yourself.~~
   **Resolved 2026-09-01 — Shyam: block outright until unreferenced.** §7 disables the delete action while inbound references exist and shows an explanation panel listing the referrers; there is no "delete anyway" and no one-click reference cleanup, because clearing references means editing them and Phase 4 can't. Same reason rename is deferred to Phase 7 (§10.5): Phase 4 has no safe way to touch cross-references, so the honest move is to block rather than to let the user manufacture dangling references — which also keeps that badge meaning only "the import found this".
4. ~~**Are hand-created (`Local`) tokens actually wanted in Phase 4**, given nothing can be applied to Figma until Phase 5 and nothing can be committed until Phase 6? The PRD asks for create; it may in practice be dead weight for two phases. Worth confirming before it's built.~~
   **Resolved 2026-09-01 — Shyam: defer.** Creation is out of Phase 4 (§2). Phase 4 is browse/edit/delete over imported tokens only. Creation returns as its own ticket once Phase 5 or 6 gives a hand-made token somewhere to go. §6 is kept as a stub pointer.
5. ~~**Renaming a token's path** isn't specified above. It's mechanically a delete + create with the same reference consequences, but it also breaks every inbound reference at once. Is rename in Phase 4, or does it wait for Phase 7 where references can be rewritten? *(Sharper now that create is deferred: rename would be the only way to get a token onto a path Figma didn't produce, so shipping it would partly reopen the door §2 just closed.)*~~
   **Resolved 2026-09-01 — Shyam: defer to Phase 7**, where inbound references can be rewritten as part of the rename instead of being left dangling. Rename is out of Phase 4; §2's out-of-scope boundary covers it. Note for whoever revisits this: ADR-0004 defines overlay ops for `set-value`, `set-description`, and `delete` only — **there is no rename op** (ADR-0004 §Open questions). Pulling rename earlier than Phase 7 requires amending ADR-0004 first, not just a UX spec.

---

## 11. Build notes for `@frontend-engineer`

- Don't call Figma. Nothing in this doc reads or writes the canvas.
- **The browser's view model is a path-keyed merge, not a set's tree.** Build one index from `normalizePathKey`'d dotted path → list of `{ setId, token }` in `tokenSetOrder`, and render from that. Don't render per-set trees and reconcile them in the UI.
- Virtualization must handle **variable row heights** — a path with three contributing sets is a taller row than a path with one (§4.2).
- Edits, deletes and flags are keyed to `{ path, setId }`, never to path alone — the merged row is a display construct, and ADR-0004's overlay entries stay keyed by `variableId + modeId` / `styleId` exactly as specified.
- Inbound-reference lookup is needed for delete-blocking (§7) and wants to be an index built once per import, not a scan per delete: `{referenced.path}` → list of `{ path, setId }` referrers, walking composite sub-values and `boundVariables`.
- **Persistence follows ADR-0004, not this doc.** Two `clientStorage` keys, edit-intent entries keyed by `variableId + modeId` / `styleId`, the merge table in §4, and the `edit-conflict` / `orphaned-edit` report kinds are all pinned there. This doc specifies only how those states read.
- Subtype changes keep writing `userSubtypes` (ADR-0004 §3) — the subtype dropdown is *not* an overlay op, so it doesn't count toward the **Local edits · N** chip.
- Preserve `$extensions."com.tokenvault"` byte-for-byte on every edit path. ADR-0002 §7's byte-identical re-import guarantee is the thing most easily broken by an editor that round-trips through a form.
- Serialize through `stableStringify` / `compareKeys` so the copied tree still matches the fixture ordering.
- Reuse `paths.ts` (`setTokenAtPath`, `isToken`, `normalizePathKey`) for validation instead of re-implementing path rules in the UI.
- The subtype dropdown options come from `NUMBER_SUBTYPES` / `STRING_SUBTYPES` in `src/tokens/subtype.ts` — one source, not a second copy in the editor.
- Section 2's out-of-scope table is the scope boundary. If a task starts needing reference resolution, mode composition, or a Figma write, stop and raise it.
