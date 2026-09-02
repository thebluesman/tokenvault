# UX: Apply and drift (Phase 5)

**Status:** Provisional — written ahead of the build, to be revised once it's used live in Figma.
**Owner:** `@ux-designer`
**Covers:** PRD §6.5.2 (apply tokens → Figma), §6.5.3 (drift detection), §6.7 (plugin panel), build plan §9 Phase 5.
**Builds on:** `docs/ux/local-editor.md` (Phase 4) — same panel, same vocabulary, same 460 × 640 px. Read that first; this doc extends it rather than restating it.
**Depends on:** ADR-0005 (in flight with `@tech-lead`). Every place a UX choice hangs on a mechanic that isn't decided yet is marked **[ARCH]** and listed in §9.
**Revised 2026-09-02** after Shyam's decisions on §9 — apply always confirms (§5.2), deleting Figma Variables/Styles is in scope behind its own destructive confirmation (§5.7), and apply preserves token-to-token pointers instead of flattening them (§5.6).
**Revised again 2026-09-02 (second pass)** — the apply confirmation is a **lightweight modal**, not a full-panel screen (§5.2); drift reuses Phase 4's `⚑` badge rather than any new indicator (§6.2); **there is no plugin-side undo for canvas writes** — Figma's ⌘Z is the only undo, and the copy says so plainly (§5.5); and `In sync` gets a **green**, completing the panel's four-colour status language (§8). Eight of §9's eleven questions are now closed; three remain, all `[ARCH]`.

---

## 1. What we're designing against

Phase 4 shipped an editor whose edits change nothing. The panel says so in as many words: *"Editing a token changes nothing on the canvas."* Phase 5's whole job is to remove that sentence — and the moment it goes, three things become true that weren't before.

| New fact | What it forces |
|---|---|
| **The plugin can now modify the user's file.** Every prior action was local and reversible inside the panel. | Applying needs a look-before-you-leap surface. Not a full diff view (Phase 6), but never a silent write either. §5.2. |
| **Figma and the token tree can now disagree in two directions.** Phase 4 had one direction — you edited, Figma didn't. | The panel needs a single state vocabulary covering all four combinations, not a drift feature bolted next to the edits feature. §3. |
| **"Applying" is several different operations wearing one word.** Writing a *value* into a Variable, *binding* a Variable to a layer's fill, and *deleting* a Variable outright are three different consequences. | Three flows, deliberately named differently in the UI, each with one surface. §5.1, §5.7. |

Constraints carried forward from Phase 4, unchanged and still load-bearing:

- **1,316 tokens, 11 sets, 460 px wide.** Anything per-token has to survive being true a thousand times over.
- **Every token has `figma` provenance** (`variableId` + `modeId`, or `styleId`) — it is the apply target as well as the re-import matching key. Phase 5 is the first phase that *writes through* it.
- **Multi-set paths stack value lines** (`Light`, `Dark` under one path). Apply and drift attach to the **value line**, never to the path — same rule as flags and edits.
- **References are displayed, not resolved.** Phase 4 refuses to edit `{…}`; Phase 5 has to decide whether it can *apply* one. See §5.6 and the open question in §9.

---

## 2. Scope

### In scope (Phase 5)

Writing token values back to the Figma Variables and Styles they came from; **preserving token-to-token pointers as native Figma aliases when doing so** (§5.6); binding tokens to selected layers; **deleting a Figma Variable or Style behind its own destructive confirmation** (§5.7); detecting and resolving Figma-side changes the token tree didn't make.

### Explicitly out of scope

| Not this phase | Where it lives | What that means here |
|---|---|---|
| Git push/pull, commit, the pre-commit diff view | Phase 6 (§6.4) | The apply dialog (§5.2) is *not* the diff view. It lists Figma targets, not file changes, and it must not grow a "commit" button. It is, however, the honest ancestor of that screen — build it so Phase 6 can inherit its list component. |
| Theme composition, math expressions, **authoring or editing** references | Phase 7 (§6.2, §6.3) | Phase 5 **carries** existing references through apply (§5.6) but still cannot create, retarget, or evaluate one. Phase 4's rule holds in the editor: render the reference, badge it, refuse to edit it. Applying a mode-switching theme to the canvas is also Phase 7. |
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
│       Light  #c33a2e   │             │ Apply 7 changes        │  A. Apply dialog
│       Dark   #f0a19a ⚑ │             │ ☑ Variables (6)        │     (modal, §5.2)
└────────────────────────┘             │ ☑ Styles (1)           │
     │            │                    │ [Cancel]  [ Apply ]    │
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
                    [ ● In sync ]  ← green when there's nothing to report (§8)

⋯ Delete in Figma ──▶ ┌────────────────────────┐
                      │ Delete 1 Variable?     │  E. Delete-in-Figma
                      │ Used by 14 layers      │     confirmation (§5.7)
                      │ [Cancel] [ Delete ]    │     — its own screen,
                      └────────────────────────┘       destructive styling
```

No new tab, and no new indicator. Phase 5 adds one modal (the apply dialog), one full-panel overlay (the delete confirmation), one inline block, one pinned bar, and rewrites what the header chip says. Drift itself adds nothing to this inventory — it rides on Phase 4's `⚑` badge and the existing filter chip (§6.2).

**The apply dialog and the delete confirmation are deliberately different screens.** Never a delete row inside an apply checklist, never a delete button on the apply dialog. Reasoning in §5.7.

---

## 5. A. Applying

### 5.1 Three operations, three names

The PRD's §6.5.2 bundles them; the UI must not.

| | **Apply** (write values) | **Bind** (attach to layers) |
|---|---|---|
| What it touches | Variable values, Style definitions — the library | Node properties on the canvas |
| Where it starts | The token tree or the header chip | A canvas selection |
| Scope | One token, a set, or all local edits | The selected layers |
| Undo | Figma's own undo (⌘Z) — §5.5 | Figma's own undo (⌘Z) |
| Mental model | "Push my edits into the file's variables" | "Use this token here" |

Tokens Studio blurs these — clicking a token chip with a selection binds it, and applying to variables is a separate menu buried in settings. That blur is a real source of "wait, what did that just do?" and we don't copy it. Two verbs, two surfaces, and the selection bar (§5.4) only ever appears when there's a selection, so *Apply* never silently means *Bind*.

**A third verb joins them: *Delete in Figma*** (§5.7). It is not a kind of apply and never appears inside one — separate menu item, separate screen, separate button colour. Three verbs that touch the file, each with exactly one surface.

### 5.2 Apply local edits — the primary flow

The dominant Phase 5 task: the user edited seven tokens in Phase 4's editor and wants Figma to catch up.

Entry: the header state chip → **Changes list** → `[ Apply to Figma ]`, and a mirror of the same action in the `⋯` menu of any edited value line (scoped to that one target).

*Shyam, 2026-09-02 (§9.10): a lightweight modal — not a persistent tab, not a full-panel screen, and emphatically not Phase 6's diff view.*

Tapping it opens the **apply dialog** — a **modal card over a dimmed panel**, sized to its content, capped at roughly two-thirds of the panel height with the list scrolling inside it, and dismissible three ways (`Cancel`, `Esc`, tap the backdrop):

```
┌──────────────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒ tree, dimmed, still there ▒▒▒▒▒▒▒▒▒│
│  ┌────────────────────────────────────────┐  │
│  │ Apply to Figma                       ✕ │  │
│  │ 7 local edits → 6 Variables, 1 Style   │  │
│  ├────────────────────────────────────────┤  │
│  │ Variables · Theme / Light            ▲ │  │
│  │  ☑ color.border.accent.default         │  │
│  │      #b4342a  →  #c33a2e               │  │
│  │  ☑ color.border.accent.strong          │  │
│  │      #c94a3f  →  #d15a4e               │  │
│  │ Variables · Spacing / Mode 1           │  │
│  │  ☑ spacing.100          16  →  20      │  │
│  │ Styles · Text                        ▼ │  │
│  │  ☑ Body Large  Urbanist 20/24 → 20/28  │  │
│  ├────────────────────────────────────────┤  │
│  │ ⚠ 1 edit can't be applied              │  │
│  │  ⚠ color.bg.surface (was Theme/Dark)   │  │
│  │      The Variable was deleted in Figma.│  │
│  ├────────────────────────────────────────┤  │
│  │ ⌘Z in Figma is the only undo.          │  │
│  │  [ Cancel ]        [ Apply 7 changes ] │  │
│  └────────────────────────────────────────┘  │
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
└──────────────────────────────────────────────┘
```

Decisions in that dialog, and why:

- **A modal, and Phase 4's anti-modal rule survives intact.** Phase 4 §5.1 refused a centred modal for *editing*, because at 460 × 640 a backdrop plus modal chrome eats a third of a workspace you need to stay in. A confirmation is the opposite shape of thing: it is transient, it has exactly one decision in it, it should cost nothing to dismiss, and it must **not** feel like navigating somewhere. The full-panel overlay is wrong for it precisely because that chrome (back arrow, replaces the tree) reads as *"you have gone to a new screen"* — too heavy for something the user sees on every single apply, forever. The dimmed tree staying visible behind the card is doing real work: it says *you are still on the Tokens tab, this is a question, answer it and you're back.*
- **Everything about it is sized down, because frequency is the constraint.** No back arrow, a `✕` instead. No section tabs. No search. Header is two lines: what and how much. If a future ticket wants to add a control to this dialog, the burden of proof is on the control — the "always confirm" rule (§9.1) means every gram of weight here is paid a thousand times.
- **Never full-panel, never a tab, and never Phase 6's diff view.** Those three are the rejected alternatives, and the reason is the same for all three: this screen answers *"am I sure?"*, not *"what changed?"*. Phase 6's diff view is a review surface you go to deliberately. Sharing the row component with it (§10) is right; sharing its weight is not.
- **Grouped by Figma target, not by token path.** The user is about to modify collections and styles; that's the unit of consequence. It also makes "oh, this touches the Base collection too" visible, which a path-sorted list hides.
- **Old → new on every row**, in the same value-preview vocabulary as the tree (swatches for colour, compressed typography). This is a diff and it should look like one — it's the pattern Phase 6's commit diff inherits.
- **Per-row checkboxes, all checked.** Not a nag; the escape hatch for "apply six of these, I'm not sure about the seventh". The button counts what's checked and re-counts live.
- **Blocked rows are listed but not checkable**, above the button, with the reason inline. Never hide a failure until after the write. These are Phase 4's `orphaned-edit` entries plus the §7 blockers.
- **The list scrolls inside the card; the footer never does.** A 40-row apply must not push the button off the bottom, and the user must be able to see *"Apply 40 changes"* without scrolling to it. The card grows with its content up to the cap, then stops.
- **Dismissing is free and always available.** `Cancel`, `Esc`, and a backdrop tap all do the same nothing. There is no "are you sure you want to cancel", no confirmation-on-a-confirmation, and checkbox state is discarded on dismiss rather than remembered — a dialog the user backed out of should not ambush them with stale selections next time.
- **The undo reality is stated in the footer, above the button** — *"⌘Z in Figma is the only undo."* One quiet line, always present. §5.5 explains why this sentence exists and why it is the only place the panel promises anything about undo.
- **The dialog is unconditional. No shortcut, no "don't ask again", no exemption for a single token.** *(Shyam, 2026-09-02 — §9.1.)* Two taps to modify a production file is the right price, and this dialog is the only place the consequences are legible. Concretely, for the engineer: there is **no code path that writes to Figma without this dialog having been shown and confirmed** — not the single-token `⋯ → Apply`, not `Re-apply token` on a drift row (§6.4), not a bulk re-apply from the Changes list (§6.5). Every one of them routes through here. If a future ticket wants a fast path, it amends this line first.

**[ARCH]** Whether the write is one atomic batch or per-target, and how a mid-batch failure reports back, is the ADR's call (§9.1). The dialog's copy assumes partial success is possible and reports it that way (§5.5).

### 5.3 Applying a set, a group, or one token

Same dialog, different pre-population — it is always the surface, never a direct write.

| Entry point | Dialog contains |
|---|---|
| `⋯ → Apply` on a **value line** | That one target. One row; the dialog still opens — a one-row dialog *is* the confirmation, and per §5.2 there is no path around it. |
| `⋯ → Apply` on a **path name** (multi-set) | Every set's target for that path, one row each. |
| `⋯ → Apply` on a **group row** | Every token under the group, across sets, grouped by target as usual. Header reads `Apply folio.color.border — 12 tokens`. |
| **Set filter chip → `Apply this set`** | Every token in that set. This is the "make Figma match my `Theme/Dark`" action. |
| Header chip → `Apply to Figma` | Only the local edits (§5.2). |

Note the asymmetry, and it's deliberate: applying a *set* offers every token in it, including the ones already in sync. Those rows render **muted and labelled `already matches`**, with a green `●` in place of the checkbox (§8) rather than being dropped, so the count in the button is honest and the user can see the set is mostly fine. If everything matches, the dialog doesn't open at all — a toast says *"Theme / Dark already matches Figma."*

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

**Full success** — toast, 10 seconds:

> **Applied 7 changes to Figma.**

> **Bound `folio.color.bg.surface` to 3 layers · Fill.**

**Partial success** — this is the common real outcome for bind, and it must never round up to success:

> **Bound to 3 of 5 layers · Fill.** 2 layers can't take a fill. `[ Details ]`

`[ Details ]` opens a short list naming the skipped nodes and the reason, each row selecting that node on the canvas when tapped — the fastest possible path from "which two?" to "oh, those two". Selecting from the panel is the honest inverse of the selection bar and costs nothing to build.

**Total failure** — no toast, an `.entry` amber block above the tree with the reason (nothing happened, so there is nothing to take back). §7 has the copy per cause.

#### Undo: Figma's, not ours

*Shyam, 2026-09-02 (§9.3): rely entirely on Figma's native ⌘Z. **The plugin ships no undo button for canvas writes.***

No `[ Undo ]` in the apply toast, no `[ Undo ]` in the bind toast, no undo entry in the Changes list for anything that touched the file. The reasoning is worth keeping, because "add an undo button" will look like an obvious improvement to a future reader:

- **Two undos that both work is a worse product than one.** If the panel offers a button *and* ⌘Z does something, the user has to know which one they're in, and the two disagree the moment focus leaves the panel. A single mechanism the user already trusts beats a second one we maintain.
- **Ours would be a lie at the edges anyway.** A plugin-side "rewrite the previous value" undo can't restore a binding that was replaced, can't put back a Style the user has since edited by hand, and can't know what happened on the canvas in the ten seconds it was on screen. Figma's history knows all of that; ours would be a confident-looking approximation.
- **It is one fewer thing to hold.** No pre-write value cache kept alive for undo, no expiry, no "undo an undo".

**The scope of the local-edit undo is unchanged.** Phase 4's undo still covers everything that only touches the token tree: reverting an edit, restoring a deleted token, *Take Figma's* (§6.4). Those are local, cheap, and fully reversible in the panel — that is exactly why they keep their button. The rule is one line: **the panel can undo what it did to the tokens; only Figma can undo what was done to the file.**

**Where we say so.** Once, quietly, in the place the decision is made — the apply dialog's footer (§5.2): *"⌘Z in Figma is the only undo."* Not in the toast (a toast is the wrong place to teach a mechanic, and it would repeat forever), not in a first-run tip, not in a settings note.

**The copy is deliberately non-committal about how many ⌘Zs it takes**, and this matters. ADR-0005 has an open technical question (§9.3) about whether a plugin's writes coalesce into a single Figma undo step. We do not know yet, so the copy does not claim it — *"⌘Z in Figma is the only undo"* is true either way, whereas *"press ⌘Z to undo this apply"* is a promise we can't currently keep.

> **For `@frontend-engineer`:** verify the coalescing behaviour at build time. If plugin writes **do** land as one undo step, the copy can be sharpened to *"Undo it with ⌘Z in Figma"* — a one-word ticket. If they **don't** (a 7-token apply needs 7 undos), the footer needs a second line saying so plainly, e.g. *"each change undoes separately."* Either way this is a copy adjustment against a verified fact, not a reopening of the decision. Do not build a plugin-side undo to compensate.

**Applying retires the state.** After a successful apply of local edits, those overlay entries are gone: the header chip drops, the edited rows lose their marker, and the local-edits list empties. This is the payoff moment of the whole phase and it should be *visibly* clean, not quietly clean — the toast is the acknowledgement, and the chip changing from `7 local` to `In sync` is the proof.

### 5.6 Applying a reference — the pointer survives

*Shyam, 2026-09-02 (§9.4): apply preserves token-to-token pointers rather than flattening them.* **[ARCH — pending ADR-0005; see the caveat at the end of this section.]**

`folio.color.border.accent.default` has `$value: "{folio.ref.palette.red-warm.50}"`. Two things could be written into its Variable: the resolved colour `#c33a2e`, or a native Figma **alias** to the `folio.ref.palette.red-warm.50` Variable. Phase 5 writes the alias.

The difference matters and the UI has to make it visible, because it's invisible on the canvas and enormous over time: flattening the pointer means the next change to `red-warm.50` in Figma stops propagating, and the file quietly decays into a thousand unrelated hex values. The whole reason the token file has references is that the relationships *are* the design system.

#### The apply row for an aliased token

A reference row in the apply dialog shows the **pointer**, not a colour, on the "after" side:

```
│ Variables · Theme / Light                    │
│  ☑ color.border.accent.default               │
│      ■ #b4342a  →  ↗ {…palette.red-warm.50}  │
│                     resolves to ■ #c33a2e    │
```

Three deliberate choices:

- **The `↗` glyph and the truncated-from-the-left path** are exactly Phase 4 §4.5's reference preview. Same rendering everywhere a reference appears in the product.
- **The resolved value is a muted second line, never the primary.** It tells the user what they'll see on the canvas without letting them mistake a pointer for a colour. `↗` on the primary line is the load-bearing signal.
- **"Flattening" is named when it happens.** Where the pointer can't be preserved (§5.7's table below), the row falls back to the literal value with an explicit note — `↗ can't be aliased · applying #c33a2e as a literal` — and that row is **unchecked by default**. Silently flattening a reference is the one failure mode that costs the user something they won't notice for months.

#### When a pointer can't be preserved

| Case | Row treatment |
|---|---|
| Target token exists and has a Figma Variable | Alias written. Normal checked row. |
| Target token exists but has **no** Figma Variable (style-derived, or a type Variables can't hold) | Blocked, not silently flattened: `Points at a token that isn't a Figma Variable — nothing to alias to.` |
| Target is **in a different collection** than the source | **[ARCH]** — Figma's cross-collection alias rules are the ADR's to state. Until it does, treat as blocked with `Can't alias across collections.` rather than guessing. |
| Target is missing entirely (Phase 4's `dangling-reference`) | Blocked, reusing the existing dangling treatment: `Points at folio.ref.palette.red-warm.50, which isn't in any set.` |
| Value is a math expression (`{a} * 2`) | Blocked. Phase 7 owns evaluation; Phase 5 aliases a pointer, it does not compute one. |

#### Aliases and drift

An aliased Variable introduces a drift case Phase 5 must read correctly: **the pointer changed, not the value.** Someone in Figma re-pointed the Variable at a different one, or broke the alias and typed a literal. The comparison block (§6.4) renders it as a pointer diff, not a colour diff:

```
│ ⚑ Changed in Figma                           │
│   Your token   ↗ {…palette.red-warm.50}      │
│   Now in Figma   ■ #b4342a  (alias removed)  │
```

`(alias removed)` and its inverse `(now aliased)` are the copy that makes this legible; without them, a pointer-to-literal change looks like a colour that barely moved. **Re-apply token** restores the alias; **Take Figma's** replaces the token's reference with a literal — which is an *edit to a reference*, the one thing Phase 4 forbade. So that button gets a second line of confirmation copy here and nowhere else:

> Taking Figma's value replaces the reference with a literal `#b4342a`. Phase 5 can't put the reference back — you'd re-point it in Phase 7.

**Caveat — this section is written ahead of its feasibility.** `@tech-lead` is assessing native alias support in ADR-0005 in parallel. If aliasing turns out to be partly or wholly unavailable in Phase 5, the fallback is §5.6 as originally drafted — reference rows **blocked** in the apply dialog with *"Applying references lands with aliasing (Phase 7)"*, matching Phase 4 §5.3's refusal word-for-word. The fallback is deliberately "block", never "flatten silently". **This section needs one review pass once ADR-0005 lands.**

### 5.7 Deleting a Figma Variable or Style

*Shyam, 2026-09-02 (§9, new): allowed, but only through its own explicit, destructive confirmation.*

Phase 4's delete removes a token from the local tree and says, in as many words, *"Nothing changes in Figma — the Variable is still there."* Phase 5 makes the other half possible: actually removing the Variable or Style from the file.

**These stay two separate actions with two separate names.** In the `⋯` menu:

```
  Apply
  Bind to selection
  ──────────────────
  Delete token            ← Phase 4. Local tree only.
  Delete in Figma…        ← Phase 5. Destructive, red label, trailing ellipsis.
```

*Delete token* keeps its Phase 4 copy unchanged. *Delete in Figma…* is the new one, and everything about it is styled to be a different kind of thing: red label in the menu, an ellipsis promising a further step, and it sits below a divider so it can never be mis-tapped as the row above.

#### It is never part of an apply

A deletion cannot ride along in the apply dialog, cannot be a row in that checklist, and there is no button on the apply dialog that deletes anything. The reason is the checklist's own design: §5.2 ships every row pre-checked, so a delete row would be a destructive default — the one class of action that must never be opted into on the user's behalf. And the two are not the same kind of consequence even in Figma's own history: a wrong value can be re-applied correctly from the panel a second later, whereas a deleted Variable takes every layer binding with it and only ⌘Z brings those back.

#### The confirmation

Its own **full-panel overlay** — deliberately the heavier surface, and the contrast with §5.2 is the point. Apply is a modal you dismiss with a stray tap on the backdrop, because apply is frequent and recoverable. Delete replaces the screen, has no backdrop to tap away, and makes you read a blast radius, because it is neither. Reached only from `Delete in Figma…`:

```
┌──────────────────────────────────────────────┐
│ ←  Delete in Figma                           │
├──────────────────────────────────────────────┤
│ Delete this Variable from the file?           │
│                                               │
│   folio.color.border.accent.default           │
│   Variable · Theme (Light, Dark)              │
│   ■ #c33a2e   ■ #f0a19a                       │
├──────────────────────────────────────────────┤
│ ⚠ Used by 14 layers                           │
│   Those layers keep their current colour but  │
│   stop following the Variable.  [ Show them ] │
│                                               │
│ ⚠ 7 tokens point at this one                  │
│   folio.color.border.accent.strong  Light,Dark│
│   folio.color.bg.surface            Light,Dark│
│   … 5 more                          [ List ]  │
├──────────────────────────────────────────────┤
│ This can't be undone from the plugin.         │
│ Figma's own undo (⌘Z) is the only way back.   │
├──────────────────────────────────────────────┤
│   [ Cancel ]            [ Delete Variable ]   │
└──────────────────────────────────────────────┘
```

What each part is doing, and why it's not negotiable:

- **The blast radius comes before the button, not after.** Two counts, both of them things the user cannot see from the token tree: how many **layers** are bound to it, and how many **tokens** point at it. `[ Show them ]` selects those layers on the canvas — the same node-selecting rows as §5.5's `[ Details ]`.
- **Deleting a Variable that other tokens reference is blocked, not warned.** Phase 4 §7 blocks local delete while inbound references exist, for exactly this reason, and Phase 5 does not get to be more permissive about a *more* destructive version of the same action. When the referrer count is non-zero, the confirmation opens in its blocked form: the referrer list in full (tappable, navigating to each token — Phase 4 §7's panel verbatim), no primary button, and `[ Close ]` alone.
- **Layers being bound is a warning, not a block.** Fourteen layers keeping their colour and losing their binding is a real consequence, but it's the user's call and it's exactly what deleting a Variable means. Blocking on it would make the action nearly unusable in any real file.
- **The undo sentence is stated before the button, not in the toast afterwards.** Since §5.5, ⌘Z is the only undo for *every* canvas write, so this line is no longer unique to deletion — but it is stated at greater length here, because this is the one write whose damage a second apply cannot repair. Every other consequence in the product is re-doable from the panel; this one isn't, and that belongs where the decision is made.
- **No typed confirmation.** Phase 4 called a typing gate theatre for local deletes. Here the gate is real — a separate screen, a red button, a blast-radius readout — and adding "type DELETE" on top of it is the kind of ceremony that trains people to type without reading.

#### The destructive button

`[ Delete Variable ]` is the panel's **first and only destructive CTA**: red fill, white label, right-aligned in the primary slot, with `[ Cancel ]` as a plain-text button to its left. Named for the object, not the verb alone — *Delete Variable* / *Delete Style* / *Delete 12 Variables* — so the button says what's about to be gone even if the user reads nothing else. §8 covers the colour, and the discipline around not letting it leak anywhere else.

#### Bulk

`Delete in Figma…` is offered on a value line, on a path (all its Variables), and on a group row. The confirmation aggregates: `Delete 12 Variables from the file?`, one row each, **layer counts summed and referrer counts aggregated from outside the group** — the same "references within the group don't block" rule as Phase 4 §7. There is no bulk delete from the Changes list; that list is about states, and deletion isn't one.

#### Afterwards

The Variable is gone, so the token's provenance now points at nothing. That is precisely Phase 4's `orphaned-edit` shape, and the token lands in the same pinned *orphaned* section on the next scan — **unless** the local token was deleted too. So the confirmation carries one checkbox, checked by default:

> ☑ Also remove the token from the local tree

Unchecking it is legitimate (keep the token, re-create the Variable later) but it's the unusual choice, and leaving it checked is what stops a Figma deletion from generating an orphan the user then has to clean up by hand.

---

## 6. B. Changed in Figma (drift)

### 6.1 How the user finds out

**By rescanning.** There is no background watcher and no live drift badge, because there's no cheap way to know without reading the file, and a stale "in sync" claim is worse than no claim. Rescan already exists (Phase 4 §5.5), already does a three-way comparison against the recorded base, and already reports its results in a banner. Drift falls out of the same comparison — the cell of §3's table where Figma moved and you didn't.

So the Phase 4 post-scan banner just gains a count:

> **7 edits reapplied · 3 changed in Figma · 2 conflicts · 1 orphaned**  `[ Review ]`  `[ Dismiss ]`

`[ Review ]` behaves exactly as it does today: it sets the `⚑` chip to the relevant kinds so the tree filters to the rows needing a decision. No wizard, no per-token prompt during the scan.

**Staleness is stated, not hidden.** The Tokens tab header carries a quiet line — *"Scanned 12 minutes ago · Rescan"* — so the absence of drift badges reads as "we last checked 12 minutes ago", not as a live guarantee. Anything stronger would be a promise the architecture doesn't make. **[ARCH]** If the ADR lands a cheap change-detection path (a variable-modified timestamp, a document-change subscription), this becomes a passive nudge — *"Figma has changed since your last scan · Rescan"* — and that's a strictly better design. §9.5.

### 6.2 Where it shows in the tree

*Shyam, 2026-09-02 (§9.11): reuse Phase 4's `⚑` flagged-chip pattern. No new glyph, no new colour, no dedicated drift tab. Consistency with the existing pattern wins.*

**On the value line, as `⚑ changed`**, in the existing `.badge.needs` amber — the same `⚑` badge Phase 4 already puts on `collision`, `dangling-reference`, `partial-token`, `edit-conflict` and `orphaned-edit`. Not a new colour and not a new mark: Phase 4's rule holds that there is no third badge colour, and "changed in Figma" is the same *needs you* the report already speaks.

The alternatives were a distinct drift glyph (a sync arrow, say) and a dedicated Drift tab, and both were rejected for the same reason. A second attention mark trains the user to parse two vocabularies at a glance in a 460 px column, which is exactly the failure the single `⚑` was designed to avoid — and a tab would split "things needing my attention" across two places, so that no single screen ever answers *what needs me?*. Drift is not a different kind of alert; it is one more report kind, and it inherits everything that already works for the others:

- the **`⚑ N flagged` filter chip** counts it (Phase 4 §4.6) — filtering to flagged surfaces drifted lines alongside conflicts, which is the right grouping, because "rows needing a decision" is the actual task;
- **group rows roll it up**, exactly as they do for flags today;
- the **post-scan banner's `[ Review ]`** sets that same chip (§6.1);
- it lands on the **value line, not the path**, like every other flag.

The value preview on a drifted line keeps showing the **token's** value, with Figma's value on a muted second line only when the line is expanded. Rationale: the tree is a view of the token file. It should always show what the tokens say; the badge is what says Figma disagrees. Showing Figma's value in the primary slot would make the tree quietly stop being a token browser.

```
■ accent.default
    Light  #c33a2e
    Dark   #f0a19a   ⚑ changed
```

The one thing drift adds to the pattern is the **word next to the flag**. `⚑ changed`, `⚑ conflict`, `⚑ orphaned` share a mark and are told apart by a single lowercase word — which is what makes one badge colour survive five meanings.

### 6.3 The header state slot and the Changes list

Phase 4's header chip read `Local edits · 7`. Phase 5 has up to three counts to report and 100 px to do it in.

**The chip names the state, not the arithmetic:**

| Situation | Chip |
|---|---|
| Nothing anywhere | `● In sync` — **green** (§8), low-emphasis, not styled as a button but still tappable, opening an empty Changes list |
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
| **Re-apply token** | Writes the token's value into Figma. A canvas write, so it routes through the apply dialog (§5.2). | In sync. Undo is Figma's ⌘Z, not the panel's (§5.5). |
| **Take Figma's** | Updates the token to Figma's value. A local edit, not a canvas write. | Becomes a **local edit** — because the token file now differs from what was last committed. Phase 6 commits it. |

That second row is the subtle one and it deserves a line of copy on the button's confirmation toast: *"Token updated to Figma's value — it's a local edit until you commit it."* Without that, "Take Figma's" reads as "make this go away", and the user is surprised later when the count reappears in the Changes list under a different heading.

`[ View both ]` isn't a separate action — the block *is* the diff, inline, always expanded. At three values or fewer, a comparison this small doesn't earn a screen of its own; composite types (typography, shadow, grid) render the block as a **field-level list with only differing fields shown**, plus *"4 fields unchanged"* collapsed, which keeps a 15-field typography diff to two lines.

Both actions clear the badge, and the asymmetry in what it costs to change your mind is the reason they don't look alike: *Take Figma's* is one tap and reversible in the panel (Phase 4's local undo), while *Re-apply token* is a canvas write, so it opens the apply dialog as a one-row confirmation and afterwards the way back is ⌘Z in Figma.

### 6.5 Bulk resolution — allowed here, and why that's not a contradiction

Phase 4 deliberately refused a global *keep mine / take theirs* for conflicts: across 1,316 tokens the right answer differs per token. That reasoning still holds for **conflicts**, and the Conflicts section of the list keeps per-row actions only.

Drift is different in one specific way: it's usually **systemic**. Someone re-toned a palette in Figma, or a library update rolled in — the answer is the same for all 40 tokens and forcing 40 taps is contempt. So the Changes list allows bulk, with three guardrails:

1. **Checkboxes, unchecked by default.** The user selects the scope; there is never an "accept all" that operates on rows they haven't looked at.
2. **The list is the scope.** Filters and search apply to it, so "take Figma's for everything in `Theme/Dark`" is: filter, select all visible, act. The button counts the checked rows, always.
3. **Re-apply in bulk routes through the apply dialog** (§5.2) rather than writing directly, because it's a canvas write and canvas writes get the dialog. *Take Figma's* in bulk doesn't — it's a local edit, fully undoable, and Phase 4 already treats local edits as cheap.

### 6.6 Drift on a token that also has a local edit

That's a **conflict**, and it's Phase 4's `edit-conflict` unchanged — same badge, same block, same *Keep mine / Take Figma's*, same rebase-on-resolve behaviour. Phase 5 adds exactly one thing to it: *Keep mine* gains a companion action **`Keep mine and apply`**, which resolves the conflict *and* pushes the value to Figma in one go, since "mine is right, make Figma agree" is the obvious next thought and Phase 4 had no way to finish it.

---

## 7. Empty and error states

### Empty states

| When | Copy |
|---|---|
| Changes list, nothing anywhere | **Everything's in sync.** Your tokens match Figma as of the last scan. *(The only empty state in the panel rendered in green rather than grey — §8.)* |
| Changes list, Changed section empty | **Nothing has changed in Figma** since your last scan. |
| Apply dialog with nothing to do | *(dialog doesn't open)* toast: **Theme / Dark already matches Figma.** |
| Selection bar, nothing selected | *(bar is absent — never an empty bar)* |
| Bind menu, no compatible property | The action is **absent from the `⋯` menu**, not greyed. A `string` token has no layer property; offering a disabled row implies one exists. |

### Error and degraded states

| State | Treatment | Copy |
|---|---|---|
| Apply target deleted in Figma | Blocked row in the dialog; same treatment as Phase 4's `orphaned-edit` | `The Variable this edit changed was deleted in Figma.` `[ Discard edit ]` |
| Token value is a reference | Applied **as a native alias**; the row shows `↗ {…path}` with the resolved value muted beneath | see §5.6 |
| Reference whose target isn't a Figma Variable | Blocked row in the dialog | `Points at a token that isn't a Figma Variable — nothing to alias to.` |
| Reference the alias can't carry (cross-collection, math expression, dangling) | Blocked row, or an unchecked literal-fallback row that says so | `↗ can't be aliased · applying #c33a2e as a literal` — never silent. §5.6 |
| Delete in Figma, tokens still reference the target | Confirmation opens in blocked form: referrer list, no primary button | `7 tokens point at this Variable. Delete or re-point them first.` §5.7 |
| Delete in Figma, layers are bound to the target | Warning inside the confirmation, action still allowed | `Used by 14 layers. They keep their current value but stop following the Variable.` §5.7 |
| Delete in Figma failed | `.entry` block on the confirmation, which stays open | `Couldn't delete — the Variable is still in the file.` |
| Target is a **library Variable/Style** (published from another file — read-only here) | Blocked row, `⚠` | `This Variable comes from a published library and can't be edited from this file. Change it in its source file.` |
| File is read-only (viewer, branch permissions, Dev Mode) | `.entry` block at the top of the Tokens tab, apply actions disabled throughout | `You can't edit this file, so tokens can't be applied. Everything else still works.` |
| Bind: some layers can't take the property | Partial-success toast + `[ Details ]` list with node-selecting rows | `Bound to 3 of 5 layers · Fill. 2 layers can't take a fill.` |
| Bind: **no** selected layer can take the property | Nothing written, `.entry` block near the selection bar | `None of the 5 selected layers can take a fill. Pick a different property or a different selection.` |
| Bind: a selected layer is locked | Counted as skipped, named in `[ Details ]` | `Locked — unlock it to bind.` |
| Bind: token type has no bindable property | Action absent (see empty states) | — |
| Apply partially failed mid-batch | Toast reports what landed; dialog reopens with the failed rows still checked | `Applied 5 of 7. 2 failed — they're still listed here.` |
| Apply failed entirely | `.entry` block; nothing was written, so nothing to take back | `Couldn't apply — nothing changed in Figma.` + the underlying reason |
| Rescan finds drift | Existing post-scan banner, count added | see §6.1 |
| Drift on a composite type | Field-level comparison, unchanged fields collapsed | `4 fields unchanged` |
| Two sets disagree on `$type` at one path | Unchanged from Phase 4 — per-line glyphs, no badge. Apply operates per line regardless. | — |

**Circular references and math errors are still not a Phase 5 state.** Phase 5 can't author or edit a reference any more than Phase 4 could. Don't build cycle detection here.

---

## 8. Visual language — two new colours, tightly fenced

Everything in Phase 5 maps onto vocabulary that already exists:

- `⚑ changed` is `.badge.needs` — the **same amber** as `flagged`, `conflict`, `orphaned`. Phase 4 banned a third badge colour and Phase 5 does not get an exemption. "Changed in Figma" is not more urgent than a conflict, it's the same *needs you*.
- The **comparison block** (§6.4) is the `edit-conflict` block with one fewer row. One component, two callers.
- The **apply dialog** reuses the local-edits list's row shape inside a new, deliberately small container (§5.2). It is the one place Phase 5 adds a modal, and the exemption is argued there.
- The **toast** is the existing toast — but for canvas writes it is **report only, no action button** (§5.5). The `[ Undo ]` affordance stays on the local-edit toasts it already serves.
- `.entry` (amber left border) carries every blocking error, as it does today.
- The **header state slot** keeps its role: *what state is my work in*. Phase 4's chip was its first occupant; Phase 5's is its second; Phase 6's sync pill is its third.

Four genuinely new pieces:

1. **A destructive red** — for `[ Delete Variable ]` (§5.7) and the `Delete in Figma…` menu label, and **nowhere else**. The rule that matters: it is a **button and menu-label colour, not a state colour**. Phase 4 banned a third *badge* colour and that ban is intact — nothing in a row or a banner turns red. Red in this panel means exactly one thing: *this control destroys something in the file, and no second apply brings it back.* If a second control ever wants it, that's a sign the second control needs the §5.7 treatment too, not that the palette should grow. `[ Cancel ]` beside it stays a plain text button — no competing fill, so the destructive button is the only thing with weight on that screen and it can't be hit by muscle memory aiming at a primary blue.

2. **The selection bar** — pinned bottom, one line, appears and disappears with the canvas selection. It's the only piece of chrome in the plugin that reacts to the canvas, so it should be visually quiet: same background as the header, a top border, no accent fill. It must not animate in and out; at this size, a bar that slides is a bar that's in your way.
3. **The apply dialog's modal container** — the panel's first dimmed backdrop. One card, one decision, three ways out. §5.2 argues why a confirmation earns what an editor didn't.

4. **A green for `In sync`.** *Shyam, 2026-09-02 (§9.6): yes — add it, placement and shade my call.*

#### The green, and the status colour language it completes

`In sync` is the first genuinely *good* state the panel has ever had. Rendering it in the same grey as everything else spends the one moment the user gets confirmation on nothing. With it, the panel finally has a complete four-value colour language, and each colour answers one question:

| Colour | Means | Where it appears |
|---|---|---|
| **Grey** | Neutral information. Not a state. | Set codes, subtype tags, muted second lines, `already matches` rows |
| **Green** | Agreed. Token and Figma match as of the last scan; nothing to do. | Below |
| **Amber** (`.badge.needs`) | Needs you. Flagged, changed in Figma, conflict, orphaned. | Badges, `.entry` blocks, the header chip when counts are non-zero |
| **Red** | This control destroys something. | `[ Delete Variable ]` and `Delete in Figma…` only (§8.1 above) |

**Where the green goes** — three places, and the list is closed:

1. **The header chip, `● In sync`** — a filled dot plus the words, in green, replacing Phase 4's muted grey. This is the primary home: it is the answer to *what state is my work in*, and "none, you're clean" deserves to look different from "we haven't checked".
2. **The detail overlay's per-set section** — a green `● In sync` line where a drifted or edited set shows its comparison block. This is the per-token green Shyam asked for, and the overlay is the right place for it: it is where the user has already asked a question about one specific token, so an answer is warranted and there is room to give it.
3. **The apply dialog's `already matches` rows** (§5.3) — the checkbox slot renders a green `●` instead of an empty box. Those rows exist to say *this part is fine*; green says it in the same glance as the count.

**Where it explicitly does not go** — and this is the load-bearing half of the decision:

- **Not on tree rows or value lines.** 1,316 tokens, the overwhelming majority in sync: a green dot on every line is a wall of green that means nothing, drowns the ~15 amber badges that *do* mean something, and burns the panel's scarcest resource — horizontal space in a 460 px column. **In the tree, in-sync is signalled by the absence of a badge**, exactly as it is today. That is not a compromise; a clean row already reads as clean, and adding a mark to say so makes the flagged rows harder to find, not easier.
- **Not on group rows**, for the same reason at one level up.
- **Not as a `.badge` variant.** Phase 4's "no third badge colour" rule was about competing calls for attention, and it stands. Green here is a *confirmation* colour, not an attention colour — which is exactly why it belongs on a chip, a section header, and a checkbox slot, and nowhere a badge would go.

**Shade.** A muted, desaturated success green — roughly the amber's counterpart in weight, not a saturated "success toast" green. It reads at 11 px on both the panel's light and dark backgrounds, it never appears as a fill (text and dot only, no green pills, no green buttons), and the primary action button stays blue. The concrete value is `@frontend-engineer`'s to pick against the existing amber token; the constraint is *quieter than the amber it sits beside*, since a confirmation must never out-shout a warning.

**One consequence for §6.3's chip table:** the `In sync` row there says *muted, not a button — but still tappable*. That still holds, with one change — it is now green rather than muted grey, and it stays a low-emphasis element. Green is the reward for a clean state, not an invitation to go press something.

---

## 9. Questions — decided and still open

**Still open after the 2026-09-02 pass: three, and all three are `[ARCH]` rather than taste** — §9.2 (does apply create missing Variables/Styles), §9.5 (passive change detection), §9.9 ("Take Figma's" in bulk). Everything else below is closed; the numbering is kept so earlier references still resolve.

1. ~~**How much ceremony should the apply dialog have?** Options: (a) always; (b) dialog for multi-target, direct write for a single token; (c) a "don't confirm single tokens" toggle.~~
   **Resolved 2026-09-02 — Shyam: always confirm, no shortcut.** Option (a). §5.2 now states it as an invariant rather than a default: no code path writes to Figma without the dialog, including single-token applies, drift re-applies (§6.4), and bulk re-applies (§6.5). The "don't ask again" idea is off the table, not deferred.
2. **Should Phase 5 create Variables/Styles that don't exist yet, or only update existing ones?** §2 assumes update-only, which is currently free — with token creation deferred and no git pull yet, every token has a target. It stops being free the moment Phase 6 pulls a token file from the repo. Worth deciding now whether "apply creates what's missing" is Phase 5's problem or Phase 6's. **[ARCH]** — needs the tech-lead's read too.
3. ~~**Undo for canvas writes: ours, Figma's, or both?** §5.5 ships our own 10-second undo.~~
   **Resolved 2026-09-02 — Shyam: Figma's ⌘Z only. No custom in-plugin undo/redo for applied changes.** §5.5 is rewritten around it: no `[ Undo ]` on the apply or bind toasts, no pre-write value cache kept for undo, and one quiet line in the apply dialog's footer — *"⌘Z in Figma is the only undo."* Phase 4's local undo is untouched and still covers edits, deletes and *Take Figma's*, because those never leave the token tree.
   **Not blocked on the ADR.** ADR-0005's open technical question — whether a plugin's writes coalesce into one Figma undo step — is `@frontend-engineer`'s to verify at build time, and it changes only the *wording* of that footer line (see the note at the end of §5.5), never the decision. The copy is written to be true either way, precisely so it doesn't depend on an answer we don't have. **Do not design a plugin-side undo as a hedge against the answer being "no".**
4. ~~**Can a reference-valued token be applied as a native Figma Variable alias?** §5.6 blocks it and points at Phase 7.~~
   **Resolved 2026-09-02 — Shyam: preserve the pointer, don't flatten it.** §5.6 is rewritten around native aliases: the apply row shows `↗ {…path}` with the resolved value muted beneath, cases the alias can't carry are blocked or explicitly labelled as flattening (never silent), and drift gains a pointer-diff reading with `(alias removed)` / `(now aliased)` copy. **Still needs one review pass:** `@tech-lead` is assessing feasibility in ADR-0005 in parallel. If native aliasing lands only partly, the fallback is the original §5.6 — reference rows blocked with Phase 4 §5.3's wording. The fallback is *block*, never *flatten silently*.
   **Display confirmed 2026-09-02 (second pass) — Shyam: keep it exactly as drafted.** The pointer is the primary value (`→ {color.blue.500}` / `↗ {…palette.red-warm.50}`), with the resolved colour in small grey text beneath it. No change; §5.6's rendering is final, and only its *feasibility* is still pending ADR-0005.
5. **Is scan-time drift detection enough, or does the panel need to notice on its own?** §6.1 ships scan-only with a "scanned 12 minutes ago" staleness line. If a cheap change signal exists, a passive *"Figma has changed — rescan"* nudge is strictly better and costs one line of chrome. **[ARCH]**
6. ~~**A green for `In sync`?** §8 wants one colour used in exactly one place.~~
   **Resolved 2026-09-02 — Shyam: add it; placement and shade the designer's call.** §8 now specifies a muted green in exactly three places — the header chip's `● In sync`, the detail overlay's per-set in-sync line, and the apply dialog's `already matches` rows — and explicitly keeps it **off tree rows**, where in-sync stays signalled by the absence of a badge. That completes the four-value status language: grey neutral, green agreed, amber needs-you, red destructive.
7. **Conflict handling** — *not previously an open question; confirmed 2026-09-02.* Shyam has ratified the proposed model: when both sides moved, the plugin blocks and makes the user pick a side, per token, with both values shown. Phase 4's `edit-conflict` block and its *Keep mine / Take Figma's* pair carry forward unchanged (§3, §6.6); Phase 5 adds only `Keep mine and apply`. No global keep-mine/take-theirs for conflicts — the bulk affordance in §6.5 is for **drift only**, and that asymmetry is intentional and argued there.
8. **Deleting Figma Variables and Styles** — *raised and resolved 2026-09-02.* Allowed, but never bundled into an apply: its own menu item (`Delete in Figma…`), its own confirmation screen with a blast-radius readout, and a red destructive CTA. Blocked outright while other tokens reference the target, matching Phase 4 §7. Fully specified in §5.7; the colour rule is in §8.
   **Copy and placement confirmed 2026-09-02 (second pass) — Shyam: keep it exactly as drafted.** `Delete in Figma…` stays a separate `⋯` menu item below a divider, red destructive label, opening its own confirmation screen with the blast-radius readout. No change to §5.7.
9. **Does "Take Figma's" need a confirmation?** §6.4 makes it a plain local edit, undoable in the panel, no dialog. In bulk (§6.5) it can silently rewrite forty token values. Undo covers it, but "undo covers it" and "the user understood what happened" aren't the same claim. **Still open.**
10. ~~**What surface is the apply preview?** A modal, a persistent tab, or the full Phase 6 diff view.~~
   **Resolved 2026-09-02 — Shyam: a lightweight modal/popup.** Not a persistent tab, not a full-panel screen, not the Phase 6 diff view. §5.2 is rebuilt around a modal card over a dimmed tree: `✕` instead of a back arrow, a two-line header, the list scrolling inside the card, a footer that never scrolls, and three free ways out (`Cancel`, `Esc`, backdrop). The weight budget is set by the "always confirm" rule from §9.1 — the user sees this every single time, so every control in it is paid for a thousand times over.
11. ~~**How is drift indicated in the tree?** A new icon, a dedicated tab, or the existing flag pattern.~~
   **Resolved 2026-09-02 — Shyam: reuse Phase 4's `⚑` flagged-chip pattern.** Consistency with the existing pattern wins over a bespoke drift signal. §6.2 spells out what that inherits — the `⚑ N flagged` filter chip counts drift, group rows roll it up, the post-scan banner's `[ Review ]` filters to it, and it attaches to the value line — and why the two alternatives lost: a second attention glyph forces the user to parse two vocabularies in a 460 px column, and a dedicated tab splits *what needs me?* across two screens.

---

## 10. Build notes for `@frontend-engineer`

- **Read the Phase 5 ADR first.** This doc specifies how states *read*; the ADR owns write mechanics, batching, the drift comparison basis, and conflict semantics. Where they disagree, the ADR wins and this doc gets amended.
- **Apply, bind, and delete-in-Figma are three separate code paths and three separate messages.** They share nothing but a verb in casual speech. Don't unify them behind one `apply(target)`, and specifically **don't let a delete become an op in the apply batch** — §5.7 explains why the dialog's pre-checked rows make that unsafe.
- **The apply dialog is an invariant, not a default.** One entry point to the write, and it is reached only from a confirmed dialog (§5.2). Assert it if that's cheap.
- **Aliasing is written against ADR-0005 before ADR-0005 exists.** §5.6 assumes native Figma aliases are available on apply. Check the ADR first; if aliasing is out or partial, fall back to blocking reference rows — never to flattening them silently.
- **No plugin-side undo for anything that touches the file** (§5.5, §9.3). No `[ Undo ]` on the apply, bind, or delete toasts. Phase 4's local undo stays exactly as it is for tree-only actions (edit, delete token, *Take Figma's*) — don't refactor the two together into one undo stack; they have different scopes on purpose.
- **Verify Figma's undo coalescing, then fix one line of copy.** Whether a batch of plugin writes collapses into a single ⌘Z step is ADR-0005's open question and yours to settle empirically. It changes only the apply dialog's footer wording (§5.5's closing note) — *never* the decision to have no plugin undo. Report what you find so the copy can be sharpened or qualified.
- **The apply dialog is a modal, and the first one in the panel.** Backdrop dims the tree, card sized to content and capped at ~⅔ panel height, list scrolls inside, footer pinned. `Esc` and backdrop-tap dismiss identically to `Cancel`, and dismissing discards checkbox state rather than remembering it.
- **Everything is keyed to `{ path, setId }` → provenance**, exactly as in Phase 4. The merged row stays a display construct; apply resolves through `figma.variableId + modeId` / `figma.styleId`, never through the path.
- **Read the pre-write value for every target you touch, but you no longer need to *keep* it.** It's what fills the dialog's `before` column and what partial-failure reporting compares against; with no plugin-side undo, nothing has to survive past the write's completion.
- **The apply dialog's row component is Phase 6's diff row.** Build it as `{ target, before, after, state }` and keep it out of Phase 5-specific modules.
- **Drift is computed by the scan comparison, not by a second mechanism.** It should fall out of the same three-way merge that already produces `edit-conflict` and `orphaned-edit` — as a fourth report kind, not a parallel system.
- **The selection bar needs `selectionchange`, and needs to be cheap.** It runs on every canvas click. Compute node kinds and valid properties from the selection summary, not by walking each node's full property set.
- **Never write on selection change.** The bar is a readout; only an explicit tap binds.
- **Preserve `$extensions."com.tokenvault"` byte-for-byte through every apply and drift-resolution path.** ADR-0002 §7's byte-identical re-import guarantee is exactly as fragile here as it was in Phase 4, and *Take Figma's* is a new way to break it — it must write only `$value`, never rebuild the token.
- **Reuse `.badge.needs` and the conflict block.** Drift is `⚑ changed` in the existing amber badge (§6.2) — no new glyph, no new badge class, no drift tab. If Phase 5 introduces a third badge colour or a second comparison component, something has gone wrong in the translation from this doc.
- **The two new colours are not badge colours.** Red is a button/menu-label class used by §5.7's CTA and menu item and nothing else. Green is a text/dot class used in exactly three places (§8): the header chip's `In sync`, the detail overlay's per-set in-sync line, and the apply dialog's `already matches` rows. **Never put green on a tree row or a value line** — in the tree, in-sync is the absence of a badge.
- **The delete confirmation needs two counts before it can render**: layers bound to the target (a Figma query) and tokens referencing it (Phase 4's inbound-reference index, already built). Don't open the screen with placeholder counts — the counts *are* the screen.
- Section 2's out-of-scope table is the scope boundary. If a task starts needing reference resolution, mode composition, Variable creation, or a git write, stop and raise it.
