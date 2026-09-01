# UX: Local editor (Phase 4)

**Status:** Provisional — a starting design, to be revised once it's used live in Figma.
**Owner:** `@ux-designer`
**Covers:** PRD §6.1 (token CRUD, minus create — deferred, see §2), §6.7 (plugin panel), build plan §9 Phase 4.
**Grounded in:** `src/tokens/types.ts`, ADR-0002 (rev 2), ADR-0003, ADR-0004 (local edit persistence), and the real import fixture in `test/fixtures/styles-import/`.

---

## 1. What we're designing against

Not a hypothetical token file. The Phase 3 fixture is a real capture of the Folio file, and it sets the constraints:

| Fact | Source | What it forces |
|---|---|---|
| **1,316 tokens** in one import | `$import-report.json` counts | A flat list is unusable. Grouping and search are load-bearing, not nice-to-have. |
| **11 sets** across 4 collections + 4 style kinds | `$manifest.json` | The set is the primary navigation axis, above the group tree. |
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
Browse, search, edit, delete tokens in the imported tree, across sets and groups, in-plugin.

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
│ Scan file              │        │ Set ▾   ⌕ search      │  A. Browser
│ Summary counts         │───────▶│ ▸ folio               │
│ Subtype confirm        │        │   ▾ color             │
│ Flagged report         │        │     ▸ border   12     │
│ Generated files        │        │       accent   #C3…   │
└────────────────────────┘        └────────────────────────┘
                                            │ tap row
                                            ▼
                                  ┌────────────────────────┐
                                  │ ← accent.default    ⋯ │  B. Token detail / editor
                                  │ $type  color           │     (full-panel overlay)
                                  │ $value [#C33A2E]       │
                                  │ Source  Variable ⧉     │
                                  └────────────────────────┘
```

Two top-level tabs in the header: **Import** and **Tokens**. Import is the existing screen unchanged. Tokens is everything below. Tabs, not a wizard step, because re-import is an ongoing workflow (§6.5.1), not a one-time bootstrap the user graduates from.

The Tokens tab is disabled with the copy *"Scan the file first"* until an import result exists — cached from a previous session (ADR-0004 §1) or freshly scanned. A persisted edit overlay on its own doesn't populate the tab: edits are a diff against an import, and there's nothing to show them against until the scan runs. See §8's empty states for how that reads without implying the edits were lost.

---

## 4. A. Browsing

### 4.1 Layout

```
┌──────────────────────────────────────────────┐
│ Folio design system            Import│Tokens │  header (existing)
├──────────────────────────────────────────────┤
│ [ Theme / Light          ▾ ]                 │  set switcher
│ [ ⌕ Filter tokens                        ]   │  search
│ [ All types ▾ ] [ ⚑ 12 ] [ ● 4 unconfirmed ] │  filter chips
├──────────────────────────────────────────────┤
│ ▾ folio                              412     │
│   ▾ color                            287     │
│     ▾ border                          12     │
│       ■ accent.default   {…red-warm.50}  ↗  │
│       ■ accent.strong    {…red-warm-v…}  ↗  │
│       ■ subtle           #C33A2E33          │
│     ▸ background                      64     │
│   ▸ spacing                           38  ⚑  │
└──────────────────────────────────────────────┘
```

### 4.2 Set switcher — the primary axis

A single-select dropdown in the header, listing sets in `manifest.tokenSetOrder`, grouped by origin:

```
Variables
  Base / Mode 1                      612
  Theme / Light                      289
  Theme / Dark                       289
  Spacing / Mode 1                    24
  Sizing / Mode 1                     18
Styles
  Text                                31
  Effect                              12
  Grid                                 1
```

Single-select, not Tokens Studio's multi-select checkbox column. Tokens Studio's checkboxes do double duty — they pick what you're *looking at* and what a theme *composes from*. Phase 4 has no theme composition (Phase 7), so overloading them now would ship half a control that means the wrong thing. One set at a time, chosen deliberately, is also the honest model for the data: `Theme/Light` and `Theme/Dark` hold the same 289 paths with different values, and merging them into one list is a lie about the token count.

Style sets are labelled by kind and shown under a **Styles** heading because they're synthetic and mode-free (ADR-0003 §1) — the user never created a set called "Text", so it needs to read as derived, not authored.

### 4.3 The tree

Nested disclosure rows following the DTCG group nesting exactly, since a node is a group iff it has no `$value` (`isToken` in `paths.ts`).

- **Group rows**: caret, segment name, descendant token count on the right. A `⚑` badge if any descendant has a report entry.
- **Token rows**: type swatch/glyph, **leaf segment only**, value preview, a right-aligned state badge.
- Default expansion: top level expanded, everything below collapsed. At 1,316 tokens, opening fully expanded is a wall of text.
- Expansion state persists while the panel is open. It resets on rescan (the tree may not have the same shape).
- Long lists virtualize. 612 rows in one set is normal here.

### 4.4 Value previews on a row

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

### 4.5 Search and filter

- **Search** matches the full dotted path and `$description`, case-insensitive, substring (not fuzzy — with paths this structured, fuzzy matching produces noise). While searching, the tree flattens to a result list showing full dotted paths, with matched substrings emphasised. Group headers disappear; hierarchy stops being the point once you've typed.
- **Type filter**: a multi-select of the seven `TokenType`s present in the current set, each with a count.
- **Two state chips**, toggling filters rather than opening dialogs:
  - `⚑ 12 flagged` — tokens with a report entry at their path (`collision`, `partial-token`, `dangling-reference`, `redundant-style`, and after a rescan, `edit-conflict` / `orphaned-edit` — see §5.5).
  - `● 4 unconfirmed` — number/string tokens with `subtypeSource: "default"`. Deep-links back to the Import tab's confirm step rather than duplicating that control here; it already works and there's no reason to build a second one.
- Search scope defaults to the current set. A secondary line appears when there are matches elsewhere: *"18 more in other sets — search all sets"*. Cross-set search is opt-in because a path like `folio.color.border.accent.default` legitimately exists in both `Theme/Light` and `Theme/Dark`, and showing both by default makes every result look duplicated.

---

## 5. B. Editing a token value

### 5.1 Inline vs. overlay — the split

**Inline on the row** for `color`, `number`, `boolean`, `string`: one value, one field. Click the value, it becomes an input in place; Enter or blur commits, Escape reverts.

**Full-panel overlay** for `typography`, `shadow`, `grid`, and for *any* token where the user wants description, subtype, or provenance. Reached by clicking the row's name (as opposed to its value), or via `⋯ → Edit`.

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

**`edit-conflict`** — both your edit and Figma moved from the same base. The row keeps its normal value preview showing **your** value (local wins), plus a `⚑ conflict` badge. The overlay/expanded row shows both sides:

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

`⋯ → Delete` on a row, or from the detail overlay.

**Confirmation is one step, and its content depends on inbound references.** Before showing it, scan every set for `{<dotted.path>}` in any `$value` (including inside composite sub-values and `boundVariables`).

**No inbound references:**

> Delete `folio.color.border.accent.hover`?
> `[ Cancel ] [ Delete ]`

A single tap-through, with an **Undo** in the toast for 10 seconds. No typed confirmation — this is a local, unsynced, single-user tree and a typing gate would be theatre.

**With inbound references:**

> **Delete `folio.ref.palette.red-warm.50`?**
> **7 tokens reference it** and would be left pointing at nothing:
> `folio.color.border.accent.default` (Theme/Light)
> `folio.color.border.accent.default` (Theme/Dark)
> …and 5 more
> `[ Cancel ] [ Delete anyway ]`

Deleting anyway is allowed, and the dependents get the existing `dangling-reference` badge — the same vocabulary the import report already uses (`ReportEntryKind`), so the user learns one concept, not two. There's no "rewrite the 7 references" option; that's aliasing surgery and belongs to Phase 7.

**Deleting a group**: allowed from a group row, confirmation names the count (`Delete folio.color.border and its 12 tokens?`) and aggregates inbound references across all of them. Undo restores the whole subtree. Mechanically this is one tombstone per descendant token, not a single group-level one (ADR-0004 §2), which has a user-visible consequence worth knowing: a token *added to that group in Figma later* comes back on the next scan rather than being swallowed by the old deletion.

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
| Set has no tokens | **This set is empty.** Every token in it was dropped as a collision — see the report. `[ Go to Import ]` |
| Search, no matches in set | **No tokens match "shadw" in Theme/Light.** `[ Search all sets ]` |
| Search, no matches anywhere | **No tokens match "shadw".** Search covers token paths and descriptions. |
| Type/state filter empties the list | **No `boolean` tokens in this set.** `[ Clear filters ]` |
| All flagged entries cleared | **Nothing flagged in this set.** |

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

Two things Phase 4 has to add: a **disclosure/caret row** for groups, and a **colour swatch** with a checkerboard alpha backing.

---

## 10. Open questions for Shyam

1. ~~**Does the edited tree persist between plugin sessions** (`clientStorage`), or is it session-only until Phase 6's git sync gives it a real home? Changes §5.4's warning and whether "unsaved" is even the right word. *(Also a tech-lead question — flagging, not deciding.)*~~
   **Resolved 2026-09-01 — Shyam: persist to clientStorage; mechanics in ADR-0004.** Edits are stored as intent, keyed by Figma provenance id, and three-way-merged on rescan. Consequences already folded in above: §5.4's blocking rescan dialog is gone (replaced by §5.5's post-scan summary), the header chip reads **local edits** rather than "unsaved changes", deletion is a persistent tombstone (§7), and two new report kinds — `edit-conflict` and `orphaned-edit` — are designed in §5.5 and §8.
2. **Single-set browsing vs. a merged view.** §4.2 argues for one set at a time. If you routinely need to compare `Theme/Light` against `Theme/Dark` side by side, that's a different screen and worth knowing now.
3. **Should delete be blocked outright when references exist**, rather than warning and allowing? §7 allows it because the report already models `dangling-reference`, but that's a taste call about how much the tool should protect you from yourself.
4. ~~**Are hand-created (`Local`) tokens actually wanted in Phase 4**, given nothing can be applied to Figma until Phase 5 and nothing can be committed until Phase 6? The PRD asks for create; it may in practice be dead weight for two phases. Worth confirming before it's built.~~
   **Resolved 2026-09-01 — Shyam: defer.** Creation is out of Phase 4 (§2). Phase 4 is browse/edit/delete over imported tokens only. Creation returns as its own ticket once Phase 5 or 6 gives a hand-made token somewhere to go. §6 is kept as a stub pointer.
5. ~~**Renaming a token's path** isn't specified above. It's mechanically a delete + create with the same reference consequences, but it also breaks every inbound reference at once. Is rename in Phase 4, or does it wait for Phase 7 where references can be rewritten? *(Sharper now that create is deferred: rename would be the only way to get a token onto a path Figma didn't produce, so shipping it would partly reopen the door §2 just closed.)*~~
   **Resolved 2026-09-01 — Shyam: defer to Phase 7**, where inbound references can be rewritten as part of the rename instead of being left dangling. Rename is out of Phase 4; §2's out-of-scope boundary covers it. Note for whoever revisits this: ADR-0004 defines overlay ops for `set-value`, `set-description`, and `delete` only — **there is no rename op** (ADR-0004 §Open questions). Pulling rename earlier than Phase 7 requires amending ADR-0004 first, not just a UX spec.

---

## 11. Build notes for `@frontend-engineer`

- Don't call Figma. Nothing in this doc reads or writes the canvas.
- **Persistence follows ADR-0004, not this doc.** Two `clientStorage` keys, edit-intent entries keyed by `variableId + modeId` / `styleId`, the merge table in §4, and the `edit-conflict` / `orphaned-edit` report kinds are all pinned there. This doc specifies only how those states read.
- Subtype changes keep writing `userSubtypes` (ADR-0004 §3) — the subtype dropdown is *not* an overlay op, so it doesn't count toward the **Local edits · N** chip.
- Preserve `$extensions."com.tokenvault"` byte-for-byte on every edit path. ADR-0002 §7's byte-identical re-import guarantee is the thing most easily broken by an editor that round-trips through a form.
- Serialize through `stableStringify` / `compareKeys` so the copied tree still matches the fixture ordering.
- Reuse `paths.ts` (`setTokenAtPath`, `isToken`, `normalizePathKey`) for validation instead of re-implementing path rules in the UI.
- The subtype dropdown options come from `NUMBER_SUBTYPES` / `STRING_SUBTYPES` in `src/tokens/subtype.ts` — one source, not a second copy in the editor.
- Section 2's out-of-scope table is the scope boundary. If a task starts needing reference resolution, mode composition, or a Figma write, stop and raise it.
