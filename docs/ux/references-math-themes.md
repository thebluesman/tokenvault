# UX: References, math, and themes (Phase 7)

**Status:** Implemented 2026-09-03 — shipped in Phase 7. Written ahead of the build against ADR-0007 (Accepted 2026-09-03). **All four of §11's questions were resolved by Shyam on 2026-09-03, each confirming the recommendation as written**, so nothing in this doc is provisional any more. This is the live Phase 7 spec: amend it when the design changes, and move it to *Implemented* when the phase ships. ADR-0007's open question 1 (what live theme switching targets) is **settled at build time in favour of the current page**, and not by preference: `setExplicitVariableModeForCollection` lives on `ExplicitVariableModesMixin`, which `PageNode` extends and `DocumentNode` does **not**, so there is no document-root equivalent to choose instead. §8.4's control ships exactly as drawn, label included.
**Owner:** `@ux-designer`
**Covers:** PRD §6.2 (themes), §6.3 (aliasing, math expressions, circular-reference detection), §6.7 (plugin panel), build plan §9 Phase 7.
**Builds on:** `docs/ux/local-editor.md` (Phase 4), `docs/ux/apply-and-drift.md` (Phase 5), `docs/ux/git-sync.md` (Phase 6) — same panel, same 460 × 640 px, same vocabulary. Read those first; this doc extends them and does not restate them.
**Depends on:** ADR-0007 (`docs/adr/0007-themes-aliasing-and-math.md`) — **Accepted 2026-09-03**. Where this doc and the ADR disagree, the ADR wins and this doc gets amended.
**Amends:** `docs/ux/local-editor.md` §5.3 (reference values read-only) — Phase 7 lifts it, exactly as that section said Phase 7 would. §12 states the replacement in full.
**Resolves for the ADR:** ADR-0007 §4 handed `@ux-designer` one question — *does the editor steer users toward a reference over an expression, given the live-link loss?* Answered in §6.5: **yes, but in exactly one case**, and never as a standing warning.

---

## 1. What we're designing against

Phases 4, 5 and 6 all shipped the same sentence in different words: *the panel renders a reference, badges it, and refuses to edit it.* Phase 7 deletes that sentence, and three things become true the moment it goes.

| New fact | Source | What it forces |
|---|---|---|
| **The user can now author a pointer, and therefore a broken pointer.** Every `dangling-reference` in the tree today was found by the importer. | ADR-0007 §5 | Validation has to happen where the user is typing, not as a skipped apply row days later. Four rules, three of which refuse and one of which warns. §5. |
| **The user can now author a loop.** Phases 4–6 all said, correctly, that a cycle was unreachable. | ADR-0007 §3 | PRD §6.3's circular-reference error state finally has to be designed, and the thing in the error state is **the loop**, not the token that closed it. §7 is the answer, and it is the piece of this design most worth arguing about. |
| **A token's displayed value now depends on which theme is active.** Resolution has always been theme-scoped by construction; Phase 7 is the first phase where that is visible. | ADR-0002 §2 via ADR-0007 §7 | The panel needs a lens control that says what values are resolving against — and it needs to say it without becoming a fourth verb that writes to the file. §8. |

And one constraint that shapes more of this doc than anything else:

**An expression is not a reference, and the difference is invisible on the canvas and enormous over time.** `{a}` applies as a native Figma alias and follows `a` forever; `{a} * 2` applies as a flat number and goes stale the moment `a` moves. Both are one string in one field. Making that legible without nagging is §6.

Constraints carried forward and still load-bearing: 1,316 tokens, 11 sets, 460 px wide; every token has `figma` provenance; **Apply** is the only verb that writes to the canvas and **Commit** the only one that writes to the repo; there is no plugin-side undo for anything that touches the file; there is no third badge colour.

---

## 2. Scope

### In scope (Phase 7)

Authoring a reference or a math expression as a token's value, in the same field a literal goes in (§4); path autocomplete over the merged tree (§4.2); the four authoring rules and how each reads (§5); expression preview, apply rendering, and the one place the editor steers toward a reference instead (§6); the circular-reference error state, at authoring time and in the tree (§7); a **read-only theme selector** that scopes resolution in the panel, plus a separate deliberate action that switches the Figma canvas to that theme (§8); and honest copy for the file shapes that get no themes at all (§8.5).

### Explicitly out of scope

| Not this phase | Where it lives | What that means here |
|---|---|---|
| **Theme composition editing** — create, rename, delete a theme, or change its sets | Deferred by Shyam 2026-09-03; designed in ADR-0007 §7b, unbuilt | The theme control is a **picker, not an editor**. No `[ New theme ]`, no set checkboxes inside it, no rename. The dropdown lists a theme's sets **read-only**, because seeing what you're resolving against is the whole point of the control. §8.2. |
| **Files that get no themes at all** (2+ multi-mode collections — ADR-0002 §6's `ambiguous` entry, undischarged) | Same deferral | Not hidden. The theme control stays present and explains itself rather than disappearing. §8.5 is the entire design for this, and it is the section most likely to be quietly dropped in a build. |
| Sub-key references on composites — setting a typography token's `fontSize` to `{a}` | ADR-0007 §10, its own ticket | Composite editors keep Phase 4's behaviour: `boundVariables` are **displayed** as `fontSize → {…}` and the numeric fields take numbers only. §12 has the one line of copy that keeps this from reading as a bug. |
| Token creation and path rename | Still ADR-0004's open questions | So a reference can only ever point at a path that already exists, which is what makes §5's rule 1 a refusal rather than an offer to create. |
| Color math, functions, percentages, units in expressions | ADR-0007 §10 | `lighten()`, `round()`, `50%`, `4px * 2` are all parse errors with their own copy. §6.4. |
| Applying one token across every mode | ADR-0007 §7 | Apply stays single-mode. Switching themes on the canvas is not an apply and never routes through the apply dialog. §8.4. |
| Style Dictionary export, and whether it evaluates expressions | Phase 8 | Nothing in the panel promises anything about what an expression becomes in exported code. |

---

## 3. Screen inventory

Phase 7 adds **no tab, no modal, no new colour, and no new badge colour.** It adds one popover, one block, one chip, and one line under an existing field.

```
Tokens tab (Phases 4–6)                          new in Phase 7
┌──────────────────────────────────────────┐
│ ⌕ Filter tokens                          │
│ [Theme: Light ▾][All sets ▾][⚑ 12][● 4] │  ← A. Theme chip (§8.1)
├──────────────────────────────────────────┤     leftmost, before the set filter
│ ▾ folio                                  │
│   ■ accent.default                       │
│       Light  {…palette.red-warm.50} ↗    │
│   ■ space.button                         │
│       Base   {…spacing.4} * 2            │  ← C. expression on a value line
│               = 32                       │     (§6.3)
│   ■ space.a                    — ⚑ cycle │  ← D. cycle rows carry no value
└──────────────────────────────────────────┘     at all (§7.3)
     │ tap value           │ tap ⚑ cycle
     ▼                     ▼
┌──────────────────────────┐  ┌─────────────────────────────┐
│ Value [{core.spac…     ] │  │ ⚑ These tokens point in a   │  D. Cycle block
│  ┌─ B. path picker ────┐ │  │   loop                      │     (§7.2) — same
│  │ number — can be used│ │  │   space.a → space.b          │     block in the
│  │  core.spacing.4   8 │ │  │   space.b → space.c          │     field, in the
│  │  core.spacing.8  16 │ │  │   space.c → space.a  ↵       │     overlay, and in
│  │ other types         │ │  │   Any one of these can be    │     the apply dialog
│  │  color.accent   ■   │ │  │   edited to break it.        │
│  └─────────────────────┘ │  └─────────────────────────────┘
│ = 32 · applies as a      │
│   number, not a link     │  ← E. resolve line (§6.2)
└──────────────────────────┘

[Theme: Light ▾] ──▶ ┌──────────────────────────────┐
                     │ ✓ Light            on canvas │  A. Theme popover
                     │   Dark                       │     (§8.2) — a picker,
                     │   Brand                      │     not an editor
                     │ ──────────────────────────── │
                     │ Light resolves through:      │
                     │   Base · Theme/Light · Text  │
                     │ [ Show only these sets ]     │
                     │ [ Switch this page to Light ]│  ← the only thing here
                     └──────────────────────────────┘     that touches the file (§8.4)
```

Header state slot, extended once: `2 cycles` joins the left half's vocabulary, at a new precedence rung. §9.

---

## 4. A. Authoring a value — one field, three shapes

### 4.1 No mode switch

`local-editor.md` §5.2 made the text field the source of truth for `color` (hex in, swatch beside it) and for `number`. Phase 7 keeps exactly that field and widens what it accepts. **There is no reference/literal/expression toggle**, and that is the load-bearing decision of this section.

A mode switch would ask the user to classify their value *before* typing it, when the parser classifies it perfectly well *after* — ADR-0007 §1 pins three shapes distinguished at recognition time, and a UI toggle would be a second, hand-maintained classifier that can disagree with the first. It also breaks the most common real edit: pasting `{folio.ref.palette.red-warm.50}` over a hex value, which under a toggle is *switch mode, then paste*, and under one field is *paste*.

Tokens Studio does the same thing — one input, `{` triggers suggestions — and here the baseline is right. Where we diverge is *when* it validates: Tokens Studio accepts a bad path and lets it surface later as a broken swatch; we refuse three of the four failures at commit (§5), because the moment the user can fix it cheaply is the moment they are looking at it.

**Per-type consequences**, extending Phase 4 §5.2's table rather than replacing it:

| `$type` | What changes in Phase 7 |
|---|---|
| `number` | The field accepts a literal, a reference, or an expression. The subtype dropdown is unaffected — a reference does not inherit its target's subtype, and the field beside it keeps saying what this token is tagged as. |
| `color` | The field accepts a literal or a **whole-value reference**. Not an expression (ADR-0007 §1: operands must be numbers). While the value is a reference, the native `<input type="color">` swatch is **inert and shows the resolved colour**, not editable — clicking it does nothing except focus the text field, because a colour picker that silently converts a pointer into a hex value is the exact silent flattening §6 exists to prevent. It renders that resolved colour at **full opacity with a solid border, identical to a literal's swatch** — see the 2026-09-04 amendment at `local-editor.md` §4.5. |
| `boolean`, `string` | Whole-value reference or literal. The boolean's segmented control gains a third, non-selectable readout position when the value is a reference; picking `true` or `false` replaces the reference, and that is a deliberate two-tap action, not a stray one. |
| `typography`, `shadow`, `grid` | **Unchanged.** Composite sub-keys are ADR-0007 §10's deferral. The fields take literals. §12 carries the copy. |

### 4.2 The path picker

Typing `{` in the value field opens an inline popover over the merged path index — the same `normalizePathKey`'d index the tree renders from (Phase 4 §11), so autocomplete and collision detection agree about what "the same path" means.

```
┌─ Value ─────────────────────────────────┐
│ {core.spa                               │
├─────────────────────────────────────────┤
│ number — can be used here               │
│   folio.core.spacing.4              8   │
│   folio.core.spacing.8             16   │
│   folio.core.spacing.space-2       12   │
│ ─────────────────────────────────────── │
│ other types — can't be used here        │
│   folio.core.space-scale.label   "sm"   │
│ ─────────────────────────────────────── │
│ would make a loop                       │
│   folio.space.button               32   │
└─────────────────────────────────────────┘
```

Five decisions:

- **Two groups, and the incompatible one is shown rather than filtered out.** Hiding a path the user knows exists produces *"why can't I find my token"*, which is a worse five seconds than seeing it greyed with its type beside it. The greyed rows are not selectable; picking one is impossible, so rule 2 (§5) never has to fire from the picker — only from a pasted or typed path.
- **A third group for cycle-forming candidates**, computed with ADR-0007 §3's editor-scoped check over the edited token's reachable set. It is cheap precisely because it is scoped, and it turns the most confusing refusal in the phase into a thing you simply can't tap.
- **Resolved values on the right, in the tree's own preview vocabulary** — swatch for colour, number for number, `Urbanist 20/24 · 500` for typography. Choosing a reference is choosing a value, and a list of bare paths makes the user guess which `spacing.4` they mean. Values resolve against the **active theme** (§8) and the picker says so in its footer when more than one theme exists: *"Values shown for Light."*
- **Matching is substring over the full dotted path, case-insensitive** — Phase 4 §4.6's rule, not a second one. Paths this structured make fuzzy matching noise.
- **The picker is a convenience, never a gate.** Typing or pasting a full path without ever opening it commits identically, and Escape closes the popover without closing the field. Nothing here is only reachable by mouse.

### 4.3 Going back to a literal

When the committed value is a reference, the editor offers one action beneath the field: **`Use the resolved value instead`**, which replaces the field's contents with `#c33a2e` (or `8`) and leaves it uncommitted so the user can see what they're about to do. Phase 4 §5.3 deliberately withheld this escape hatch because it was an aliasing decision; Phase 7 is where that decision gets made, and the answer is that breaking a link on purpose is a legitimate thing to want, as long as it is a named action rather than the accidental result of clicking a swatch (§4.1).

It is worded as *use the resolved value*, not *break the link* — the user is choosing what they want, not vandalising something.

---

## 5. B. The four rules, and how each one reads

ADR-0007 §5 pins the rules. This section pins their surface. All four run when the field is **committed** (Enter or blur), not per keystroke — a half-typed path is not an error, and amber that appears on the third character trains people to ignore amber.

| # | Rule | Outcome | Where it shows |
|---|---|---|---|
| 1 | Target must exist | **Refuse.** Field stays open, value not committed | Amber message below the field |
| 2 | Types must match | **Refuse.** Same | Amber message below the field |
| 3 | No cycle | **Refuse.** Same | The cycle block, §7 |
| 4 | Resolvable in every theme | **Warn, and commit anyway** | Grey note below the field, then `⚑ unresolved` on the value line |

Three refusals and one warning is not an inconsistency, and the difference is worth stating in the doc because it will look like one: **rules 1–3 describe values that cannot be right in any theme; rule 4 describes a value that is right in the theme you are working in and absent in another.** Refusing rule 4 would make theme-specific tokens impossible, which would make the theme feature and the reference feature mutually exclusive (ADR-0007's own words).

### 5.1 Rule 1 — no such token

> **No token at `folio.core.spacng.4`.** Nothing in any set has that path. `[ Search for "spacng" ]`

The search action drops the query into the tree's filter behind the still-open field, because the overwhelmingly common cause is a typo in a six-segment path and the fastest fix is seeing the real one. There is deliberately **no `[ Create it ]`** — creation is out of scope (§2) and offering it here would be the first place in the product that pretends a token can be authored from nothing.

The asymmetry with import is deliberate and worth not "fixing" later: a **pulled or scanned** dangling reference is still reported and displayed, never refused (ADR-0007 §5). Refusing a value the user is typing costs one correction; refusing a value that arrived from their repo would mean refusing to show them their own file.

### 5.2 Rule 2 — wrong type

> **`folio.core.spacing.4` is a number.** This token is a color, so it can't point there.

Named both ways round in one sentence, because "type mismatch" alone makes the user go and look up which is which. Inside an expression the copy narrows to the operand:

> **`folio.color.accent` is a color.** Expressions only work with numbers.

### 5.3 Rule 3 — a loop

Its own section, §7.

### 5.4 Rule 4 — fine here, missing elsewhere

Committed, then a grey note under the field and a badge on the row:

> Committed. `folio.brand.accent` isn't in **Dark** or **Brand**, so this token has no value there.

Grey, not amber, at the moment of authoring — the user just did a legitimate thing and nothing needs them. The **row** badge is `⚑ unresolved` in the standing amber, because by the time you meet it in the tree you have lost the context that made it deliberate, and Phase 4's rule holds that `⚑` means *needs you, eventually*.

**The badge is theme-sensitive and that is the point.** Switch the panel to `Dark` (§8) and the same value line renders `—  ⚑ unresolved`, with no number, no zero and no last-good value (ADR-0007 §3). The token genuinely has no value in that theme, and inventing one would be the single worst thing this feature could do.

The overlay's per-set section spells out which themes:

```
┌──────────────────────────────────────────────┐
│ ⚑ No value in some themes                    │
│   Points at  ↗ {folio.brand.accent}          │
│   Resolves in   Light                        │
│   Missing in    Dark, Brand                  │
│   Nothing is broken — this token just has no │
│   value when those themes are active.        │
└──────────────────────────────────────────────┘
```

*"Nothing is broken"* earns its line. Every other amber badge in this panel means something went wrong; this one can mean the design is correct.

---

## 6. C. Math expressions

### 6.1 The same field, again

`{core.spacing.4} * 2` goes in the field a literal goes in (§4.1). The picker still fires on `{`, mid-expression, and inserts at the caret rather than replacing the field — which is the only mechanical thing expressions add to §4.2.

### 6.2 The resolve line

One muted line beneath the field, live while typing, for **every** non-literal value. It is the phase's smallest component and does most of its work.

| Value in the field | Resolve line |
|---|---|
| `{core.spacing.4}` | `= 8 · follows folio.core.spacing.4 in Figma` |
| `{core.spacing.4} * 2` | `= 32 · applies as a number, not a link` |
| `({a} + {b}) / 2` | `= 12 · applies as a number, not a link` |
| `#c33a2e` | *(absent — a literal needs no second line)* |
| `{core.spacing.4} * ` | *(absent while incomplete — not an error yet)* |
| `4px * 2` | amber, §6.4 |

Two halves, and both are deliberate:

- **The number.** ADR-0007 §4 evaluates on display, theme-scoped, never persisted. Seeing `= 32` while typing is the entire reason the feature is usable; without it the user is doing arithmetic in their head to check the tool's arithmetic.
- **The clause after the middot** is where the live-link difference lives, stated as a plain fact in grey rather than as a warning in amber. A reference says what it follows; an expression says what it doesn't. Neither needs the user to do anything, so neither gets an attention colour.

### 6.3 How an expression reads in the tree and in the apply dialog

**On a value line** — expression primary, computed value muted beneath:

```
■ space.button
    Base   {…spacing.4} * 2
             = 32
```

Primary, not the number, for the same reason Phase 5 §6.2 keeps the token's value in the primary slot on a drifted row: **the tree is a view of the token file, and the file holds the string** (ADR-0007 §2). A tree that showed `32` would be showing something that exists nowhere on disk.

Path truncation is Phase 4 §4.5's, from the left, per reference inside the expression.

**There is no new glyph for an expression, and the absence is the signal.** A reference's `↗` is load-bearing — it stops a pointer being mistaken for a colour. What an expression risks being mistaken for is a *link*, so the honest mark is the missing `↗`, plus the `=` line that follows. Adding an `ƒ` or a `∑` would put a third symbol vocabulary in a 460 px column to say something the string's own `* 2` already says.

**In the apply dialog** (Phase 5 §5.2), the row extends §5.6's alias shape by one line:

```
│ Variables · Spacing / Mode 1                 │
│  ☑ space.button                              │
│      16  →  {…spacing.4} * 2                 │
│             = 32 · applied as a number       │
```

The number that lands is on screen before the button is pressed, which is ADR-0007 §4's requirement — *"a user cannot flatten without seeing the number that lands."* The row is **checked by default like any other**; an expression is not a degraded apply and does not get §5.6's unchecked-flattening-fallback treatment, which exists for the different case where a pointer the user wanted *couldn't* be preserved.

### 6.4 Parse and evaluation errors

All of these are amber, below the field, value not committed. Report kind `expression-error` (ADR-0007 §5).

| Input | Copy |
|---|---|
| `4px * 2` | **Units don't go in expressions.** Write `4 * 2` — units get added when tokens are exported, not here. |
| `{a} * ` , `({a} + 2` | **Unfinished expression.** Only fires on commit, never while typing. |
| `{a} % 2`, `{a} > 2` | **`%` isn't something expressions can do.** They handle `+`, `-`, `*`, `/`, brackets, and nothing else. |
| `round({a})`, `lighten({a}, 10%)` | **Expressions can't call functions.** `round`, `min`, `clamp` and colour functions aren't in this version. |
| `{a} / 0` | **Dividing by zero gives no value.** |
| `{color.accent} * 2` | **`folio.color.accent` is a color.** Expressions only work with numbers. *(§5.2, same string.)* |

The unit message names the *reason* rather than just the rule, because "no units" reads as an arbitrary restriction and "units get added at export" is the actual architecture (ADR-0002 §3) and the thing that stops the user working around it by writing `4` and meaning `4rem`.

### 6.5 The steering call — a reference over an expression

**ADR-0007 §4 handed this question here. The answer is: steer in exactly one case, and never as a standing warning.**

**Steer** when the expression is arithmetically a no-op over a single reference — `{a} * 1`, `{a} + 0`, `{a} / 1`, `({a})`, `-(-{a})`. There, and only there, we know for certain a plain reference does the same job strictly better, so the editor commits the value and offers a one-tap fix beside it:

> Committed. `{core.spacing.4} * 1` is the same as `{core.spacing.4}`, and a plain reference keeps a live link in Figma. `[ Use {core.spacing.4} ]`

It offers, it does not refuse and does not rewrite. The user may be mid-edit toward `* 1.5`, and a tool that silently normalises what you typed is a tool you stop trusting with the things it doesn't understand.

**Do not steer** anywhere else. `{a} * 2` has no reference equivalent, so a warning on it would be advising the user against the feature they just deliberately used, a thousand times over. Three arguments, in order of weight:

1. **A warning that has no action is not a warning, it's a mood.** Phase 5 §5.2 rejected dialogs that guard nothing on the grounds that they teach people to click through the ones that do. Amber that appears on every correct use of a feature is the same failure in the badge vocabulary: it makes `⚑` mean *"this is fine, actually"* somewhere, and after that it means nothing anywhere.
2. **The consequence is already stated, in the right place, at the right volume.** §6.2's resolve line says `applies as a number, not a link` in the editor, and §6.3's apply row says `applied as a number` at the moment of the write. That is twice, both times where the user can act on it, neither time as an alarm. A third telling would be nagging and a louder telling would be lying about the severity.
3. **The flattening is inherent to Figma, not a Tokenvault shortfall** (ADR-0007 §4). Warning about it implies we could have done better if the user had been more careful, which is false and which sends people looking for a setting that doesn't exist.

**One escalation, and it isn't a warning about expressions.** A `⚠` **is** warranted where an expression cannot be applied at all — a non-numeric operand that arrived by pull, a division by zero in imported data. Those are `expression-error` rows, blocked in the apply dialog like any other blocked row (Phase 5 §5.2), and they say what's wrong rather than editorialising about formulas.

**What this means concretely for the build:** there is no amber badge, no row decoration, and no dialog anywhere in the panel whose meaning is *"this is an expression"*. The word "expression" appears in grey, in the resolve line, in the apply row, and in the one place §6.6 needs it.

### 6.6 The sticky entry, and why it is not a bug

ADR-0007 §6 amends ADR-0004 §4: an expression's overlay entry **survives an apply** rather than retiring, because Figma stores `32` and the entry holds `{…spacing.4} * 2`, and the entry is the only place that string exists while a file is disconnected.

This surfaces as a permanently non-empty **Local edits** count, which is exactly the shape of a bug. So the Changes list (Phase 5 §6.3) says so, once, above the Local section, only when such an entry exists:

> Expressions stay listed after applying — Figma can only store the number, not the formula.

And each such row carries a grey `expression` tag in place of the usual retirement expectation. `Revert` still works and means what it always meant.

**Connect a repo and this resolves itself**, which is worth the one extra line because it is a real reason to connect one:

> Once this file is connected to a repo, expressions live in the committed JSON and stop counting as uncommitted work.

That is ADR-0006 §2's demotion applied to expressions, and it means the sticky-entry oddity is a disconnected-file condition, not a permanent feature of the product.

---

## 7. D. The circular-reference error state

PRD §6.3 asks for a clear error state. ADR-0007 §3 fixes what is in that state: **the loop, not the token**. This section is the loop's UI, and it is one component rendered in three places.

### 7.1 What a cycle must never do

Stated first because these are the failure modes, and each has a tempting shortcut:

- **No fallback value.** Not zero, not the last good number, not the literal that was there before the reference. A silently wrong number is strictly worse than a visible error, and the entire point of a derived value is that it wasn't typed.
- **No blaming the last edge.** Any token on the loop can be edited to break it, so singling out the one whose commit closed it is arbitrary and sends the user to a token that may be the *least* appropriate place to fix it.
- **No new colour and no new glyph.** `⚑ cycle` in the existing amber, one lowercase word after the flag, exactly as `⚑ changed`, `⚑ conflict` and `⚑ orphaned` (Phase 5 §6.2).

### 7.2 The cycle block

One component, three callers.

```
┌──────────────────────────────────────────────┐
│ ⚑ These tokens point in a loop               │
│                                              │
│   folio.space.a   →  folio.space.b           │
│   folio.space.b   →  folio.space.c           │
│   folio.space.c   →  folio.space.a  ↵        │
│                                              │
│ Nothing in the loop has a value, because     │
│ each one is waiting on the next.             │
│ Editing any one of them breaks it.           │
└──────────────────────────────────────────────┘
```

- **Every path is a tap target** that navigates to that token in the tree, the same way Phase 4 §7's referrer list does. The list is the merged tree's vocabulary, not a second one, so a path in two sets is one entry with its set codes beside it.
- **The `↵` marks the closing edge**, which is the one piece of information that makes three lines read as a loop rather than a chain. It is a shape cue, not a target — there is nothing to do to it.
- **Two sentences, and both are load-bearing.** The first explains why every value in the loop is blank, which pre-empts *"but `space.b` used to be 8"*. The second is the fix, and it deliberately says *any one*, because the user's instinct will be to look for the culprit.
- **A self-reference renders identically with one row**: `folio.space.a → folio.space.a ↵`. Same block, same copy, no special case.
- **The block does not truncate.** A loop is normally 2–4 long, and the case where it is 15 long is exactly the case where the user needs the whole thing.

### 7.3 The three places it appears

**a) At authoring time, and the edit is refused.** The block renders below the value field with the candidate edge shown as it would be, marked `(what you just typed)`:

```
│   folio.space.c   →  folio.space.a  ↵        │
│                      (what you just typed)   │
```

The field stays open with the value in it, so `Escape` reverts and any other edit is one keystroke away. This is the moment ADR-0007 §3 calls *"where PRD §6.3's error state is actually delivered"*, and it is the only one of the three where the user has the whole problem in their head.

**b) In the tree, for a cycle that arrived by scan or pull.** Every token on the loop carries `⚑ cycle` on its **value line**, and its value preview is **`—`** — no number, no swatch, no stale value:

```
■ space.a
    Base   —  ⚑ cycle
```

The detail overlay's per-set section carries the block verbatim. Because the block is identical for every member of the loop, opening any of them shows the same three lines — which is the design saying *the error is the loop* louder than any copy could.

**c) In the apply dialog, as a blocked row.** ADR-0005 §11 already refuses every token on a cycle before the write, widened by ADR-0007 §3 to expression edges. Those rows land in Phase 5 §5.2's blocked-rows section, unchecked and uncheckable, with `[ Show the loop ]` opening the block rather than repeating it inside a list row.

### 7.4 Cycles are theme-scoped

The graph is resolved through the active theme's set stack (ADR-0007 §3), so switching themes can create or clear a cycle. That is correct behaviour and it looks like a glitch, so §8.3 puts one line on it.

---

## 8. E. Themes — a lens in the panel, a deliberate action on the canvas

### 8.1 The chip

A **theme chip in the Tokens tab's filter row, leftmost, before `[ All sets ▾ ]`**:

```
[ Theme: Light ▾ ][ All sets ▾ ][ All types ▾ ][ ⚑ 12 ][ ● 4 ]
```

Three placements were possible and two are wrong:

- **Not the header state slot.** That slot answers *what state is my work in* and has six occupants already fighting over 140 px (Phase 6 §6.1). A theme is not a state — nothing about it needs you, and it never blocks an operation.
- **Not a fourth top-level tab.** Phase 6 §4.1's test is whether it's a place you work. With composition editing out of scope (§2), there is nothing to work on: this is a picker.
- **The filter row, because it is a lens**, and it sits beside the other two lenses. It goes leftmost because it is the widest-reaching of them: the set filter changes *what is listed*, the theme changes *what every listed value means*.

**Reading the chip:** `Theme: Light`. When the panel's theme and the canvas's theme differ, the chip does **not** try to say so — 460 px, and the reconciliation belongs in the popover (§8.2). When the file has exactly one theme, the chip still renders and still opens; when it has none, §8.5.

### 8.2 The popover

```
┌──────────────────────────────────────────────┐
│ ✓ Light                            on canvas │
│   Dark                                       │
│   Brand                                      │
├──────────────────────────────────────────────┤
│ Light resolves through, in order:            │
│   Base · Theme/Light · Text · Effect · Grid  │
│   [ Show only these sets ]                   │
├──────────────────────────────────────────────┤
│   [ Switch this page to Light ]              │
└──────────────────────────────────────────────┘
```

- **The set list is read-only, and showing it is the point.** With composition editing deferred, the one honest thing this control can do beyond picking is answer *what am I actually resolving against* — in `selectedTokenSets` order, last-wins, which is the order that decides the answer (ADR-0002 §1). Checkboxes here would be composition editing, and they are the specific thing §2 rules out.
- **`[ Show only these sets ]` connects the two lenses without merging them.** It sets the set filter (Phase 4 §4.3) to this theme's sets. The theme chip decides what values *mean*; the set filter decides what is *listed*; this button is the bridge, and it is a button rather than an automatic coupling because "show me every set but resolve as Dark" is a legitimate thing to want when you are hunting a `⚑ unresolved`.
- **`on canvas` is a grey tag, not a state badge.** It marks whichever theme the Figma canvas is currently set to, when that is knowable. It is grey because it needs nothing.
- **No `[ New theme ]`, no rename, no delete.** §2. If the popover ever grows one, it has stopped being Phase 7.

### 8.3 Switching the panel's theme

Picking a theme re-resolves every reference and expression in the panel, theme-scoped, and **writes nothing anywhere** — not the canvas, not the overlay, not the repo. It is stored as a few bytes per file (ADR-0007 §7a) so it survives closing the panel.

Two consequences the user will otherwise read as bugs, and one toast that covers both:

> **Resolving against Dark.** 3 tokens have no value in this theme.

- **Values change.** Every reference and expression now resolves through a different stack. That's the feature.
- **Flag counts change.** `⚑ unresolved` appears and disappears with the theme (§5.4), and so can `⚑ cycle`, since the graph is theme-scoped (§7.4). The `⚑ N flagged` chip's count moving when you switch a lens looks alarming; the second sentence of the toast is what makes it read as arithmetic instead.

The toast's second sentence is **omitted entirely** when the count is zero — a toast that says "and nothing is wrong" every time is a toast people learn to dismiss unread.

**If the stored theme is gone** after a rescan or a pull, fall back to the first theme in the manifest and say so plainly (ADR-0007 §7a), because silently resolving against a stack the user did not choose changes every displayed value with no explanation:

> **`Brand` isn't in this file any more.** Showing `Light` instead.

### 8.4 Switching the canvas

`[ Switch this page to Light ]`, in the popover footer, is the **only** thing in Phase 7 that modifies the Figma document. Everything about it is designed to not be confused with picking a theme:

- **It is a second, explicitly labelled tap.** Choosing a theme in the list above it does not move the canvas. Two things happen in one popover and they are separated by a rule, worded differently, and only one of them is a button.
- **It is not an apply and does not open the apply dialog.** It writes no token values, so the confirmation would guard nothing — and Phase 5 §5.2's invariant is about *writes to token values*, which this isn't. ADR-0007 §7c is explicit, and routing it through the dialog would train users to click through the dialog that guards something real.
- **⌘Z is the undo, as it is for every document mutation** (Phase 5 §5.5). It is bracketed into its own undo step. **No `[ Undo ]` in the toast** — the rule *"the panel can undo what it did to the tokens; only Figma can undo what was done to the file"* holds without an exemption.
- **The button is disabled with a reason when the theme maps to nothing**: `Nothing on this page follows these collections.`
- **Partial mapping is reported, never silent** (ADR-0007 §7c):

  > **Switched this page to Dark.** 2 sets have no Figma mode: `Text`, `Effect`.

  Except that style-backed sets are **expected**-unmappable and are excluded from that sentence entirely — Figma Styles have no modes, so naming them every single time is how you teach someone to stop reading the toast. Only hand-composed sets that arrived from a pulled `$manifest.json` get named.

**Scope assumption, flagged for implementation (ADR-0007 open question 1).** This design assumes **the current page**, and the assumption is visible in the button's own label — `Switch this page to Light`. The UX consequence for whoever settles the question:

| If switching targets | What this control becomes |
|---|---|
| **The current page** *(assumed)* | Exactly as drawn. One button, one label, no scope control. |
| The document root | Same control, label becomes `Switch the document to Light`. No structural change. |
| The current selection | **This control breaks.** It becomes selection-aware — present only when something is selected, with a count in the label — which is Phase 5 §5.4's selection-bar shape and a different design. Raise it before building. |

**There is no scope selector in the UI under any of the three.** A dropdown asking *page / document / selection* would put a systems question in front of a designer who wants to see the dark theme, and it is the kind of control that gets set wrong once and confuses someone for a month.

### 8.5 When the file gets no themes at all

ADR-0002 §6's deferral is **not** discharged by Phase 7: a file with two or more multi-mode collections gets no derived themes and a `theme-composition` / `ambiguous` report entry. There is no build-time fix in this phase, so the only honest move is to say so.

**The chip stays present and reads `[ Theme: none ▾ ]`.** It is not hidden and it is not greyed into inertness — an absent control reads as *unbuilt*, a disabled one reads as *broken*, and a present one that explains itself reads as *known limitation*, which is the true one. It opens to an explanation rather than an empty list:

```
┌──────────────────────────────────────────────┐
│ No themes for this file                      │
│                                              │
│ Tokenvault works themes out from Figma's     │
│ collections and modes. This file has 3       │
│ collections with more than one mode, so      │
│ there's more than one way to combine them —  │
│ and picking one for you would quietly give   │
│ you the wrong values.                        │
│                                              │
│ Values below resolve through every set, in   │
│ order, last one wins:                        │
│   Base · Theme/Light · Theme/Dark · Text …   │
│                                              │
│ Building a theme by hand isn't in this       │
│ version.                                     │
│                                              │
│ [ See the import report ]                    │
└──────────────────────────────────────────────┘
```

Four things that copy is doing, and none of them is optional:

1. **It names the cause in the user's terms** — three collections with more than one mode — so the user can look at their own file and see it.
2. **It says why we didn't guess**, in one clause, because *"guessing would give you the wrong values"* is the entire reasoning and it is more convincing than any apology.
3. **It says what is happening instead**, and lists the stack, so the values in the tree are explained rather than mysterious.
4. **It says the fix isn't here**, in plain words, with no *"coming soon"* and no waitlist affordance. `[ See the import report ]` deep-links to the existing `theme-composition` / `ambiguous` entry on the Import tab, which is where the machine-readable version already lives.

**The single-theme cases read normally, not apologetically.** A file with one multi-mode collection gets one real theme; a file with none gets ADR-0002 Amendment 1 §D's synthesised `Default`. Both render as an ordinary chip (`Theme: Default`) whose popover carries one grey line — *"This file has one set of values; Tokenvault named it Default."* — and nothing more. Neither is a degraded state and neither should look like one.

---

## 9. The header chip gains one rung

Phase 6 §6.1 set the precedence: **diverged → conflicts → repo counts → Figma counts.** Phase 7 inserts one:

| Rank | State | Chip |
|---|---|---|
| 1 | Diverged | `1 diverged` |
| **2** | **Cycles** | **`2 cycles`** |
| 3 | Conflicts | `2 conflicts` |
| 4 | Repo counts | `↑ 3 ↓ 2` |
| 5 | Figma counts | `7 local · 3 changed` |

**Cycles rank second because a cycle is the only left-half state that refuses an operation outright.** Every token on a loop is blocked at apply (§7.3c), so a user about to press Apply needs to know before they press it — which is the same argument that put `diverged` first, applied to the Figma side. Conflicts, by contrast, have a live value and merely need a decision.

**The count is loops, not tokens on loops.** `2 cycles` means two problems. Counting the nine tokens across them would make a small problem look like a large one and would double-count nothing usefully.

`⚑ unresolved` gets **no rung at all** and stays inside the `⚑ N flagged` count, because it is frequently the correct state of a correct token (§5.4). Promoting it would put a permanent amber count on files whose theme-specific tokens are exactly right.

---

## 10. Empty and error states

### Empty states

| When | Copy |
|---|---|
| Path picker, no matches | **No token path matches `spacng`.** Search covers every set. |
| Path picker, matches exist but none are the right type | **Nothing of type `color` matches `spac`.** The paths below are other types and can't be used here. *(the greyed group still renders — §4.2)* |
| Theme popover, exactly one theme | Normal picker, one row, plus the grey line in §8.5's last paragraph |
| Theme popover, no themes | The explanation panel — §8.5 |
| `⚑ flagged` filtered to cycles, none present | **No loops.** Every reference resolves. |
| Changes list, Local section, expression entries only | The §6.6 line above the section, then the rows. Never an empty state — they are real entries |

### Error and degraded states

| State | Treatment | Copy |
|---|---|---|
| Reference target doesn't exist | Refuse, field stays open, amber below | `No token at folio.core.spacng.4.` §5.1 |
| Reference type mismatch | Refuse, amber below | `folio.core.spacing.4 is a number. This token is a color.` §5.2 |
| Reference would close a loop | Refuse, cycle block below the field | §7.3a |
| Reference dangles in some themes | **Commit**, grey note, then `⚑ unresolved` on the line | `Isn't in Dark or Brand, so this token has no value there.` §5.4 |
| Token on a cycle, in the tree | Value preview is `—`, `⚑ cycle` on the value line, block in the overlay | §7.3b |
| Token on a cycle, at apply | Blocked row, unchecked, `[ Show the loop ]` | §7.3c *(the button shipped 2026-09-04, in the Phase 9 audit — Phase 7 left the row carrying only the message. `error-states.md` §5.3.)* |
| Expression with a unit | Refuse, amber below | `Units don't go in expressions.` §6.4 |
| Expression, unfinished / bad operator / function call / ÷0 | Refuse, amber below | §6.4's table |
| Expression with a non-numeric operand | Refuse when typed; **blocked row** when it arrived by pull | `folio.color.accent is a color. Expressions only work with numbers.` |
| Expression that is a no-op over one reference | **Commit**, grey note, one-tap fix offered | `{a} * 1 is the same as {a} …` §6.5 |
| Expression entry still listed after an apply | Grey `expression` tag, one explanatory line above the section | §6.6 |
| Composite sub-key typed as `{a}` | Field rejects it, grey note | `Pointing one field of a typography token at another token isn't in this version.` §12 |
| Stored theme no longer exists | Toast on rebuild, falls back to first theme | `Brand isn't in this file any more. Showing Light instead.` §8.3 |
| Theme switch maps no collections | Button disabled with a reason | `Nothing on this page follows these collections.` §8.4 |
| Theme switch maps some sets | Toast names the unmapped hand-composed sets only | `Switched this page to Dark. 2 sets have no Figma mode: Text, Effect.` §8.4 |
| File gets no themes | Chip reads `Theme: none`, opens the explanation | §8.5 |
| Colour swatch clicked while the value is a reference | Nothing happens except the text field focusing | §4.1 — never silently converts a pointer to a hex |

---

## 11. Questions — all closed

**Nothing here is open.** All four went to Shyam on 2026-09-03 and all four came back confirming the recommendation as drafted, with no changes to the sections they point at. The numbering is kept so earlier references still resolve.

1. ~~**Does picking a theme in the panel also switch the canvas?** §8 says **no** — picking is a lens, and a second explicit button moves the canvas. The alternative is that they are one action, which is fewer taps and matches what a designer probably means by "switch to dark"; the cost is that a control in a filter row silently mutates the document, which is the one thing every other surface in this panel refuses to do.~~
   **Resolved 2026-09-03 — Shyam: keep them separate, exactly as designed.** Picking a theme in the chip is a lens and writes nothing; `[ Switch this page to Light ]` is a second, explicitly labelled tap and is the only thing in Phase 7 that mutates the Figma document. §8.3 and §8.4 stand unchanged, including the rule that the switch never routes through the apply dialog and never gets a plugin-side undo. **The one-action alternative is off the table, not deferred** — a control in a filter row must not write to the file.
2. ~~**Is `[ Theme: none ▾ ]` the right honesty, or too much?** §8.5 keeps a present, tappable control whose only job is to explain a limitation. The cheaper alternative is hiding the chip when there are no themes, which is quieter and lies by omission — the user concludes the feature doesn't exist rather than that their file's shape defeated it.~~
   **Resolved 2026-09-03 — Shyam: keep it; the chip stays present and explains itself.** §8.5 ships as written: `[ Theme: none ▾ ]` renders, is tappable, and opens the explanation panel rather than an empty list. Hiding the chip is rejected. This is the section most likely to be dropped as an edge case in a build, so it is called out again in §13's build notes — **dropping it is a design deviation, not a scope trim.**
3. ~~**Should the no-op-expression nudge (§6.5) exist at all?** ADR-0007 gave this to me and §6.5 answers it — steer only where a reference is provably equivalent, never otherwise. Recorded here because it is a product-feel call as much as a design one, and it is easy to veto in either direction: to nothing at all, or to a standing warning on every expression.~~
   **Resolved 2026-09-03 — Shyam: offer it, exactly as §6.5 draws it.** The nudge fires only where the expression is arithmetically a no-op over a single reference (`{a} * 1`, `{a} + 0`, `{a} / 1`, `({a})`, `-(-{a})`); it commits the value first, offers a one-tap swap, and never rewrites on the user's behalf. Both vetoes are closed: no standing warning on ordinary expressions, and not silence either. This also discharges the question ADR-0007 §4 handed to `@ux-designer` (see the header's *Resolves for the ADR* line).
4. ~~**Does `2 cycles` deserve rank 2 in the header chip (§9)?** It outranks conflicts, which means a file with two loops and eleven conflicts shows the loops. The argument is that a cycle blocks an apply and a conflict doesn't. The counter-argument is that conflicts are more common and more actionable.~~
   **Resolved 2026-09-03 — Shyam: cycles outrank conflicts, as written.** §9's five-rung precedence — diverged → **cycles** → conflicts → repo counts → Figma counts — is final. The deciding argument is the one §9 makes: a cycle is the only left-half state that refuses an operation outright, so it has to be visible *before* the user presses Apply. The count stays loops, not tokens on loops.

**Assumption carried, not a question for Shyam:** live theme switching targets the **current page** (§8.4). That is ADR-0007's open question 1 and belongs to implementation, not here — but the button's label names the scope, so whichever way it lands, one string changes, and only the *selection* answer would force a redesign. §8.4's table says what each costs.

---

## 12. What this doc amends

**`local-editor.md` §5.3 is lifted, as it said it would be.** The section currently reads *"the value field is disabled, styled as a reference chip"* with the copy *"Editing references lands in Phase 7 — for now, change the token it points at."* Both go. The replacement is §4 of this doc: the same field, editable, with the picker on `{` and the four rules on commit. **`Go to target` survives unchanged** — it was the right affordance and it is now reachable from an editable field.

**`local-editor.md` §4.5's outlined swatch is retired** (amended there, 2026-09-04). Phase 4 outlined a reference's colour swatch because it couldn't resolve it; Phase 7 can, and the swatch now shows the resolved colour at full opacity with a solid border, like any literal. Reference-ness stays on the `↗` glyph and the value text — see §6.3 on why `↗` is the load-bearing mark.

**`local-editor.md` §7's delete-blocking copy needs one clause removed.** It currently says *"Phase 4 can't edit a reference, so the only way to clear these is to delete the referencing tokens first."* Phase 7 can edit a reference, so the sentence becomes:

> **7 tokens still reference it.** Deleting it would leave them pointing at nothing. Re-point them at something else, or delete them first — deepest first, since they may have references of their own.

**Delete stays blocked.** Phase 7 makes re-pointing possible; it does not make it automatic, and there is still deliberately no *"remove all references"* button, because rewriting seven tokens' values on one tap is reference surgery the user hasn't seen. The block is now a dead end the user can dig out of, which is what §7's original *"be honest that this can be a dead end"* was waiting for.

**Composite sub-keys stay refused, with copy instead of silence.** ADR-0007 §10 defers them. A typography editor's `fontSize` field that rejects `{folio.typography.font-size.70}` while the row above it *displays* `fontSize → {folio.typography.font-size.70}` from `boundVariables` is going to read as broken, so the field's rejection says which it is:

> Pointing one field of a typography token at another token isn't in this version. The `fontSize → {…}` line above comes from Figma and still works.

**`apply-and-drift.md` §5.6's table row for expressions is now reachable.** It reads *"Value is a math expression (`{a} * 2`) → Blocked. Phase 7 owns evaluation; Phase 5 aliases a pointer, it does not compute one."* Phase 7 owns evaluation and evaluates it: the row becomes an ordinary checked row showing `= 32 · applied as a number` (§6.3). Amend that line when this ships.

---

## 13. Build notes for `@frontend-engineer`

- **Read ADR-0007 first.** This doc specifies how states *read*; the ADR owns the grammar, the three value shapes, the storage format, the evaluation points, the four authoring rules, the three report kinds and the module layout. Where they disagree, the ADR wins and this doc gets amended.
- **One value field, one parser.** No mode toggle, no second classifier in the UI (§4.1). Whether a string is a literal, a reference or an expression is `references.ts` + `expr.ts`'s answer, asked once and rendered, never decided by which control the user typed into.
- **The picker reads the same path index the tree does** — `normalizePathKey`'d dotted path → `{ setId, token }`, built once per import (Phase 4 §11). Do not build a second index for autocomplete.
- **The picker's third group needs the editor-scoped cycle check, not the whole-graph one.** ADR-0007 §3 scopes it to the edited token's reachable set precisely so it can run per keystroke against 1,316 tokens. Same function as the other two check points — a second cycle implementation that can disagree with the first is worse than no check.
- **Validation fires on commit, not per keystroke.** The picker filters live; the amber does not. A half-typed path is not an error (§5).
- **A cycle renders no value. Ever.** No zero, no last-known, no partial evaluation (§7.1). If a fallback appears anywhere in the render path, that is the bug this section exists to prevent.
- **The cycle block is one component with three callers** — under the value field, in the detail overlay, and behind `[ Show the loop ]` in the apply dialog (§7.3). Every path in it is a navigation target, reusing Phase 4 §7's referrer-list row.
- **`⚑ cycle` and `⚑ unresolved` are `.badge.needs` amber, one lowercase word after the flag.** No new badge class, no new colour, no cycle tab. Phase 4's "no third badge colour" rule and Phase 5 §8's four-value language both hold without exemption — Phase 7 adds **zero** colours.
- **The resolve line is grey and is not a badge** (§6.2). Nothing about an expression is amber unless it fails to parse or evaluate.
- **There is no standing warning about expressions** (§6.5). The only nudge is the no-op-equivalence one, it commits the value first, and it offers rather than rewrites.
- **Expression overlay entries are sticky by design** (ADR-0007 §6). They must not be filtered out of the Local count — the chip would lie — and they must carry §6.6's explanatory line so they don't read as a stuck state.
- **The theme is a lens; the canvas switch is a document mutation.** Two things, one popover, separated by a rule (§8.2, §8.4). Picking a theme must not touch `figma.*` at all. The switch is bracketed with `commitUndo` and gets no plugin-side undo.
- **The theme chip renders in all four cases** — several themes, one theme, synthesised `Default`, and none (§8.5). The none case is a real screen with real copy, not a hidden control. If it gets dropped as an edge case, a user with two multi-mode collections gets a silently missing feature and no explanation, which is the exact failure ADR-0002 §6 refused to ship.
- **Theme switching re-resolves and re-flags; both counts moving is correct.** Surface it with §8.3's toast rather than letting the `⚑` count jump unexplained. Cycles are theme-scoped too (§7.4).
- **Preserve `$extensions."com.tokenvault"` byte-for-byte through every authoring path.** ADR-0002 §7's guarantee is as fragile here as in Phases 4–6, and a value field that round-trips a token through a form is the classic way to break it. Write `$value` only.
- **The apply row for an expression is Phase 5's row component with a third line**, not a new row kind (§6.3). If Phase 7 introduces a second diff row, something went wrong.
- **Section 2's out-of-scope table is the scope boundary.** If a task starts needing theme composition editing, composite sub-key references, token creation, colour math, or units, stop and raise it.
