# UX: Apply and drift (Phase 5)

**Status:** Provisional — written ahead of the build, to be revised once it's used live in Figma.
**Owner:** `@ux-designer`
**Covers:** PRD §6.5.2 (apply tokens → Figma), §6.5.3 (drift detection), §6.7 (plugin panel), build plan §9 Phase 5.
**Builds on:** `docs/ux/local-editor.md` (Phase 4) — same panel, same vocabulary, same 460 × 640 px. Read that first; this doc extends it rather than restating it.
**Depends on:** the Phase 5 architecture ADR (in flight with `@tech-lead`). Every place a UX choice hangs on a mechanic that isn't decided yet is marked **[ARCH]** and listed in §9.

---

## 1. What we're designing against

Phase 4 shipped an editor whose edits change nothing. The panel says so in as many words: *"Editing a token changes nothing on the canvas."* Phase 5's whole job is to remove that sentence — and the moment it goes, three things become true that weren't before.

| New fact | What it forces |
|---|---|
| **The plugin can now modify the user's file.** Every prior action was local and reversible inside the panel. | Applying needs a look-before-you-leap surface. Not a full diff view (Phase 6), but never a silent write either. §5.2. |
| **Figma and the token tree can now disagree in two directions.** Phase 4 had one direction — you edited, Figma didn't. | The panel needs a single state vocabulary covering all four combinations, not a drift feature bolted next to the edits feature. §3. |
| **Applying is two different operations wearing one word.** Writing a *value* into a Variable is not the same as *binding* a Variable to a layer's fill. | Two flows, deliberately named differently in the UI. §5.1. |

Constraints carried forward from Phase 4, unchanged and still load-bearing:

- **1,316 tokens, 11 sets, 460 px wide.** Anything per-token has to survive being true a thousand times over.
- **Every token has `figma` provenance** (`variableId` + `modeId`, or `styleId`) — it is the apply target as well as the re-import matching key. Phase 5 is the first phase that *writes through* it.
- **Multi-set paths stack value lines** (`Light`, `Dark` under one path). Apply and drift attach to the **value line**, never to the path — same rule as flags and edits.
- **References are displayed, not resolved.** Phase 4 refuses to edit `{…}`; Phase 5 has to decide whether it can *apply* one. See §5.6 and the open question in §9.

---

## 2. Scope

### In scope (Phase 5)

Writing token values back to the Figma Variables and Styles they came from; binding tokens to selected layers; detecting and resolving Figma-side changes the token tree didn't make.

### Explicitly out of scope

| Not this phase | Where it lives | What that means here |
|---|---|---|
| Git push/pull, commit, the pre-commit diff view | Phase 6 (§6.4) | The apply sheet (§5.2) is *not* the diff view. It lists Figma targets, not file changes, and it must not grow a "commit" button. It is, however, the honest ancestor of that screen — build it so Phase 6 can inherit its list component. |
| Theme composition, aliasing, math | Phase 7 (§6.2, §6.3) | Applying a mode-switching theme to the canvas is Phase 7. Phase 5 writes literal values into the modes they already belong to. |
| Creating tokens by hand | Deferred ticket (Phase 4 §6) | So in Phase 5 **every token still has a Figma target**. There is no "apply a token that has nowhere to go" case yet — which removes most of the hard part of apply, and is worth not accidentally re-introducing. |
| Creating *new* Variables or Styles from tokens | See §9.2 **[ARCH]** | Follows from the row above: with no token authoring and no git pull, nothing in the tree lacks a target. Phase 5 updates; it does not create. |
| Circular-reference errors | Phase 7 | Same reasoning as Phase 4 §8 — Phase 5 still can't author a reference, so it can't manufacture a cycle. |

---

## 3. The state model — one vocabulary, four states

This is the spine of the doc. Drift is not a new feature with a new UI; it is **the fourth cell of a table Phase 4 already filled in three cells of**.

For a given token at a given target (one Variable+mode, or one Style), two independent questions:

|  | **Figma unchanged since the last scan** | **Figma changed since the last scan** |
|---|---|---|
| **No local edit** | In sync | **Changed in Figma** ← new in Phase 5 |
| **Local edit** | Local edit *(Phase 4)* | Conflict *(Phase 4 `edit-conflict`)* |

Four consequences, all of which keep Phase 5 cheap:

1. **Drift is conflict with one side missing.** It reuses `edit-conflict`'s two-value comparison block verbatim (Phase 4 §5.5) — the only difference is which side is currently live and what the two buttons do.
2. **Drift is found the same way conflicts are**: by rescanning and comparing against the recorded base. No second detection mechanism, no background polling. §6.1.
3. **Applying collapses states downward.** Apply a local edit → Figma matches → the entry retires → *in sync*. Accept a drift → the token adopts Figma's value → *in sync*. "Applied" is not a fifth state that needs its own badge; it's the absence of the other three.
4. **The header's state slot holds all of it.** Phase 4 put **Local edits · 7** in the slot and called it the first occupant of a permanent one. Phase 5 makes it plural, not different. §6.3.

### Wording

**Never say "drift" in the UI.** It's an accurate internal name and a terrible label — a designer doesn't think "this token has drifted", they think "someone changed it in Figma". User-facing copy is always some form of **Changed in Figma**. `drift` stays in code, ADRs, and this doc's section headings.

Likewise **"Apply" means Figma changes.** It is the only verb in the product that writes to the canvas, so nothing else may borrow it — Phase 4's local commit is still *Save* / *Revert*, and Phase 6's git write must be *Commit* / *Push*, not "apply to the repo".

---

## 4. Screen inventory

```
Tokens tab (Phase 4)                     new in Phase 5
┌────────────────────────┐
│ ⌕ search  [chips]      │
│ ▾ folio                │
│   ■ accent.default     │──⋯ Apply──▶ ┌────────────────────────┐
│       Light  #c33a2e   │             │ Apply 7 changes        │  A. Apply sheet
│       Dark   #f0a19a ⚑ │             │ ☑ Variables (6)        │     (overlay, §5.2)
└────────────────────────┘             │ ☑ Styles (1)           │
     │            │                    │        [ Apply ]       │
     │            │                    └────────────────────────┘
     │            └── ⚑ badge ──▶ ┌────────────────────────┐
     │                            │ Changed in Figma       │  B. Compare block
     │                            │  Token   ■ #c33a2e     │     (in the detail
     │                            │  Figma   ■ #b4342a     │      overlay, §6.4)
     │                            │ [Re-apply] [Take Figma]│
     │                            └────────────────────────┘
     │
     └── canvas selection ──▶ ┌────────────────────────┐
                              │ 3 layers selected      │  C. Selection bar
                              │ Fill ▾        [Apply]  │     (pinned, §5.4)
                              └────────────────────────┘

Header state slot:  [ 7 local · 3 changed ]  ──tap──▶  D. Changes list (§6.3)
```

No new tab. Phase 5 adds one overlay, one inline block, one pinned bar, and rewrites what the header chip says.

---

## 5. A. Applying

### 5.1 Two operations, two names

The PRD's §6.5.2 bundles them; the UI must not.

| | **Apply** (write values) | **Bind** (attach to layers) |
|---|---|---|
| What it touches | Variable values, Style definitions — the library | Node properties on the canvas |
| Where it starts | The token tree or the header chip | A canvas selection |
| Scope | One token, a set, or all local edits | The selected layers |
| Undo | Rewrite the previous value (§5.5) | Figma's own undo |
| Mental model | "Push my edits into the file's variables" | "Use this token here" |

Tokens Studio blurs these — clicking a token chip with a selection binds it, and applying to variables is a separate menu buried in settings. That blur is a real source of "wait, what did that just do?" and we don't copy it. Two verbs, two surfaces, and the selection bar (§5.4) only ever appears when there's a selection, so *Apply* never silently means *Bind*.

### 5.2 Apply local edits — the primary flow

The dominant Phase 5 task: the user edited seven tokens in Phase 4's editor and wants Figma to catch up.

Entry: the header state chip → **Changes list** → `[ Apply to Figma ]`, and a mirror of the same action in the `⋯` menu of any edited value line (scoped to that one target).

Tapping it opens the **apply sheet** — a full-panel overlay, same chrome as the token detail overlay (back arrow, keeps scroll position, no dimmed modal backdrop):

```
┌──────────────────────────────────────────────┐
│ ←  Apply to Figma                            │
│ 7 local edits → 6 Variables, 1 Style         │
├──────────────────────────────────────────────┤
│ Variables · Theme / Light                    │
│  ☑ color.border.accent.default               │
│      #b4342a  →  #c33a2e                     │
│  ☑ color.border.accent.strong                │
│      #c94a3f  →  #d15a4e                     │
│ Variables · Spacing / Mode 1                 │
│  ☑ spacing.100            16  →  20          │
│ Styles · Text                                │
│  ☑ Body Large   Urbanist 20/24 → 20/28       │
├──────────────────────────────────────────────┤
│ ⚠ 1 edit can't be applied — see below        │
│  ⚠ color.bg.surface (was Theme/Dark)         │
│      The Variable was deleted in Figma.      │
├──────────────────────────────────────────────┤
│              [ Apply 7 changes ]             │
└──────────────────────────────────────────────┘
```

Decisions in that sheet, and why:

- **Grouped by Figma target, not by token path.** The user is about to modify collections and styles; that's the unit of consequence. It also makes "oh, this touches the Base collection too" visible, which a path-sorted list hides.
- **Old → new on every row**, in the same value-preview vocabulary as the tree (swatches for colour, compressed typography). This is a diff and it should look like one — it's the pattern Phase 6's commit diff inherits.
- **Per-row checkboxes, all checked.** Not a nag; the escape hatch for "apply six of these, I'm not sure about the seventh". The button counts what's checked and re-counts live.
- **Blocked rows are listed but not checkable**, above the button, with the reason inline. Never hide a failure until after the write. These are Phase 4's `orphaned-edit` entries plus the §7 blockers.
- **No "don't ask again".** Two taps to modify a production file is the right price, and this sheet is the only place the consequences are legible.

**[ARCH]** Whether the write is one atomic batch or per-target, and how a mid-batch failure reports back, is the ADR's call (§9.1). The sheet's copy assumes partial success is possible and reports it that way (§5.5).

### 5.3 Applying a set, a group, or one token

Same sheet, different pre-population — it is always the surface, never a direct write.

| Entry point | Sheet contains |
|---|---|
| `⋯ → Apply` on a **value line** | That one target. One row; the sheet still opens, because a one-row sheet is a confirmation and this is the first canvas write. |
| `⋯ → Apply` on a **path name** (multi-set) | Every set's target for that path, one row each. |
| `⋯ → Apply` on a **group row** | Every token under the group, across sets, grouped by target as usual. Header reads `Apply folio.color.border — 12 tokens`. |
| **Set filter chip → `Apply this set`** | Every token in that set. This is the "make Figma match my `Theme/Dark`" action. |
| Header chip → `Apply to Figma` | Only the local edits (§5.2). |

Note the asymmetry, and it's deliberate: applying a *set* offers every token in it, including the ones already in sync. Those rows render **muted, unchecked, and labelled `already matches`** rather than being dropped, so the count in the button is honest and the user can see the set is mostly fine. If everything matches, the sheet doesn't open at all — a toast says *"Theme / Dark already matches Figma."*

### 5.4 Bind to selected layers

The flow PRD §6.5.2 calls "bulk-apply tokens to selected layers". This is the one place the plugin has to be selection-aware, and it's the flow most likely to feel magical or infuriating depending on the feedback.

**The selection bar** — pinned to the bottom of the Tokens tab, present only while the canvas selection is non-empty, gone the instant it clears:

```
├──────────────────────────────────────────────┤
│ 3 layers · Frame, Text            Fill ▾     │
└──────────────────────────────────────────────┘
```

It states what's selected and what property a bind would target. Then binding is **token-first**: tap `⋯ → Bind to selection` on a value line (or drag isn't a thing at this size — tap only), and the bind runs against the bar's current property.

Why token-first: it matches Tokens Studio's muscle memory (select layers, click a token) and it matches where the user's attention already is — they're in a token browser, scrolling tokens. A property-first flow ("choose fill, then choose a token") would need a second browser inside the bar.

**The property dropdown** lists only properties that are (a) valid for the selected node kinds and (b) type-compatible with tokens in the tree, with a sensible default preselected per token type:

| Token `$type` (+ subtype) | Default property | Also offered |
|---|---|---|
| `color` | Fill | Stroke |
| `number · spacing` | Item spacing (gap) | Padding — all / horizontal / vertical / each side |
| `number · radius` | Corner radius | Per-corner |
| `number · sizing` | Width | Height, Min/Max width, Min/Max height |
| `number · opacity` | Opacity | — |
| `typography` | Text style | — (applies the Style, not fields) |
| `shadow` | Effect style | — |
| `grid` | Layout grid style | — |
| `boolean`, `string` | — | Not bindable to a layer property; the bind action is absent, not greyed. |

**The default is chosen from the token, the property dropdown is the override.** So the common case — pick a colour, hit bind, it fills three frames — is one tap, and the ten-percent case (I meant the stroke) is two.

**Binding, not stamping.** For Variable-backed tokens the plugin binds the **Variable** to the property, so the layer keeps following mode changes; it does not paste the resolved value. This has a consequence worth stating in the UI, because it's the single most confusing thing about the multi-set tree:

> On a multi-set path, **all value lines bind to the same thing.** `Light` and `Dark` are two modes of one Variable — binding from the `Dark` line does not bind "the dark value".

So on a multi-set path, `Bind to selection` lives on the **path name row**, not on the individual value lines, and the confirmation toast says which Variable was bound rather than which value. Style-backed tokens (`typography`, `shadow`, `grid`) apply the Style itself, which is the same story in a different API.

### 5.5 Feedback — success, partial, failure

Nothing about a canvas write is visible in the panel afterwards, so the toast is carrying real weight.

**Full success** — toast, 10 seconds, with undo:

> **Applied 7 changes to Figma.** `[ Undo ]`

> **Bound `folio.color.bg.surface` to 3 layers · Fill.** `[ Undo ]`

**Partial success** — this is the common real outcome for bind, and it must never round up to success:

> **Bound to 3 of 5 layers · Fill.** 2 layers can't take a fill. `[ Details ]` `[ Undo ]`

`[ Details ]` opens a short list naming the skipped nodes and the reason, each row selecting that node on the canvas when tapped — the fastest possible path from "which two?" to "oh, those two". Selecting from the panel is the honest inverse of the selection bar and costs nothing to build.

**Total failure** — no toast, an `.entry` amber block above the tree with the reason and no `Undo` (nothing happened). §7 has the copy per cause.

**Undo.** The plugin holds the previous value for every target it wrote, so undo is a deterministic rewrite, not a hope. It stays available for 10 seconds in the toast — matching Phase 4's delete undo exactly — and after that the way back is Figma's own history. **[ARCH]** Whether plugin writes land as one Figma undo step (so Cmd+Z alone is sufficient and our button is redundant) is §9.3. Until that's settled, ship our own undo and say nothing about Cmd+Z; promising a Figma-native undo we don't control is worse than offering a button we do.

**Applying retires the state.** After a successful apply of local edits, those overlay entries are gone: the header chip drops, the edited rows lose their marker, and the local-edits list empties. This is the payoff moment of the whole phase and it should be *visibly* clean, not quietly clean — the toast is the acknowledgement, and the chip changing from `7 local` to `In sync` is the proof.

### 5.6 Applying a reference value — blocked in Phase 5

A token whose `$value` is `{folio.ref.palette.red-warm.50}` cannot be applied, because Phase 5 can't resolve it (Phase 7 owns aliasing) and writing the literal string into a Variable would be wrong. The apply sheet lists such rows as blocked:

> `color.border.accent.default` — points at another token. Applying references lands with aliasing (Phase 7).

This is deliberately the same shape and the same sentence structure as Phase 4 §5.3's refusal to *edit* a reference. One limitation, stated the same way in both places, reads as a coherent boundary; two differently-worded refusals read as two bugs.

**[ARCH]** Figma Variables support variable aliases natively, so a reference whose target is itself a Variable *could* be applied as an alias binding without any expression evaluation. That's a real Phase 5 possibility and it would delete this whole subsection. §9.4.

---

## 6. B. Changed in Figma (drift)

### 6.1 How the user finds out

**By rescanning.** There is no background watcher and no live drift badge, because there's no cheap way to know without reading the file, and a stale "in sync" claim is worse than no claim. Rescan already exists (Phase 4 §5.5), already does a three-way comparison against the recorded base, and already reports its results in a banner. Drift falls out of the same comparison — the cell of §3's table where Figma moved and you didn't.

So the Phase 4 post-scan banner just gains a count:

> **7 edits reapplied · 3 changed in Figma · 2 conflicts · 1 orphaned**  `[ Review ]`  `[ Dismiss ]`

`[ Review ]` behaves exactly as it does today: it sets the `⚑` chip to the relevant kinds so the tree filters to the rows needing a decision. No wizard, no per-token prompt during the scan.

**Staleness is stated, not hidden.** The Tokens tab header carries a quiet line — *"Scanned 12 minutes ago · Rescan"* — so the absence of drift badges reads as "we last checked 12 minutes ago", not as a live guarantee. Anything stronger would be a promise the architecture doesn't make. **[ARCH]** If the ADR lands a cheap change-detection path (a variable-modified timestamp, a document-change subscription), this becomes a passive nudge — *"Figma has changed since your last scan · Rescan"* — and that's a strictly better design. §9.5.

### 6.2 Where it shows in the tree

**On the value line, as `⚑ changed`**, in the existing `.badge.needs` amber. Not a new colour — Phase 4's rule holds: there is no third badge colour, and "changed in Figma" is the same *needs you* the report already speaks.

The value preview on a drifted line keeps showing the **token's** value, with Figma's value on a muted second line only when the line is expanded. Rationale: the tree is a view of the token file. It should always show what the tokens say; the badge is what says Figma disagrees. Showing Figma's value in the primary slot would make the tree quietly stop being a token browser.

```
■ accent.default
    Light  #c33a2e
    Dark   #f0a19a   ⚑ changed
```

Group rows roll the badge up, exactly as they do for flags today.

### 6.3 The header state slot and the Changes list

Phase 4's header chip read `Local edits · 7`. Phase 5 has up to three counts to report and 100 px to do it in.

**The chip names the state, not the arithmetic:**

| Situation | Chip |
|---|---|
| Nothing anywhere | `In sync` (muted, not a button — but still tappable, opening an empty Changes list) |
| Local edits only | `7 local` |
| Figma changes only | `3 changed` |
| Both | `7 local · 3 changed` |
| Any conflicts | `2 conflicts` — **conflicts always win the slot**, amber, regardless of the other counts |

Conflicts win because they're the only state where the panel is currently showing a value that two sources disagree about; everything else is merely pending. If the counts don't fit, they truncate to the conflict count alone — the list has the rest.

Tapping it opens the **Changes list**, which is Phase 4's local-edits list grown a second and third section:

```
┌──────────────────────────────────────────────┐
│ ←  Changes                                   │
│ [ Local 7 ] [ Changed 3 ] [ Conflicts 2 ]    │  section tabs
├──────────────────────────────────────────────┤
│ Changed in Figma                             │
│  ☐ color.border.accent.default · Dark        │
│      Token ■ #f0a19a   Figma ■ #ef9f98       │
│  ☐ spacing.100 · Spacing        16  →  20    │
│  ☐ Body Large · Text     20/24  →  20/28     │
├──────────────────────────────────────────────┤
│ 0 selected                                   │
│ [ Re-apply tokens ]     [ Take Figma's ]     │
└──────────────────────────────────────────────┘
```

This list is the **one place the whole state of the world is legible**, and it's where Phase 6's sync pill lands on top rather than beside. Same slot, same role, third occupant.

### 6.4 Resolving one change

In the detail overlay, a drifted set section carries the comparison block — the same component as Phase 4's `edit-conflict` block, one row shorter:

```
┌──────────────────────────────────────────────┐
│ ⚑ Changed in Figma                           │
│   Your token     ■ #f0a19a                   │
│   Now in Figma   ■ #ef9f98                   │
│   Someone edited this Variable in Figma      │
│   after your last scan.                      │
│   [ Re-apply token ]     [ Take Figma's ]    │
└──────────────────────────────────────────────┘
```

Two buttons, two directions, and the copy has to make the direction unmissable because they're symmetrical-looking and very much not symmetrical in effect:

| Action | What happens | Where it leaves you |
|---|---|---|
| **Re-apply token** | Writes the token's value into Figma. A canvas write. | In sync. Undoable from the toast (§5.5). |
| **Take Figma's** | Updates the token to Figma's value. A local edit, not a canvas write. | Becomes a **local edit** — because the token file now differs from what was last committed. Phase 6 commits it. |

That second row is the subtle one and it deserves a line of copy on the button's confirmation toast: *"Token updated to Figma's value — it's a local edit until you commit it."* Without that, "Take Figma's" reads as "make this go away", and the user is surprised later when the count reappears in the Changes list under a different heading.

`[ View both ]` isn't a separate action — the block *is* the diff, inline, always expanded. At three values or fewer, a comparison this small doesn't earn a screen of its own; composite types (typography, shadow, grid) render the block as a **field-level list with only differing fields shown**, plus *"4 fields unchanged"* collapsed, which keeps a 15-field typography diff to two lines.

Both actions are one tap, both undoable from the toast, both clear the badge.

### 6.5 Bulk resolution — allowed here, and why that's not a contradiction

Phase 4 deliberately refused a global *keep mine / take theirs* for conflicts: across 1,316 tokens the right answer differs per token. That reasoning still holds for **conflicts**, and the Conflicts section of the list keeps per-row actions only.

Drift is different in one specific way: it's usually **systemic**. Someone re-toned a palette in Figma, or a library update rolled in — the answer is the same for all 40 tokens and forcing 40 taps is contempt. So the Changes list allows bulk, with three guardrails:

1. **Checkboxes, unchecked by default.** The user selects the scope; there is never an "accept all" that operates on rows they haven't looked at.
2. **The list is the scope.** Filters and search apply to it, so "take Figma's for everything in `Theme/Dark`" is: filter, select all visible, act. The button counts the checked rows, always.
3. **Re-apply in bulk routes through the apply sheet** (§5.2) rather than writing directly, because it's a canvas write and canvas writes get the sheet. *Take Figma's* in bulk doesn't — it's a local edit, fully undoable, and Phase 4 already treats local edits as cheap.

### 6.6 Drift on a token that also has a local edit

That's a **conflict**, and it's Phase 4's `edit-conflict` unchanged — same badge, same block, same *Keep mine / Take Figma's*, same rebase-on-resolve behaviour. Phase 5 adds exactly one thing to it: *Keep mine* gains a companion action **`Keep mine and apply`**, which resolves the conflict *and* pushes the value to Figma in one go, since "mine is right, make Figma agree" is the obvious next thought and Phase 4 had no way to finish it.

---

## 7. Empty and error states

### Empty states

| When | Copy |
|---|---|
| Changes list, nothing anywhere | **Everything's in sync.** Your tokens match Figma as of the last scan. |
| Changes list, Changed section empty | **Nothing has changed in Figma** since your last scan. |
| Apply sheet with nothing to do | *(sheet doesn't open)* toast: **Theme / Dark already matches Figma.** |
| Selection bar, nothing selected | *(bar is absent — never an empty bar)* |
| Bind menu, no compatible property | The action is **absent from the `⋯` menu**, not greyed. A `string` token has no layer property; offering a disabled row implies one exists. |

### Error and degraded states

| State | Treatment | Copy |
|---|---|---|
| Apply target deleted in Figma | Blocked row in the sheet; same treatment as Phase 4's `orphaned-edit` | `The Variable this edit changed was deleted in Figma.` `[ Discard edit ]` |
| Token value is a reference | Blocked row in the sheet | `Points at another token. Applying references lands with aliasing (Phase 7).` §5.6 |
| Target is a **library Variable/Style** (published from another file — read-only here) | Blocked row, `⚠` | `This Variable comes from a published library and can't be edited from this file. Change it in its source file.` |
| File is read-only (viewer, branch permissions, Dev Mode) | `.entry` block at the top of the Tokens tab, apply actions disabled throughout | `You can't edit this file, so tokens can't be applied. Everything else still works.` |
| Bind: some layers can't take the property | Partial-success toast + `[ Details ]` list with node-selecting rows | `Bound to 3 of 5 layers · Fill. 2 layers can't take a fill.` |
| Bind: **no** selected layer can take the property | Nothing written, `.entry` block near the selection bar | `None of the 5 selected layers can take a fill. Pick a different property or a different selection.` |
| Bind: a selected layer is locked | Counted as skipped, named in `[ Details ]` | `Locked — unlock it to bind.` |
| Bind: token type has no bindable property | Action absent (see empty states) | — |
| Apply partially failed mid-batch | Toast reports what landed; sheet reopens with the failed rows still checked | `Applied 5 of 7. 2 failed — they're still listed here.` |
| Apply failed entirely | `.entry` block, no undo offered | `Couldn't apply — nothing changed in Figma.` + the underlying reason |
| Rescan finds drift | Existing post-scan banner, count added | see §6.1 |
| Drift on a composite type | Field-level comparison, unchanged fields collapsed | `4 fields unchanged` |
| Two sets disagree on `$type` at one path | Unchanged from Phase 4 — per-line glyphs, no badge. Apply operates per line regardless. | — |

**Circular references and math errors are still not a Phase 5 state.** Phase 5 can't author or edit a reference any more than Phase 4 could. Don't build cycle detection here.

---

## 8. Visual language — still no new colours

Everything in Phase 5 maps onto vocabulary that already exists:

- `⚑ changed` is `.badge.needs` — the **same amber** as `flagged`, `conflict`, `orphaned`. Phase 4 banned a third badge colour and Phase 5 does not get an exemption. "Changed in Figma" is not more urgent than a conflict, it's the same *needs you*.
- The **comparison block** (§6.4) is the `edit-conflict` block with one fewer row. One component, two callers.
- The **apply sheet** is the detail overlay's chrome (back arrow, full panel, no backdrop) with the local-edits list's row shape. No new overlay style.
- The **toast** is the existing toast, doing what it already does for delete: report + undo, 10 seconds.
- `.entry` (amber left border) carries every blocking error, as it does today.
- The **header state slot** keeps its role: *what state is my work in*. Phase 4's chip was its first occupant; Phase 5's is its second; Phase 6's sync pill is its third.

Two genuinely new pieces:

1. **The selection bar** — pinned bottom, one line, appears and disappears with the canvas selection. It's the only piece of chrome in the plugin that reacts to the canvas, so it should be visually quiet: same background as the header, a top border, no accent fill. It must not animate in and out; at this size, a bar that slides is a bar that's in your way.
2. **A green.** `In sync` is the first genuinely *good* state the panel has ever had, and rendering it in the same grey as everything else wastes the one moment the user gets confirmation. Proposal: a muted success colour used **only** on the header chip's `In sync` state and nowhere else — not a badge, not a row treatment. **[ARCH-adjacent, but really a taste call — §9.6.**]

---

## 9. Open questions for Shyam

1. **How much ceremony should the apply sheet have?** §5.2 puts a checklist between the user and every canvas write, including single-token applies. The argument for: it's the first action in the product that changes a file they can't undo from inside the panel. The argument against: after the tenth time, it's a speed bump on a road you drive daily. Options: (a) as specified, always; (b) sheet for multi-target applies, direct write + undo toast for a single token; (c) sheet always, with a per-session "don't confirm single tokens" toggle. *This is the biggest product-feel question in the phase.*
2. **Should Phase 5 create Variables/Styles that don't exist yet, or only update existing ones?** §2 assumes update-only, which is currently free — with token creation deferred and no git pull yet, every token has a target. It stops being free the moment Phase 6 pulls a token file from the repo. Worth deciding now whether "apply creates what's missing" is Phase 5's problem or Phase 6's. **[ARCH]** — needs the tech-lead's read too.
3. **Undo for canvas writes: ours, Figma's, or both?** §5.5 ships our own 10-second undo. If plugin writes group into a single Figma undo step, Cmd+Z already does it and two undos that both work is its own confusion. **[ARCH]** — the ADR should settle whether the grouping is reliable.
4. **Can a reference-valued token be applied as a native Figma Variable alias?** §5.6 blocks it and points at Phase 7. But Figma aliases variables natively, and `{folio.ref.palette.red-warm.50}` resolving to a Variable is a pure lookup, not expression evaluation. If that's in reach, Phase 5 gets meaningfully more useful and §5.6 disappears. **[ARCH]** — cheap to answer, changes real scope.
5. **Is scan-time drift detection enough, or does the panel need to notice on its own?** §6.1 ships scan-only with a "scanned 12 minutes ago" staleness line. If a cheap change signal exists, a passive *"Figma has changed — rescan"* nudge is strictly better and costs one line of chrome. **[ARCH]**
6. **A green for `In sync`?** §8 wants one colour used in exactly one place. Small, but it's the first crack in the panel's grey-and-amber discipline, so it's your call rather than mine.
7. **Does "Take Figma's" need a confirmation?** §6.4 makes it a plain local edit, undoable, no dialog. In bulk (§6.5) it can silently rewrite forty token values. Undo covers it, but "undo covers it" and "the user understood what happened" aren't the same claim.

---

## 10. Build notes for `@frontend-engineer`

- **Read the Phase 5 ADR first.** This doc specifies how states *read*; the ADR owns write mechanics, batching, the drift comparison basis, and conflict semantics. Where they disagree, the ADR wins and this doc gets amended.
- **Apply and bind are separate code paths and separate messages.** They share nothing but a verb in casual speech. Don't unify them behind one `apply(target)`.
- **Everything is keyed to `{ path, setId }` → provenance**, exactly as in Phase 4. The merged row stays a display construct; apply resolves through `figma.variableId + modeId` / `figma.styleId`, never through the path.
- **Hold the pre-write value for every target you touch** — undo (§5.5) is a rewrite, not a re-scan, and partial-failure reporting needs to know what actually landed.
- **The apply sheet's row component is Phase 6's diff row.** Build it as `{ target, before, after, state }` and keep it out of Phase 5-specific modules.
- **Drift is computed by the scan comparison, not by a second mechanism.** It should fall out of the same three-way merge that already produces `edit-conflict` and `orphaned-edit` — as a fourth report kind, not a parallel system.
- **The selection bar needs `selectionchange`, and needs to be cheap.** It runs on every canvas click. Compute node kinds and valid properties from the selection summary, not by walking each node's full property set.
- **Never write on selection change.** The bar is a readout; only an explicit tap binds.
- **Preserve `$extensions."com.tokenvault"` byte-for-byte through every apply and drift-resolution path.** ADR-0002 §7's byte-identical re-import guarantee is exactly as fragile here as it was in Phase 4, and *Take Figma's* is a new way to break it — it must write only `$value`, never rebuild the token.
- **Reuse `.badge.needs` and the conflict block.** If Phase 5 introduces a third badge colour or a second comparison component, something has gone wrong in the translation from this doc.
- Section 2's out-of-scope table is the scope boundary. If a task starts needing reference resolution, mode composition, Variable creation, or a git write, stop and raise it.
