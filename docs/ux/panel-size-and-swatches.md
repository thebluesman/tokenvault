# UX: Panel size and colour swatches (Phase 10)

**Status: Settled 2026-09-07.** All four §9 questions answered by Shyam: (a) for §9.2 — the tree
stays, no table rewrite, revisit only as its own future phase if it turns out to be needed — and the
three numeric recommendations in §9.1, §9.3, §9.4 confirmed as written. This doc is now
implementation-ready for `@frontend-engineer`.
**Owner:** `@ux-designer`
**Covers:** Issues [#35](https://github.com/thebluesman/tokenvault/issues/35) (resizable window) and
[#36](https://github.com/thebluesman/tokenvault/issues/36) (colour swatches in the token list).
PRD §6.7, build plan §9 Phase 10.
**Builds on:** `local-editor.md` (P4) §4.1, §4.2, §4.4 and §4.5; `references-math-themes.md` (P7)
§7 and §8; `dark-mode.md` (P10) §6.3. Same panel, same vocabulary. Read those first — this doc
extends them and does not restate them.
**Amends:** `local-editor.md` §4.1, §4.4 and §4.5; `dark-mode.md` §6.3 — all stated in §8, to be
applied when the build lands, per the precedent in `references-math-themes.md` §12 and
`onboarding-polish.md` §9.2.

---

## 1. What we're designing against

Both issues were filed off a UX discussion rather than off the running panel, and in both cases the
panel is further along than the ticket assumes. Establishing that first, because it moves most of
the work in #36 out of "build a swatch" and into "decide what a swatch does when there is no
colour."

| Fact | Source | What it forces |
|---|---|---|
| **Row-level colour swatches already ship.** Every colour value line renders a 12px checkerboarded chip at its true resolved colour, references included. | `src/ui/tokens.ts` `colorSwatch` / `appendValue`; `local-editor.md` §4.5 | #36 part 1 is **already built**. What is genuinely undesigned is the three no-colour cases (§4.2) and the fact that the chip is a *different width of row* depending on whether it renders at all (§4.3). |
| **There is no table, and no columns.** The Tokens tab is a merged disclosure tree keyed by dotted path, with stacked per-set value lines. | `local-editor.md` §4.2; `src/ui/tokens.ts` `renderTree` | Both issues say "the token table view." That view does not exist. §9.2 asks whether it is meant to. Everything below is written against the tree that ships. |
| **`local-editor.md` §4.2 already refused a column layout, and the reason was width.** *"at 460px a second value column leaves ~90px for the token name."* | `local-editor.md` §4.2 | #35 removes the stated reason. §3.4 argues the refusal survives anyway, for a different and better reason. |
| **The panel is `460 × 640`, fixed, and that number is load-bearing in four other docs.** | `src/code.ts:145`; `apply-and-drift.md` §6.5, `git-sync.md` §9, `references-math-themes.md` §6.3, `onboarding-polish.md` §1 | Widening the default does **not** retire those arguments. §3.4. |
| **A swatch resolves through the active theme lens.** `resolutionFor` runs under the selected theme, so the same path can paint two colours in two lenses with no edit between them. | `references-math-themes.md` §8.1; `src/ui/tokens.ts` `appendValue` | The group strip (§5) inherits this, and it has to inherit it deliberately rather than by accident — see §5.4. |
| **A cycle renders as `—` with `⚑ cycle` and no value at all.** Never a zero, never the last good number. | `references-math-themes.md` §7.1; `src/ui/tokens.ts` `appendValue` | A cycle must not get a swatch either — not even an empty one. §4.2. |

Constraints carried forward, all still load-bearing: 1,316 tokens, 11 sets; **no third badge
colour**; `⚑` is the only attention glyph; a swatch's one job is showing the true resolved colour
(`local-editor.md` §4.5, amended 2026-09-04).

---

## 2. Scope

### In scope

Window default size, resize bounds and size persistence (§3). The no-colour swatch cases on a value
line (§4). The collapsed-group swatch strip (§5). The copy those states need (§6).

### Explicitly out of scope

| Not this | Where it lives |
|---|---|
| **A table/columns rewrite of the Tokens tab** | Not scoped anywhere. §9.2 asks whether it should be. If the answer is yes it is its own issue with its own doc, and it is not small. |
| **Swatches for non-colour types** | Issue #36 says so, and it is right: a typography or shadow token has no single chip that is honest about it. `local-editor.md` §4.5's text previews stay. |
| **Any change to how colours are edited** | Phase 4 §5.2 and Phase 7 §4 own the value field. Nothing here is clickable-to-edit. |
| **A custom resize handle or resize chrome** | Figma's native handle, or nothing. Issue #35 says so. |
| **Re-tuning the reference swatch treatment** | Settled by issue #28 / PR #29 and recorded in `local-editor.md` §4.5. A resolved reference paints at full opacity with a solid ring, indistinguishable from a literal. This doc reuses it and does not reopen it. |
| **Per-panel-width layout modes** | §3.4. There is one layout. |

---

## 3. A. The window (issue #35)

### 3.1 What the current size actually costs

`460 × 640` was never chosen; it is the number the Phase 1 scaffold shipped with and no phase since
has had a reason to touch it. Four surfaces are visibly squeezed by it today, and they are the ones
that should set the new number:

- **The filter chip row** (`local-editor.md` §4.3): `[ All sets ▾ ][ All types ▾ ][ ⚑ 12 ][ ● 4 ]`
  is four chips on one line at 460px with nothing spare, and `2 of 11 sets` is already the longest
  label that fits.
- **The value line.** A reference truncates from the left to about 22 characters —
  `{…palette.red-warm.50}` — so a deep path loses its middle segments, which is exactly where two
  similar palettes differ.
- **`Review & push`** (`git-sync.md` §7). A diff row is path, before, after. At 460px the two value
  halves are ~140px each, and a `#RRGGBBAA` plus a swatch fills that with no room for the `→`.
- **Height, not width, is what hurts the tree.** 640px minus header, search, chips and footer leaves
  roughly 20 single-height rows visible out of ~1,027. Scrolling a thousand rows through a
  twenty-row window is the single biggest reason the panel feels cramped, and it is a height
  problem that no amount of width fixes.

### 3.2 Default, minimum, maximum

Exact numbers are §9.1 — Shyam's call. The **shape** of the recommendation, and why:

| | Recommendation | Argument |
|---|---|---|
| **Default** | `640 × 720` | Wide enough that the filter row and a `Review & push` diff row both breathe, tall enough for ~30 rows instead of ~20. Not wider: the panel floats over the canvas the user is applying tokens to, and a plugin that covers the artboard it is editing has traded one problem for another. 720 is chosen against a 900px-tall laptop viewport, so it fits without Figma clamping it on the smallest machine anyone will run this on. |
| **Minimum** | `400 × 480` | Deliberately **below** today's 460, not at it. Someone who wants the panel as a narrow strip beside a wide artboard should get it, and 400 is the point where the four-chip filter row wraps to two lines — which is a graceful failure, not a broken one. Below ~400 the `Review & push` diff row stops being readable and there is no graceful version. |
| **Maximum** | none | Figma already clamps a plugin window to the user's viewport. A maximum we invent is a number we have to re-justify every time someone attaches a bigger display, and it protects against nothing — a user who drags the panel to fill their screen has said what they want. |

### 3.3 Persistence, and the three ways restoring a size goes wrong

One `clientStorage` key holding `{ width, height }`, written on Figma's resize event, read before
`showUI`. Straightforward, and it has three failure modes that all resolve to the same rule:
**a stored size is a request, not an instruction.**

| Situation | What happens |
|---|---|
| Nothing stored (first run, or a cleared store) | The default. No prompt, no "we've made the panel bigger" toast — a plugin that announces its own window size is noise. |
| Stored size is smaller than the minimum (a stale value, or a minimum we raise later) | Clamp up to the minimum. Silently. |
| Stored size is larger than the current viewport (the user moved from a 32" display to a laptop) | Clamp down to fit. Figma will do this anyway; doing it ourselves means the *stored* value gets corrected too, so the next resize is measured from what the user can actually see. |
| The stored blob is unreadable | Same posture as `error-states.md` §3: fall back to the default and carry on. A corrupt window size is not worth a screen. Do **not** quarantine it the way the overlay is quarantined — there is no user data in it to recover. |

The size is **not** synced to the repo and **not** part of Settings. It is a per-machine physical
preference, like where you put a palette; it has no business travelling with a token tree, and there
is no Settings row for it because the resize handle is the control.

### 3.4 Responsiveness — there isn't any, and that is the design

The tempting read of #35 is that a wider panel unlocks the column layout `local-editor.md` §4.2
turned down. It doesn't, for a reason that is easy to miss:

**A resizable panel means 460px is still reachable. The minimum becomes the design target, not the
default.** Every layout argument in the existing docs was built on "this is a narrow column and
attention is scarce" — one attention glyph, no third badge colour, no green dot on in-sync rows, no
second value column. Making the window resizable does not weaken any of those, because a user can
still be sitting at 400px, and a layout that only reads correctly at 640px is a layout that breaks
for them silently. Extra width is a **bonus the panel spends on breathing room, never a premise it
builds on.**

So, concretely:

- **No reflow, no breakpoints, no layout modes.** One layout, from 400px to whatever the display
  allows.
- **No horizontal scroll, ever.** A token browser that scrolls sideways to reveal a token's name is
  broken. Everything that can't fit truncates — and the truncation rules are already written
  (`local-editor.md` §4.5: reference paths truncate from the left, because the tail carries the
  meaning).
- **Extra width goes to the two things that were losing information**, in this order: the value
  line's truncation budget (so `{…palette.red-warm.50}` becomes the full path before anything else
  grows), then the token name. Nothing new appears at width — no column materialises at 800px,
  because a control the user has never seen before appearing when they drag a handle is a magic
  trick, not an affordance.
- **Prose blocks get a max measure and stay left-aligned.** `How Tokenvault works`
  (`onboarding-polish.md` §7.2), the three-place explainer, and error-screen copy cap at roughly
  64 characters. Body copy running the full width of a 1,400px panel is unreadable, and centring it
  in the space would be worse.
- **The column refusal stands.** Not because of width any more, but because `local-editor.md` §4.2's
  real argument was always the second one: there are **11 sets**, a column layout has to pick which
  two get columns, and it breaks the moment a path appears in three. Width never fixed that.

---

## 4. B. Row-level swatches (issue #36, part 1)

### 4.1 The part that already works

A colour value line renders `colorSwatch(resolved)` — a 12px chip, 3px radius, checkerboard beneath
so alpha is real, `--swatch-ring` inset hairline so a `#000000` token is not an invisible square on
a dark panel (`dark-mode.md` §6.3). A resolved reference paints identically to a literal, with the
`↗` glyph and the `{…}` value text carrying "this is a pointer" (issue #28). **None of that
changes.** #36's acceptance criterion about reusing the #28 treatment is already met by the code
that ships.

### 4.2 The three no-colour cases

This is the actual design work in part 1. Three situations produce a colour token with no colour,
they already render differently from each other, and only one of them is currently deliberate.

| Case | What the row shows today | What it should show | Why |
|---|---|---|---|
| **Cycle** (`references-math-themes.md` §7) | `—` + `⚑ cycle`, **no swatch element at all** | `—` + `⚑ cycle`, no mark, but the 12px slot **reserved** (§4.3) | Correct as designed. A cycle has no value, so it has no colour, and any mark in that slot would be a claim about a colour that does not exist. The `⚑ cycle` is the whole signal; §7.1's rule — never a zero, never the last good number — extends to "never a swatch." |
| **Dangling reference** — points at a path in no set | Dashed outlined 12px swatch + `⚠` | Unchanged | Right already. The dashed outline is `dark-mode.md` §6.3's "no colour" mark and it is literally true here: the pointer resolves nowhere, so there is nothing to paint. |
| **Wrong-type reference** — resolves, but to a non-colour (`references-math-themes.md` §5.2, rule 2) | Inconsistent — falls through to whichever branch matches | The **dangling treatment**: dashed outline + the rule-2 flag | From the swatch's point of view these are the same fact: *this colour token has no colour to show.* Giving them two marks asks the user to distinguish "points nowhere" from "points at a number" by looking at a 12px square, which no square can carry. The flag already says which it is. |

Nothing else gets a new mark. In particular there is **no third state** for "resolves under this
theme lens but not under another" — that is `references-math-themes.md` §5.4's rule 4, it is a flag,
and it stays a flag.

### 4.3 Reserve the slot

Today a value line with no swatch starts its text 12px further left than one with a swatch, so
scanning a colour group's values means reading a ragged left edge. **The swatch occupies a fixed
12px slot plus its gap on every colour value line, whether or not a mark is drawn in it.**

Cheap, and it is what makes the cycle row read correctly: `—` sitting in the same column as every
sibling's hex is legible as *absence*. `—` shifted 12px left just looks like a different kind of
row.

Non-colour lines (`number`, `string`, `typography`, …) do **not** reserve the slot. They are not in
the same scanning column and giving every row in the tree a permanent 12px indent to serve colour
rows is the wrong trade at 400px.

---

## 5. C. The collapsed-group swatch strip (issue #36, part 2)

The genuinely new surface. A collapsed group of colours currently reads as a name and a number —
`▸ red-warm  10` — which tells you how many things are in there and nothing about what they are.
Tokens Studio shows a strip of dots. So should we.

### 5.1 Where it goes

```
▾ folio                                          412
  ▾ color                                        287
    ▾ border                                      12
      ■ accent.default
          Light  {…red-warm.50}    ↗
          Dark   {…red-warm-v…}    ↗
    ▸ background   ■■■■■■ +58                     64
  ▸ spacing                                    38  ⚑
```

The strip sits **after the group name, before the `⚑` and the right-aligned count**, in the row's
flexible middle. It is the first thing to yield when the row runs out of width — the name, the flag
and the count all outrank it, because all three are load-bearing and the strip is a preview.

### 5.2 The rule that decides which groups get one

**A group renders a strip only when it is collapsed and its colour tokens are its own direct
children.** A group whose colours live in sub-groups gets nothing; its children show their own
strips when you open it.

One rule, and it does two jobs. It matches the reference screenshot exactly (`fill > fixed > black`
— `black` is a leaf group of shades, and that is the level a strip means something at). And it kills
the alternative's failure without needing a threshold: a naive "all colour descendants, capped"
would render collapsed `folio` as six arbitrary swatches and `+281`, which is honest, useless, and
actively misleading — six dots read as *"this group is these six colours."*

Everything else follows:

| Group | Strip |
|---|---|
| Leaf group, all colour children (`red-warm`, `black`) | Full strip |
| Leaf group, colour + non-colour children | Strip of just the colours. **No indicator for the rest** — the strip is a colour preview, not a census, and the count on the right already says how many paths are in there. Dots fewer than count is normal. |
| Leaf group, no colour children (`spacing`, `typography`) | **Nothing.** No placeholder, no dash, no em-space. Absence already means "no colours here," and a placeholder on roughly two-thirds of the tree is ink that never says anything. The space collapses. |
| Group whose children are groups (`folio`, `color`) | Nothing. §5.2's rule. |
| Any expanded group | Nothing. The children are showing their own swatches one line below; a strip alongside is the same information twice, and it fights the row it duplicates. |
| While searching | Nothing — the tree flattens and group rows disappear entirely (`local-editor.md` §4.6). Free. |

### 5.3 What the dots look like

**8px squares, 2px radius, same `--swatch-ring` inset hairline, 2px apart.** Squares and not circles:
the row-level chip is a 12px rounded square, and a summary made of the same shape at a smaller size
reads as *"the same thing, less of it."* A circle would be a second visual vocabulary for one fact,
in a panel whose whole design argument is that it only has one of anything.

Two departures from the 12px chip, both forced by the size:

- **No checkerboard.** At 8px the 6px checker squares are one-and-a-bit squares of noise. The dot
  sits on `--checker-a` (the panel's own ground) as a flat base, so a semi-transparent token still
  composites against the right surface — it just doesn't advertise its alpha. Alpha is not readable
  at 8px and pretending otherwise costs legibility for every opaque token in the strip.
- **The ring stays**, and it matters more here than at 12px. It is 1px of an 8px box, which is a lot
  — and it is exactly what stops a `#000000` shade being a hole in a dark panel, which is
  `dark-mode.md` §6.3's argument unchanged.

### 5.4 What the dots are, and in what order

- **One dot per path, not per value line.** A merged row for a path defined in both `Light` and
  `Dark` is one dot, not two. Otherwise a six-shade group in a two-theme file renders twelve dots
  and the strip stops describing the group.
- **The colour is the one the active theme lens resolves** (`references-math-themes.md` §8.1). Same
  source of truth as the row-level swatch directly beneath it when you expand — so expanding a group
  can never show you six colours that disagree with the six dots you just clicked. If the path does
  not resolve under the active lens, fall back to the first set in `manifest.tokenSetOrder` that
  resolves it.
- **Switching the theme lens repaints the strips.** Deliberate, and worth stating: it is the same
  fact the value lines already show, and a strip that stayed stale through a lens change would be
  the only thing in the panel lying about the current theme.
- **Tree order — the order the children appear when you expand.** Not sorted by hue or lightness.
  The strip's job is to preview the list; a sorted strip stops matching the list it previews, and a
  ramp authored 50 → 900 already reads as a ramp without our help.
- **A child that resolves to no colour contributes no dot** — cycles, danglers, wrong-type
  references are simply skipped. At 8px a dashed outline is illegible, and the group row's `⚑`
  already says something under here needs attention. This means dots can be fewer than the colour
  children, which is the same "dots ≤ count" situation as §5.2's mixed group, and needs no separate
  explanation.
- **Set and type filters recompute the strip**, exactly as they already recompute `pathCount`
  (`filterGroup` in `src/ui/tokens.ts`). A group row showing six dots while its filtered contents
  hold two is the same lie as a count of 287 over four visible rows, and the existing code already
  refuses that one.

### 5.5 Truncation

**A fixed cap, then `+N`.** Recommendation is 6 (§9.3): it matches the reference screenshot, and a
typical shade ramp is 9–11 steps, so `■■■■■■ +4` shows the top of the ramp and states the rest.

The cap is **fixed, not derived from available width**, and this is the one place the resizable
window (§3) makes an argument it would otherwise not need. A width-derived cap means the strip shows
a different number of dots at every panel size, so two people looking at the same group see
different strips, and one of them counts wrong. A fixed cap is the same everywhere, and if it does
not fit at 400px the strip yields per §5.1 like any other optional element.

`+4` is muted, same weight as the right-hand count, no border, no chip treatment. It is a footnote
on the strip, not a control.

### 5.6 Hover and click

- **Clicking anywhere on the strip expands the group** — because clicking anywhere on the row
  already does, and the strip is inside the row. It gets no click handler of its own. A 60px region
  that does something *different* inside a toggle is a trap, and there is nothing else it could
  usefully do: expanding **is** "show me all of these."
- **`+4` behaves identically.** No separate "show all" affordance; expanding is that affordance.
- **A dot's tooltip is its leaf name and resolved value**: `500 — #C33A2E`. Native `title`, not a
  custom popover — the tree is virtualized, a rich hover card over it is real cost, and at an 8px
  target the pointer barely resolves a single dot anyway. The tooltip is a nice-to-have that must
  not become a mechanism.
- **No hover state on the dots themselves.** No scale-up, no ring change. The strip is not
  interactive and should not look like it is.

---

## 6. Copy

Three strings, and they are the only new copy in this doc.

| Where | Copy | Note |
|---|---|---|
| Strip overflow | `+4` | Numeral only. Not `+4 more`, not `and 4 others` — it sits in a 460px row next to a count that is also a bare numeral. |
| Dot tooltip | `500 — #C33A2E` | Leaf segment, em dash, resolved value in the same casing the value line uses. |
| Cycle swatch slot | *(no copy)* | The `—` and `⚑ cycle` on the value line are already spec'd in `references-math-themes.md` §7.3 and are not restated or supplemented here. |

Nothing in §3 has copy at all. A window that resizes and remembers its size should say nothing about
either — see §3.3.

---

## 7. Acceptance — what to check before this is Implemented

Everything on this list needs a running panel; none of it can be read off the source.

**Window (§3)**
1. Resize, close, reopen — the size is back. Resize again, reopen — the *new* size is back.
2. Drag to the minimum: the filter chip row wraps to two lines and nothing overlaps, truncates to
   nothing, or leaves the panel.
3. Drag wide: no horizontal scrollbar at any width; the reference path on a value line reaches full
   length before the name column grows; no control appears that was not there at 400px.
4. `Review & push` at the minimum width: path, before, `→`, after all still readable in a diff row.
5. Prose surfaces (`How Tokenvault works`, the crash screen, the three-place explainer) at maximum
   width: text caps at its measure and stays left-aligned.

**Row swatches (§4)**
6. A colour group containing a cycle, a dangling reference, a wrong-type reference and a literal:
   four rows, values left-aligned in one column, the cycle showing `—` with no mark and the two
   broken references showing the same dashed outline.
7. Compare a resolved reference and a literal of the same colour side by side — indistinguishable
   swatches, per issue #28. Check at both ends of a ramp (near-white, near-black), which is where
   the old treatment failed.

**Group strip (§5)**
8. Collapse a shade ramp: dots in authored order, cap plus `+N`, matching the colours you see when
   you expand it.
9. Collapse `folio` and `color`: no strip on either.
10. Collapse `spacing`: no strip, and the row's name/count layout is identical to how it looks today.
11. Switch the theme lens with a group collapsed: the dots repaint.
12. Filter to one set, then collapse a group defined in several: dot count matches what expanding
    shows.
13. Dark mode: a `#000000` and a `#FFFFFF` dot are both visible in the same strip, in both themes.
14. Scroll a fully-collapsed 1,000-row tree — no frame cost from the strips (see §10).

---

## 8. What this doc amends

To be applied when the build lands, not before — same precedent as
`references-math-themes.md` §12 and `onboarding-polish.md` §9.2.

1. **`local-editor.md` §4.1** — the layout sketch is captioned as a 460px panel. It becomes the
   minimum-width rendering, with a note pointing here for the resize behaviour.
2. **`local-editor.md` §4.4** — the group row bullet (*"caret, segment name, descendant path count
   on the right. A `⚑` badge if…"*) gains the strip and a pointer to §5.2's leaf-group rule.
3. **`local-editor.md` §4.5** — the `color` row's Notes column gains the three no-colour cases from
   §4.2 and the reserved-slot rule from §4.3. The 2026-09-04 reference-swatch amendment underneath
   it is **untouched** — this doc reuses that decision and does not reopen it.
4. **`dark-mode.md` §6.3** — gains a paragraph for the 8px dot: ring kept, checkerboard dropped, and
   the argument for why (§5.3).
5. **The four docs that carry "460 × 640" as a stated constraint** (`apply-and-drift.md`,
   `git-sync.md`, `references-math-themes.md`, `onboarding-polish.md`) — each becomes "**minimum**
   400px wide, resizable." **None of their arguments change**, and that is the point: §3.4 shows why
   every one of them survives a resizable panel intact. This is a find-and-replace on a number, not
   a re-argument, and if any of those sections turns out to need re-arguing, that is a signal the
   change is bigger than #35 and it should stop.

---

## 9. Decisions (Shyam, 2026-09-07)

### 9.1 The three window numbers (§3.2) — Settled

`640 × 720` default, `400 × 480` minimum, no maximum, as recommended.

### 9.2 Does "the table/columns token view" mean an actual table? (§1, §3.4) — Settled

**(a) The existing merged tree.** Issues #35 and #36 are scoped exactly as written in this doc — no
table rewrite. §5's collapsed-group strip stands. If a real sortable table turns out to be wanted
later, that is its own future phase with its own UX doc and its own re-litigation of
`local-editor.md` §4.2's merged-row design — not a change to this doc or to #35/#36.

### 9.3 The strip cap (§5.5) — Settled

Six dots, then `+N`, as recommended.

### 9.4 Does the extra width earn a new column? (§3.4) — Settled

No — not part of #35. `$description` stays in the detail overlay. File separately later if the
wider panel makes its absence an obvious pain point in use.

---

## 10. Build notes for `@frontend-engineer`

- **Nothing in this doc calls Figma**, except `showUI` and the resize event. No canvas reads, no
  canvas writes.
- **Compute the strip at model-build time, not at paint time.** `paint()` runs on every scroll
  frame over a virtualized list; walking a group's children per collapsed group per frame is the one
  way this feature becomes a performance bug. The strip's dot list is a function of (group, set
  filter, type filter, theme lens) — the same inputs `filterGroup` already keys off, so it belongs
  next to it and invalidates with it.
- **`GROUP_HEIGHT` does not change.** The strip fits inside the existing 24px row; if it doesn't,
  the dots are too big, not the row too short.
- **Reuse `colorSwatch`'s resolution path, don't parallel it.** The dot's colour must come from the
  same `resolutionFor` call the expanded row would make. If the two ever diverge, expanding a group
  changes the colours, which is the one failure §5.4 exists to prevent.
- **§4.2's wrong-type case may already be partly handled** by the existing `preview.reference` /
  `resolution.value` branch in `appendValue` — check before adding a branch. The design says these
  two cases share one mark; if the code already gets there, this is a no-op and that's the right
  outcome.
- **Clamp the restored size before `showUI`, not after.** Figma clamping it for us leaves the stored
  value wrong, so the next session starts from the same bad number (§3.3).
- **Resize events fire continuously during a drag.** Debounce the `clientStorage` write; a write per
  frame on a quota-constrained store (ADR-0004 §1) is not free.
- **§3.4 is a constraint, not a preference.** If a task starts wanting a breakpoint, a layout mode,
  or a control that only exists above some width, stop — that is the boundary and it is hard.
