# UX: The token card — restyling the edit view (Phase 10)

**Status: Settled 2026-09-07.** §10.1 and §10.3 — the two questions that shape the build — answered by
Shyam: display-only name (no rename), stacked labels everywhere. §10.2, §10.4 and §10.5 stand as
recommended, unchallenged. Implementation-ready for `@frontend-engineer`. Everything here is layout,
ordering and label copy over the fields that already ship — **no new schema, no new capability, no
new visual vocabulary.**
**Owner:** `@ux-designer`
**Covers:** the token detail overlay (`src/ui/detail.ts`, `#panel`). PRD §6.1, §6.7.
**Builds on:** `local-editor.md` (P4) §5.1, §5.2, §5.4, §9; `references-math-themes.md` (P7) §4, §6.2,
§7.2, §14; `panel-size-and-swatches.md` (P10) §3.4, §4; `dark-mode.md` (P10) §4, §6.3. Read those
first — this doc extends them and restates none of them.
**Reference:** Tokens Studio's own token edit panel, from a screenshot Shyam shared. Treated as the
baseline for *structure*, not as a feature list — three of its seven sections describe things
Tokenvault does not have, and those are dropped rather than stubbed (§2).
**Amends:** `local-editor.md` §5.1, §5.2 and §9 — stated in §9, to be applied when the build lands.

---

## 1. What we're designing against

| Fact | Source | What it forces |
|---|---|---|
| **The overlay is already a full-panel card with the path as its title.** `.panel-head` holds `←`, the full dotted path in monospace, and `Copy path`. | `src/ui/detail.ts:188-198`; `#panel .panel-head .title` | The reference's item 1 — *the full path in bold mono, unlabelled, as the token's identity* — **already ships**. It is the one part of the reference we got right first time and it does not change. |
| **There is no draft state.** Every field commits on Enter or blur straight into the `clientStorage` overlay; there is no pending buffer and no rename op. | `committingInput`; ADR-0004 §2 (`set-value` / `set-description` / `delete`, and nothing else) | The reference's Cancel/Save footer has no honest analogue. §7 is what goes there instead, and §10.2 is the question. |
| **Fields sit in an 84px left label gutter**, with `.field-note` and `.resolve-line` hanging off a matching 90px margin. | `.field`, `.field > label`, `.field-note` | At the 400px floor that leaves ~200px for a value that may be a seven-segment dotted path. §4.1 reclaims it. |
| **Provenance is one muted blob at the bottom of every set section** — Source, ids, Scopes, bound Variables, `text` extras, plus §14.7's disagreement line. | `renderProvenance`; `.provenance` | The reference's collapsible **Figma** section is the right container for exactly this material, and it is the single biggest structural borrowing in the doc (§6). |
| **`scopes` are read every import and never edited** — rendered as `Scopes  ALL_FILLS, STROKE_COLOR`. | `src/tokens/types.ts`; `src/figma/scan.ts`; `detail.ts:1363-1364` | Confirmed read-only. The reference's checkbox tree is **not** built; §6.3 restyles the display and nothing else. |
| **Composite member labels render as raw schema keys** — `fontFamily`, `offsetX`, `sectionSize`. | `typographyEditor`, `shadowEditor`, `gridEditor` | The reference uses human labels. These are display strings, not JSON keys, so §5.5 humanises them — with one deliberate exception (§4.4). |
| **Row-level swatches are a 16px circle with a faint ring, produced by one shared function.** `swatchMark()` answers both the row chip and the group strip. | `src/ui/swatch.ts`; `local-editor.md` §4.5 (amended 2026-09-07); `dark-mode.md` §6.3 | §4.3's value-field swatch is that same call and those same classes. A third swatch treatment would be a third vocabulary in a panel whose argument is that it has one of everything. |
| **The panel floor is 400px and reachable.** | `panel-size-and-swatches.md` §3.2, §3.4 | Every layout below is drawn at 400. Extra width goes to the value's truncation budget first, exactly as §3.4 says. Nothing new appears at width. |
| **The standing body paragraph is stale.** *"…nothing is committed anywhere until git sync lands in Phase 6."* | `detail.ts:204-210` | Phase 6 landed 2026-09-03. §7.2 replaces it. |

Constraints carried forward, all still hard: **no third badge colour**; `⚑` is the only attention
glyph; `--danger` is a button colour and never a state (`dark-mode.md` §4); **one value field, no
mode toggle** (`references-math-themes.md` §4.1).

---

## 2. Scope

### In scope

The overlay's internal layout (§3), the field pattern (§4), the seven per-type cards (§5), the Figma
section (§6), the footer (§7), and the label/empty-state copy those need (§8).

### Explicitly out of scope

| Not this | Why / where it lives |
|---|---|
| **The reference's "Modify" section and its PRO badge** | No Tokenvault equivalent exists or is planned. Skipped entirely — not stubbed, not greyed, not mentioned in the UI. |
| **Variable scopes as editable checkboxes** | Shyam's confirmed call. `scopes` stay read-only display and are never written back to Figma. §6.3. |
| **Code syntax, "Hidden from publishing"** | Neither is in the schema and neither is being added. There is no place designed for them. |
| **Renaming a token / an editable Name field** | ADR-0004 defines no rename op (`local-editor.md` §10.5). §10.1 is the question; the recommendation is display-only. |
| **Any change to the path picker, the four rules, the resolve line, or the cycle block** | `references-math-themes.md` §4, §5, §6.2, §7.2 own those. This doc places them; it does not touch them. |
| **Removing inline editing from the tree** | §3.3 keeps it, and says why. |
| **A second pane, a right-hand sidebar, or a centred modal** | §3.1. |
| **Token creation** | Still deferred (`local-editor.md` §2, §6). The card is a card for a token that exists. |

---

## 3. A. What kind of surface this is

### 3.1 It stays the full-panel overlay. The card is its *internals*.

Tokens Studio's edit panel is a right-hand pane in a full-window app, with the token list still
visible beside it. Tokenvault has one column between 400px and whatever the display allows, and
`panel-size-and-swatches.md` §3.4 settled that there is exactly one layout at every width. So:

- **Not a second pane.** There is no width at which one appears (§3.4 is a hard constraint, not a
  preference).
- **Not a centred modal with a scrim.** `local-editor.md` §5.1 refused that at 460px because chrome
  ate a third of the panel; the floor is now **400**, so the argument got stronger, not weaker.
- **The existing overlay, unchanged in behaviour**: slides over the tree, keeps the tree's scroll
  position, exits by `←`. What changes is everything inside `.panel-body`.

This is the honest reading of the ask. The reference's card-ness is a *layout* — a titled surface
with labelled fields in a fixed order and a collapsible technical section at the bottom. All of that
is portable to a 400px overlay. Its chrome is not.

### 3.2 One card for a single-set path, one card per set for a multi-set path

The reference is a card for one token. Roughly two-thirds of Tokenvault's paths are single-set
(`local-editor.md` §4.2), and for those the current `.set-section` box is pure redundancy: a border, 8px
of padding on each side, and an `h3` restating a set the head already implies.

| Path | Chrome |
|---|---|
| **Single set** | **No `.set-section` box and no `h3`.** The fields sit directly in `.panel-body`. The set code and the `edited` / flag badges move to one thin meta line under the title in `.panel-head`. The `$type` moves to the value field's label (§4.2). |
| **Multiple sets** | One bordered `.set-section` per set, in `tokenSetOrder`, exactly as today — each one internally laid out per §4–§6. The `h3` keeps the set code and badges, because with three sections on screen the set is the thing you're locating. |

That recovers ~26px of width and one row of height for the common case, at the cost of the card
looking slightly different in the two-theme case. Worth it: the difference is *there are two of
these*, which is true and which the user needs to see.

`local-editor.md` §5.1's rule that a multi-set path opens **one** overlay covering all its sets is
unchanged, and so is `⋯ → Edit` scrolling to a section.

### 3.3 Inline editing in the tree survives

**Keep it, unchanged, for `color`, `number`, `boolean` and `string`.** `local-editor.md` §5.1's
argument was never about how the overlay looked — it was that the dominant edit is *nudge a spacing
value*, and a round trip for one number is three clicks too many. Restyling the card does not make
that round trip cheaper, and the merged tree's payoff (retune Light and Dark on two adjacent lines)
lives entirely in the inline path.

So the card is the surface for composites, for description, for subtype, for provenance, and for
anyone who wants the whole picture — the same split as today. The reference has no tree with inline
editing, so there is nothing to diverge from here.

---

## 4. B. The field pattern

### 4.1 Labels above their fields, not beside them

The reference stacks every label over its input. Adopt it, and delete the 84px gutter.

- **What it buys:** ~90px of width on every value, every resolve line, every dotted path, at every
  panel size. `panel-size-and-swatches.md` §3.1 named the value line's truncation budget as the first
  thing losing information and §3.4 said extra width should go there first — this is the same win
  without needing a bigger window.
- **What it costs:** ~14px of height per field. A typography card gains ~70px. Height is the cheap
  axis: the panel now opens 720 tall and the card scrolls.
- **`.field-note` and `.resolve-line` lose their 90px left margin** and align to the field's own left
  edge, which is also where the eye already is.
- Labels are 10px, `--muted`, sentence case, 4px above the control. **Not** uppercase: the panel's one
  uppercase treatment is the path picker's group label (`.popover .group-label`), where it separates
  three groups of results, and borrowing it for 15 field labels in a row would spend a distinction
  that currently means something.

### 4.2 The value field's label is the token's type

The reference labels its value field `Color`. Do the same, for scalars: **`Color`, `Number`,
`Boolean`, `String`** — the `$type`, sentence-cased. Two consequences worth stating:

- The `.badge` carrying `$type` in the `h3` becomes redundant for a single-set card and is dropped
  there. A multi-set card keeps it in the `h3`, because that line is also where two sets disagreeing
  on `$type` shows up (`local-editor.md` §4.2).
- `colorEditor`'s current `Hex` label goes. The hex expectation is carried where it matters — the
  refusal copy on a bad commit (*"Not a hex colour. Use #RRGGBB or #RRGGBBAA."*), at the moment the
  user is looking at the problem, which is `references-math-themes.md` §5's own logic.

For composites the label is the member's name (§5.5), not the composite's type — a typography card
has five value fields and none of them is "a typography".

### 4.3 The value shell: swatch inside the field, no trailing chevron

The reference puts a swatch chip and the value text in **one bordered row**. Adopt it. One
`.value-shell` — a bordered, radius-4 flex row that looks like the text input it contains — holding,
left to right:

```
Color
┌────────────────────────────────────────────────┐
│ ● │ {atlas.ref.palette.indigo-warm-vivid.70}   │
└────────────────────────────────────────────────┘
  = #4b52a8 · follows atlas.ref.palette.…-vivid.70 in Figma
  [ Go to target ]  [ Use the resolved value instead ]
```

- **The swatch is `swatchMark()` + `.swatch-wrap` / `.swatch-fill`**, at `--swatch-size` — the exact
  row-level treatment from `local-editor.md` §4.5's newest amendment. Not a new mark, not a second
  size, and not the `<input type="color">` chrome that currently sits in the `.unit` slot.
- **Behaviour is unchanged** (`references-math-themes.md` §4.1): on a literal, clicking the swatch
  opens the native picker and writes into the text field; on a reference the swatch is **inert**,
  paints the resolved colour at full opacity, and clicking it focuses the text field. The native
  `<input type="color">` becomes the hidden mechanism behind the chip rather than the visible chip.
- **A dangling or wrong-type reference gets the dashed outline**; a cycle draws no mark and the slot
  stays reserved. `panel-size-and-swatches.md` §4.2 and §4.3, unchanged, now applying in the card as
  well as the tree.
- **No trailing chevron.** The reference's is its value-type dropdown, which is precisely the mode
  toggle `references-math-themes.md` §4.1 refused. Adding it here would reintroduce the phase's
  single load-bearing rejection as decoration.
- Non-colour types use the same shell with nothing in the leading slot, and **reserve nothing** — the
  card has no scanning column to keep, so §4.3's reserved-slot rule does not travel here.

### 4.4 Trailing controls stay trailing, inside the shell

`px`/`em` (`.unit`), the subtype select, `Auto`, the shadow `inset` and grid `pattern` selects all sit
at the shell's right edge, matching where the reference puts its trailing control. Fixed width, 52px
for a unit and 84px for a subtype. When the field holds a non-literal value the unit select is
suppressed, exactly as it is today — `px` beside a dotted path is meaningless.

### 4.5 The pointer footer renders for the focused field only

`Go to target` and `Use the resolved value instead` (`references-math-themes.md` §4.3) are right, and
they multiply badly: a typography token with three referenced members would show six buttons. So —

- **A scalar card shows the footer whenever the value is non-literal**, as today. It has one field.
- **A composite card shows it under the field that has focus**, and nowhere else. Unfocused
  referenced members still carry their resolve line, and the target path *inside that line* is a tap
  target that navigates — which is `Go to target` without a button.

### 4.6 Flag messages move up, under the value they describe

Today `line.flags` messages render after the actions toolbar, at the very bottom of the section,
detached from the field they are about. They move to **directly beneath the value field's resolve
line**. Pure legibility: *"Points at folio.ref.palette.red-warm.50, which isn't in any set"* is a
sentence about the field 60px above it.

State blocks keep their existing precedence and stay **above** the value field: cycle block first
(`references-math-themes.md` §7.3b), then conflict (`local-editor.md` §5.5), then drift, then the
in-sync line, then `editBlockedReason`. None of that ordering changes.

---

## 5. C. The seven cards

Section order in every card. A row absent from a type's table simply is not rendered — nothing
renders a placeholder for a section it doesn't have.

| # | Section | color | number | boolean | string | typography | shadow | grid |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 | State blocks (cycle / conflict / drift / in-sync) | ● | ● | ● | ● | ● | ● | ● |
| 2 | Value | ● | ● | ● | ● | — | — | — |
| 3 | Members | — | — | — | — | ● | ● | ● |
| 4 | Subtype | — | ● | — | ● | — | — | — |
| 5 | Description | ● | ● | ● | ● | ● | ● | ● |
| 6 | Figma (collapsible) | ● | ● | ● | ● | ● | ● | ● |
| 7 | Actions | ● | ● | ● | ● | ● | ● | ● |

Subtype sits **directly under the value** and not down with description, because it changes how the
number is read. It is a trailing select in the value shell (§4.4) rather than its own row; the
`guessed` badge follows it, and wraps to the note line beneath if the shell runs out of width at 400.

### 5.1 `color`

The fullest card, and the reference's own case. Value shell with the swatch (§4.3), no subtype.
Nothing else to say.

### 5.2 `number`

Value shell, subtype select trailing. The resolve line does most of the work here since this is the
one type that takes expressions (`references-math-themes.md` §6.2) — it renders under the shell,
unchanged.

### 5.3 `boolean` — the type that gets the least ceremony

A two-state value does not deserve six sections. Today it renders *two* rows: a `Value` row of
segmented buttons plus a separate `Points at` field, because you cannot type `{` into a segmented
control. Keep both mechanisms, spend one label on them:

```
Boolean
┌──────────┬──────────┐
│   true   │  false   │
└──────────┴──────────┘
┌────────────────────────────────────────────────┐
│ ↗ │ {folio.flag.reduced-motion}                │
└────────────────────────────────────────────────┘
  or point at another boolean token
```

- One `Boolean` label over the group; the pointer shell loses its own `Points at` label and gains the
  muted hint line beneath instead.
- When the value **is** a reference, the `.ref-chip` readout stays in front of the segmented pair
  exactly as today (`references-math-themes.md` §4.1 — a non-selectable third position; picking
  `true` or `false` replaces the reference, deliberately two taps).
- No subtype, and the Figma section stays collapsed — a boolean has no members for a binding to
  explain (§6.2).

### 5.4 `string`

Value shell, subtype select trailing (`STRING_SUBTYPES`, e.g. `easing`). Same as `number` minus the
expression case.

### 5.5 `typography`

Five member fields, stacked, each one an ordinary Phase 7 value field (`references-math-themes.md`
§14.1) with its own resolve line. Labels **humanised**:

| Schema key | Label | Trailing |
|---|---|---|
| `fontFamily` | Font family | — |
| `fontWeight` | Font weight | — |
| `fontSize` | Font size | `px` / `em` |
| `letterSpacing` | Letter spacing | `px` / `em` |
| `lineHeight` | Line height | `px` / `em`, then `Auto` |

`Auto` keeps its behaviour precisely — it removes the key (ADR-0003 §3), it is unaffected by what the
field holds, and an absent `lineHeight` shows `Auto` as the field's placeholder, which stays the only
thing that says so.

**The label/key split, stated so it doesn't read as an inconsistency:** UI labels are human; *copy
about the JSON keeps the key in mono*. Rule 2's refusal is still **`fontSize` takes a number, so it
can't point there** (§14.4), the `boundVariables` block still reads `fontSize → {…}`, and §14.7's
disagreement line still names `fontSize`. The label says what the field is; the copy says what the
file holds.

### 5.6 `shadow`

A repeatable list of `.subrow` layers, each with the same stacked member fields. Two layout changes,
both about height:

- **Paired members.** `Offset X` / `Offset Y` on one line, `Blur` / `Spread` on the next — two-up,
  each ~190px at the 400px floor, which is ample for a number. **A pair collapses to two full-width
  stacked rows the moment either member holds a non-literal value**, because a dotted path needs the
  whole width. `Color` and `Inset` stay full-width always.
- **Layer collapsing.** With one or two layers, everything is expanded. With three or more, layer 1 is
  expanded and the rest are collapsed to their `.subhead`, which gains a swatch and the tree's own
  one-line preview: `Shadow 2   ● 0 4 4 #00000040`. Reuses `previewOf` and `swatchMark`; no new
  vocabulary. `↑` / `Remove` stay in the `.subhead` as they are.

Both are the cheapest things in this doc to cut if the build wants to be conservative (§10.5).

### 5.7 `grid`

Same repeatable `.subrow` shape. `Pattern` is a trailing select in the first shell and still literal-only
(`references-math-themes.md` §14.2 — it decides which keys exist; `refuseSubKeyReference` keeps its
narrowed copy). Only the fields valid for the current pattern render, and switching pattern still
*removes* keys rather than zeroing them (`local-editor.md` §5.2). Numeric members pair two-up under
§5.6's rule. Labels humanise the same way: `Section size`, `Gutter size`, `Offset`, `Count`,
`Alignment`.

### 5.8 The reference case, across all seven

Nothing type-specific. A referenced value renders in the shell it would anyway, with the resolve
line beneath, the pointer footer per §4.5, and — for a composite — the cycled member showing an empty
field with the cycle block directly under it while every other member edits normally
(`references-math-themes.md` §14.6). The `↗` glyph and the `{…}` text are the only marks that say
"pointer"; the swatch does not (issue #28).

---

## 6. D. The Figma section

The reference's best structural idea, and the one that maps cleanly onto something Tokenvault already
has and renders badly.

### 6.1 One disclosure, with the Source line as its summary

```
▸ Figma  ·  Variable · Theme / Light
```

Expanded:

```
▾ Figma  ·  Variable · Theme / Light
    VariableID:1:24 · mode 1:0                    (mono, muted, wraps)
    Scopes        All fills, Stroke color
    Bound in Figma
      fontSize → {folio.typography.font-size.70}
      Figma binds `fontSize` to {…font-size.70}. This token's own
      value points at {…size.l}, and that's what applies.
    ▸ 11 Figma text properties
```

- **Source is in the summary, so collapsing never hides it.** `local-editor.md` §5.2's rule is
  *provenance is always shown*; promoting the one line that matters keeps that true while the ids,
  scopes and bindings fold away.
- **One level of disclosure inside, and one exception.** `boundVariables` becomes a plain sub-block
  with a muted heading rather than its own `<details>` — nested disclosures at 400px are a maze. The
  `text` extras keep theirs, because 11 rows of Figma internals nobody reads is exactly what a
  disclosure is for.
- §14.7's disagreement line keeps its position (under the block, grey, only when the two disagree)
  and its copy.

### 6.2 Default state: collapsed, unless it explains the fields above it

The reference ships it expanded. Tokenvault's version is read-only reference material and the
editable fields are the point, so **collapsed by default** — *except* when it carries something that
explains a value the user is looking at:

- **Auto-expanded when `boundVariables` is non-empty**, which is `local-editor.md` §5.2's own
  reasoning honoured rather than overridden: a text style's numbers look "already aliased" and
  *hiding the reason makes the value editor look broken*.
- **Auto-expanded when §14.7's disagreement line fires.**
- Collapsed otherwise. State is remembered while the panel is open and is **not** persisted — it is a
  per-glance preference, not a setting.

### 6.3 Scopes: read-only, humanised, omitted when absent

- Read-only. No checkboxes, no nesting, no write-back. Confirmed scope.
- **Humanised by mechanical transform, not a lookup table**: `ALL_FILLS` → `All fills`,
  `STROKE_COLOR` → `Stroke color`. Lowercase, underscores to spaces, sentence case. Nobody needs the
  enum, and an unknown future scope still renders legibly.
- Comma-separated, wrapping, `--muted`. **Not badges** — `local-editor.md` §9 keeps `.badge` for state,
  and a scope is not a state.
- **Absent → the line is omitted entirely.** No `None`, no dash. Same precedent as
  `panel-size-and-swatches.md` §5.2's empty strip: absence already means absence, and a placeholder on
  most of the tree is ink that never says anything.

---

## 7. E. Description, and the footer

### 7.1 Description

A **two-row textarea**, label above, placeholder **`Optional description`** — the reference's copy,
and better than today's `none`, which reads like a value.

- Commits on **blur**, and on ⌘/Ctrl+Enter. Escape reverts. Enter inserts a newline, because in a
  textarea it must; that is the only behavioural difference from `committingInput` and it is forced by
  the control.
- Newlines are preserved, not stripped — `$description` is a string and DTCG permits them. The tree
  row and the push diff show the first line; neither needs a rule beyond truncation they already do.
- No character counter, no markdown, no validation. It is an optional string.

### 7.2 The footer: `Done`, the path-level write verb, and no Save

**There is no Save button, and there is nothing for one to do.** Every field already commits to the
`clientStorage` overlay on blur (ADR-0004 §2). Adding Save would mean inventing a draft buffer — new
functionality, out of scope, and a worse model besides: a card that can be abandoned unsaved makes
`local-editor.md` §5.4's "local edits" promise conditional.

There is no Cancel either. `←` in the head is the exit, and it has been since Phase 4.

What the footer holds instead is the thing that *is* the write verb — and there is a precedent for
pinning it. `git-sync.md` §7.2 pins `Review & push` in a `.panel-foot` so *the list scrolls against
the panel and the write verb never scrolls out of reach*. Same pattern, same class:

```
├────────────────────────────────────────────────┤
│ Edits are local until you Apply.               │
│                        [ Apply all 2 sets ] [ Done ] │
└────────────────────────────────────────────────┘
```

- **`Done`**, right-aligned, `.primary` — the reference's Save position, doing the reference's Save
  gesture (*I'm finished here*), without claiming to write anything. Identical in effect to `←`.
- **The path-level write verb** beside it when a multi-set path has edits — `Apply all N sets`, moved
  out of the bottom of the scroll where `renderPathActions` puts it today. Per-set `Apply`, `Revert`,
  `Delete token` and `Delete in Figma…` stay inside their own set section: they are about one section,
  and a pinned footer cannot say which.
- **`Delete from all N sets` and `Delete in Figma…` stay in the body**, at the bottom of the scroll.
  Destructive actions do not belong in a permanently visible footer next to `Done`.
- **The note line replaces the stale paragraph** at the top of the body (§1's last row).
  `Edits are local until you Apply.` — rendered only when something on this path is edited, silent
  otherwise. The Phase 6 clause is gone; the Repo tab's own chip is where commit state lives now. At
  400px the note wraps above the buttons rather than sharing their line.

---

## 8. Copy

| Where | Copy | Note |
|---|---|---|
| Value label, scalars | `Color` · `Number` · `Boolean` · `String` | The `$type`, sentence case. Replaces `Hex` and the untitled fields. |
| Composite member labels | `Font family`, `Font size`, `Font weight`, `Letter spacing`, `Line height`, `Offset X`, `Offset Y`, `Blur`, `Spread`, `Color`, `Inset`, `Pattern`, `Count`, `Alignment`, `Gutter size`, `Section size`, `Offset` | Human labels. Copy *about the JSON* keeps the schema key in mono (§5.5). |
| Boolean pointer hint | `or point at another boolean token` | Replaces the `Points at` label and the current commit-refusal sentence as the standing hint. The refusal copy itself is unchanged. |
| Description placeholder | `Optional description` | The reference's own string. Replaces `none`. |
| Figma disclosure summary | `Figma` + `·` + the Source line | e.g. `Figma · Variable · Theme / Light`, `Figma · Style · TEXT`. |
| Bound-variables sub-heading | `Bound in Figma` | Replaces `N bound Variables` — the count was doing nothing and the phrase reads as a fact rather than a file listing. |
| Scopes | `Scopes  All fills, Stroke color` | Omitted entirely when empty (§6.3). |
| Shadow layer, collapsed | `Shadow 2` + swatch + `previewOf` | No new string. |
| Footer note | `Edits are local until you Apply.` | Only when the path has an edit. |
| Footer buttons | `Done` · `Apply all N sets` | No `Save`, no `Cancel` (§7.2). |

**Empty states.** No description → placeholder only. No scopes → line omitted. No `boundVariables`
→ block omitted. No `text` extras → disclosure omitted. No provenance at all → the whole Figma
section is omitted, and `editBlockedReason`'s existing sentence already explains what that means for
editing. Nothing in this card renders an empty container.

---

## 9. What this doc amends

To be applied when the build lands, not before — same precedent as `panel-size-and-swatches.md` §8.

1. **`local-editor.md` §5.1** — gains §3.1's confirmation (still a full-panel overlay, not a modal,
   not a pane), §3.2's single-set/multi-set chrome split, and §3.3's restatement that inline editing
   survives. The section's original inline-vs-overlay split is **unchanged**; only the overlay's
   internals are.
2. **`local-editor.md` §5.2** — the per-type table's controls stay accurate; the section's "read-only,
   always shown, never editable" block gains a pointer to §6 for where that material now lives and
   how "always shown" survives a collapsed disclosure (Source is the summary).
3. **`local-editor.md` §9** — the three things Phase 4 added to the visual language gain a fourth: the
   `.value-shell`. Note explicitly that it introduces **no new colour and no new badge**, and that its
   swatch is `swatchMark()`, not a new mark.
4. **`references-math-themes.md` §4.1** — the `color` row's *"the native `<input type="color">` swatch
   is inert"* sentence stays true, with a note that the visible chip is now `.swatch-fill` and the
   native input is the mechanism behind it. Behaviour is identical; only what you see changed.
5. **The stale sentence in `detail.ts:204-210`** is retired by §7.2. Not a doc amendment, but it is
   the only piece of shipped copy this doc deletes rather than moves, so it is listed here.

---

## 10. Questions for Shyam — Settled 2026-09-07

Five, in the order they'd change the build. Each has a recommendation; **only #1 and #3 change the
shape of the work.** All five decided as recommended: display-only name (§10.1), no Save/Cancel
(§10.2), stacked labels everywhere (§10.3), Figma section collapsed-by-default with auto-expand
(§10.4), keep member pairing / treat layer collapsing as optional (§10.5).

### 10.1 Rename — does the reference's "Name" field mean rename is now wanted?

The reference has an editable Name input. Tokenvault has no rename: ADR-0004 defines
`set-value` / `set-description` / `delete` and no rename op (`local-editor.md` §10.5), so shipping one
means amending an Accepted ADR, adding an overlay op, and rewriting every inbound reference.

**Recommendation: display-only, and the title bar *is* the name field.** The head already shows the
full path in mono with `Copy path` beside it, which is the reference's item 1 exactly. Rendering a
text input that refuses everything typed into it is worse than rendering no input. If rename is
actually wanted it is its own issue, it starts at ADR-0004 rather than here, and it is not
"layout only".

### 10.2 Confirm: no Save, no Cancel, footer holds `Done` + `Apply` (§7.2)

**Recommendation: as written.** Save's honest analogue in Tokenvault is Apply, and pinning the write
verb in a `.panel-foot` is the pattern `git-sync.md` §7.2 already set.

### 10.3 Labels above fields, everywhere in the overlay (§4.1)

The single change that touches every field on this surface. It buys ~90px of value width at the 400px
floor and costs ~14px of height per field.

**Recommendation: yes, stacked.** It is what the reference does, and width is the scarce axis while
height is not.

### 10.4 Figma section collapsed by default, auto-expanded when it explains the fields (§6.2)

**Recommendation: as written.** The alternative — always expanded, as the reference ships it — puts a
block of Figma ids above the footer on every card, most of them ignored.

### 10.5 Are §5.6's two-up member pairing and shadow-layer collapsing worth it?

Both are height optimisations for the two tallest cards, both are conditional (a pair unpairs when a
member holds a reference; layers collapse only past two), and both are the most complex things in the
doc relative to what they buy.

**Recommendation: keep the pairing, and treat layer collapsing as optional.** Pairing is a static
layout rule with one condition; collapsing is closer to an interaction. Cutting either changes nothing
else in the doc.

---

## 11. Acceptance — what to check before this is Implemented

None of this reads off the source; it all needs a running panel at 400px and at the 640 default.

1. A single-set `color` token: one borderless card, `Color` label, swatch inside the shell, no
   `.set-section` border, no `$type` badge, set code in the head's meta line.
2. A multi-set `color` token (`Theme/Light` + `Theme/Dark`): two bordered sections, `h3` per set with
   code and badges, footer showing `Apply all 2 sets` after editing one.
3. Reference vs. literal colour, same value: indistinguishable swatches in the shell, at both ends of
   a ramp (issue #28's failure case).
4. A colour token on a cycle: cycle block above the shell, no mark in the swatch slot, slot reserved.
   A dangling reference: dashed outline. Both at 400px.
5. A typography token with `fontSize` referenced: five stacked human-labelled fields, resolve line
   under the referenced one, pointer footer only on the focused field, Figma section **auto-expanded**
   because `boundVariables` is populated, and §14.7's grey disagreement line present when the two
   differ.
6. A three-layer shadow: layer 1 expanded, 2 and 3 collapsed with swatch + preview; `Offset X`/`Offset Y`
   paired at 400px; the pair unpairing when `offsetX` is given a reference.
7. A grid token: pattern switch removes keys rather than zeroing them, and the visible fields change
   with it.
8. A `boolean` token: one label, segmented pair, pointer shell, hint line — four lines total, not
   seven.
9. A `number` token with `subtypeSource: "default"`: subtype select trailing in the shell, `guessed`
   badge present, and at 400px the badge wrapping rather than overflowing.
10. A token with no `scopes`: no `Scopes` line and no gap where one was.
11. Description: type two lines, blur, reopen the card — both lines are there. ⌘Enter commits, Escape
    reverts.
12. Dark mode, both themes, at both widths: no new colour anywhere on the card; `#000000` swatch
    visible in the shell.
13. A conflicted line and a drifted line: state blocks still above the value field, in the existing
    precedence.
14. Nothing in the panel scrolls horizontally at 400px (`panel-size-and-swatches.md` §3.4).

---

## 12. Build notes for `@frontend-engineer`

- **Nothing here calls Figma.** No canvas reads, no canvas writes, no change to what `scan.ts`
  collects.
- **`.value-shell` is one new class and the only one.** A bordered flex row that inherits the input's
  own look, with the text input inside it at `flex: 1; min-width: 0` and `border: 0`. If the build
  ends up adding a second new class per type, the design was misread.
- **The swatch in the shell is `swatchMark()` + `.swatch-wrap` / `.swatch-fill`** — the same call the
  value line makes, under the same `resolutionFor(line)`. Do not parallel it, and do not restyle the
  native `<input type="color">` into looking like a chip: keep the input as the hidden mechanism and
  let the chip trigger it (`showPicker()`, or a visually-hidden input the chip's click forwards to).
  If the chip and the row's chip ever disagree, the same failure `panel-size-and-swatches.md` §5.4
  exists to prevent has just reappeared in the card.
- **Labels: delete `.field > label`'s `width: 84px`** and the matching `margin-left: 90px` on
  `.field-note` and `.resolve-line`. Those three numbers are one decision (§4.1) and must move
  together, or notes will hang off nothing.
- **Human member labels are display strings only.** `refuseSubKeyReference`'s copy, rule 2's copy,
  §14.7's line and the `boundVariables` rows keep the schema key in mono (§5.5). Do not route error
  copy through the label map.
- **The single-set path skips `.set-section` entirely**, rather than rendering it with the border
  suppressed — `renderSetSection` branches on `row.lines.length === 1`. The badges it drops have to
  reappear in the head's meta line or they are lost.
- **Scope humanising is a transform, not a table**: lowercase, `_` → space, capitalise the first
  letter. An unknown enum must still render.
- **The Figma disclosure's open state is in-memory**, keyed by `{ path, setId }`, cleared on
  `closeDetail`. Not `clientStorage` — the store is quota-constrained (ADR-0004 §1) and this is not
  user data.
- **The footer is `.panel-foot`**, the class `#repo` and `#settings` already use. `#panel` is already a
  flex column with a `flex: none` head and a scrolling body, so this is one appended `flex: none`
  child and no restructuring — `#panel .panel-foot` just needs the padding/border rule the other two
  panels get.
- **Description is a `<textarea>`, so `committingInput` needs a variant, not a fork** — the commit /
  revert / amber-note behaviour is identical; only the Enter binding differs (§7.1).
- **§4.5's focus-scoped pointer footer needs a focus/blur listener per member field.** Render it into
  a single reused container beneath the focused field rather than one hidden container per member.
- **§3.1 and `panel-size-and-swatches.md` §3.4 are constraints, not preferences.** If a task starts
  wanting a second pane, a breakpoint, or a control that only exists above some width, stop.
