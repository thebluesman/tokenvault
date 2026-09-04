# UX: Dark mode

**Status**: Provisional — §9's questions are open. §1–§8 are specified to build; nothing here has
been through contact with the real thing.
**Scope**: the plugin panel's own chrome, in Figma's dark theme. Not the token *content* the panel
displays (§7), and not the exported stylesheets (that's Phase 8, repo-side).

Tokenvault has shipped nine phases of panel UI in a fixed light palette. Figma has had a dark
editor theme throughout, so a user in dark Figma currently gets a 460×640 white rectangle in the
middle of a dark workspace. That is the whole problem, and it has never been designed anywhere —
no ADR mentions it, no UX doc mentions it, and `user-journeys.md` doesn't list it as a gap.

This doc does three things: audits every colour actually in the stylesheet (not just the six
documented custom properties), specifies the dark counterpart of each, and settles the mechanism.

---

## 1. What this is really about

Two things make this more than a palette flip.

**The panel's colour language is semantic, and the semantics have documented constraints.**
`apply-and-drift.md` §8 settled a four-value language — grey means *neutral*, green means *agreed*,
amber means *needs you*, red means *this control destroys something* — with two rules that are load-
bearing rather than decorative:

- **Green is quieter than amber.** A confirmation must never out-shout a warning. In light mode
  that is achieved by desaturating the green. In dark mode saturation behaves differently and the
  naive move — lifting every colour to the same perceived brightness — inverts the ranking. §5
  fixes the ranking numerically instead of by eye.
- **Red is a button and menu-label colour, never a state colour.** Phase 4's ban on a third badge
  colour is intact. Dark mode does not get an exemption, and in particular the dark red must not
  become so legible that someone reaches for it as a badge.

**The panel is a colour tool.** It renders swatches of the user's actual token colours against its
own background. That background's luminance is not cosmetic — it is what a `#ffffff` token and a
`#000000` token are judged against, and it determines whether the transparency checkerboard and the
swatch hairline do their job. §6.3 and §7 handle this; it is also the reason §2 declines to source
our neutrals from Figma's variables.

---

## 2. Mechanism — `themeColors: true`, class swap, no JS

**Recommendation: adopt `figma.showUI(__html__, { width: 460, height: 640, themeColors: true })`,
and use it as a switch only.**

Passing `themeColors: true` makes Figma stamp a `figma-light` or `figma-dark` class onto the
iframe's `<html>` and inject a `<style id="figma-style">` block of `--figma-color-*` variables. Both
update live when the user changes Figma's theme with the plugin open.

Three candidate approaches, and why the third wins:

| Approach | Verdict |
|---|---|
| **A — Pure Figma variables**: restate our palette in terms of `--figma-color-bg`, `--figma-color-text`, etc. | **No.** Figma's set covers neutrals only. Our four semantic colours (`--accent`, `--warn`, `--ok`, `--danger`) and both their background tints have no equivalent, so half the palette still has to be hand-authored — and the half that isn't drifts whenever Figma retunes its greys. For a panel that renders colour swatches, a background luminance we don't control is a real defect, not a theoretical one (§6.3). |
| **B — Own class, own detection**: don't pass the flag; sniff the theme some other way. | **No.** There is no supported way to read Figma's theme from a plugin other than this flag, and the sniffing alternatives (guessing from a screenshot, a manual setting) are worse versions of §9 Q1. |
| **C — Hybrid: Figma's class as the switch, our own literal values** | **Yes.** We get the one thing Figma does better than we can — knowing the theme, live, with no polling — and keep full authority over every value we render. |

**Concretely:**

- Keep the palette in `:root` as today, with light values.
- Add one block, `:root.figma-dark { … }`, that redeclares **only** the custom properties. No
  component selector gets a `.figma-dark` variant. If a rule needs a `.figma-dark` override, that
  rule has a hardcoded colour that should have been a token — §3 exists to make sure none are left.
- Nothing in the TypeScript reads the theme. `applyDialog.ts:284` already sets
  `style.color = "var(--accent)"` rather than a literal, and it is the only colour set from JS. The
  live swap therefore costs **zero lines of script**: Figma swaps the class, the cascade does the
  rest.

**Live, not on next open.** This is not a preference — it falls out of the mechanism. Because the
values live behind custom properties keyed off a class Figma itself toggles, reacting live is the
*default* behaviour and blocking it would take deliberate work. It is also the correct behaviour:
a user who switches Figma to dark and sees one white rectangle stay white will read it as a bug in
the plugin, which it would be.

**One thing for `@frontend-engineer` to verify:** Figma stamps the class before first paint, so
there should be no flash of light theme on open. Confirm on a real dark-theme session; if a flash
does occur, the fix is a dark-first authoring order, not a JS guard.

**`themeColors: true` has no other effect** on the plugin — it injects a style block and a class.
It does not change sizing, messaging, or the `ui-ready` handshake Phase 9 relies on.

---

## 3. The audit — every colour in `src/ui/index.html`

The stylesheet has drifted from full custom-property use. Thirteen distinct hardcoded values appear
across twenty-three declarations. Each one below either becomes a token or is argued as a literal.

### 3.1 Already tokens (`:root`, lines 7–31)

`--border`, `--muted`, `--bg-subtle`, `--accent`, `--warn`, `--warn-bg`, `--ok`, `--ok-bg`,
`--danger`. All nine get dark values in §4.

### 3.2 Hardcoded — becomes a **new token**

| Value | Occurrences | New token |
|---|---|---|
| `#1a1a1a` as text | `body` (46), `.tab.active` (87), `.menu-btn:hover` (657), `.plan-row .diff .to` (1083) | `--text` |
| `#fff` as a **base** surface | `button` (104), `select`/`input`/`textarea.field` (129), `.chip` (300), `.sync-chip` (342), `.tnode.group` (540) | `--bg` |
| `#fff` as a **raised** surface | `header` (51), `#repo`/`#settings` (376), `.popover` (674), `#panel` (716), `#crash` (880), `.modal-card` (996) | `--bg-raised` |
| `#fff` as text **on a filled button** | `button.primary` (112), `button.danger` (953) | `--on-fill` |
| `rgba(0,0,0,0.15)` hairline | `.swatch` (621), `.swatch-fill` (640) | `--swatch-hairline` |
| `#fff` + `#ddd` checkerboard | `.swatch` (623–626) | `--checker-a` / `--checker-b` |
| `#fff2a8` search highlight | `.tname mark` (574) | `--mark-bg` |
| `#1a1a1a` / `#fff` toast | `#toast` (909–910) | `--toast-bg` / `--toast-text` |
| `#7cc4ff` toast action | `.toast-action` (926) | `--toast-action` |
| `rgba(0,0,0,0.32)` backdrop | `#modal` (987) | `--scrim` |
| `rgba(0,0,0,0.14)` / `rgba(0,0,0,0.24)` shadows | `.popover` (676), `.modal-card` (997) | `--shadow-pop` / `--shadow-modal` |
| `filter: brightness(0.93 / 0.92)` | `button.primary:hover` (115), `button.danger:hover` (957) | `--fill-hover` (a whole `filter` value) |

The `--bg` / `--bg-raised` split does not exist today because in light mode both are `#fff` and the
distinction is invisible. In dark mode it is the *primary* signal of elevation (§6.1), so the split
has to be made before the palette can be written. Splitting it is the largest single change in this
doc and it is a pure refactor in light mode: every light value below is byte-identical to what ships
now, so the light panel must render pixel-for-pixel unchanged. That is the acceptance test for the
refactor half (§8).

### 3.3 Stays a literal — argued

- **`--accent` as a button fill stays `#0d99ff` in both themes**, with `--on-fill` white on it. This
  is Figma's own primary blue at Figma's own contrast, and matching the host is worth more here than
  the ratio. Accent *text* is a different problem and gets its own token (§4).
- **`opacity: 0.45`** on `button:disabled`, `.tab:disabled`, `input:disabled`, and `0.6` on
  `detail.ts:1268` — these are alpha, not colour, and behave the same in both themes. See §6.5 for
  the one caveat.
- **Everything in `src/ui/*.ts`** — the audit found no hardcoded chrome colour in the TypeScript.
  `detail.ts:824,832` (`"#000000"`) is the *fallback value for a native colour input*, i.e. token
  content, not chrome (§7).

---

## 4. The palette

Light values are what ships today (unchanged); dark values are new. Ratios are against `--bg`
(`#2c2c2c`) unless noted.

### 4.1 Surfaces and neutrals

| Token | Light | Dark | Note |
|---|---|---|---|
| `--bg` | `#ffffff` | `#2c2c2c` | The panel floor. Rows, inputs, chips, unhovered tree. |
| `--bg-raised` | `#ffffff` | `#383838` | Header, full-panel overlays, popovers, modal card, crash screen. In dark this is what "above" means (§6.1). |
| `--bg-subtle` | `#f5f5f5` | `#434343` | Hover, `pre`, disabled input, badge ground. Chosen to read on **both** `--bg` and `--bg-raised`. |
| `--text` | `#1a1a1a` | `#e8e8e8` | Not pure white: at 11px, `#fff` on `#2c2c2c` blooms. 11.4:1. |
| `--muted` | `#8c8c8c` | `#a8a8a8` | 5.9:1 on `--bg`, 4.7:1 on `--bg-raised`. The straight lightness-flip of `#8c8c8c` fails on raised surfaces — this is the value that has to be picked against the *second* background, not the first. |
| `--border` | `#e6e6e6` | `#4d4d4d` | Slightly stronger separation from `--bg` than the light pair has from white, deliberately: dark UIs need it. Weaker against `--bg-raised`, also deliberately — a raised surface already separates itself by lightness. |
| `--on-fill` | `#ffffff` | `#ffffff` | Text on `--accent` and `--danger` fills. Unchanged. |

### 4.2 The four semantic colours

| Token | Light | Dark | Ratio on `--bg` (dark) |
|---|---|---|---|
| `--accent` (fill) | `#0d99ff` | `#0d99ff` | — (fill, `--on-fill` on it) |
| `--accent-text` | `#0d99ff` | `#66b5ff` | 6.4:1 |
| `--warn` | `#b8730a` | `#e0a33c` | **6.3:1** |
| `--warn-bg` | `#fff6e5` | `#3a2f1c` | `--warn` on it: 5.9:1 |
| `--ok` | `#2f7d55` | `#6fae87` | **5.4:1** |
| `--ok-bg` | `#eef7f1` | `#24352b` | |
| `--danger` (fill) | `#c4382f` | `#c4382f` | — (fill; `--on-fill` on it is 5.2:1) |
| `--danger-text` | `#c4382f` | `#ef7f76` | 5.3:1 |

**Two tokens split in two.** `--accent` and `--danger` each do two jobs — a fill behind white text,
and a text/border colour on the panel background. In light mode one value serves both. In dark mode
it cannot: a fill light enough to carry white text is too light to read as text against `#2c2c2c`,
and a text colour legible there is too pale to be a fill. So each splits into a fill token and a
`-text` token, **identical in light mode** so nothing changes there:

- `--accent-text` replaces `--accent` at `.chip.on`, `.sync-chip.on`, `.vline .val.edited`,
  `.toolbar` accents, and `applyDialog.ts:284`. `--accent` stays on `button.primary` only.
- `--danger-text` replaces `--danger` at `.popover .item.danger` — the menu label. `--danger` stays
  on `button.danger` only. **The split does not widen where red is allowed** (§5.3).

**The green-under-amber constraint holds numerically**: `--ok` at 5.4:1 sits below `--warn` at
6.3:1 in dark, as `#2f7d55` sits below `#b8730a` in light. This is the one ratio in the table that
must not be "improved" — raising the green to match the amber breaks `apply-and-drift.md` §8. If a
future contrast pass wants to lift `--ok`, it must lift `--warn` further first.

### 4.3 Everything else

| Token | Light | Dark | Note |
|---|---|---|---|
| `--mark-bg` | `#fff2a8` | `#6b5a10` | Search highlight. `.tname mark` sets `color: inherit`, so a pale yellow ground in dark would put near-white text on near-white — a latent bug the light theme hides. The dark value is a *wash*, not a highlighter (§9 Q3). |
| `--swatch-hairline` | `rgba(0,0,0,0.15)` | `rgba(255,255,255,0.22)` | Load-bearing, and the failure case flips: in light it's what makes a white token visible; in dark it's what makes a black one visible. |
| `--checker-a` | `#ffffff` | `#3f3f3f` | Transparency checkerboard. |
| `--checker-b` | `#dddddd` | `#555555` | |
| `--toast-bg` | `#1a1a1a` | `#4d4d4d` | The toast **gets lighter, not darker** (§6.2). |
| `--toast-text` | `#ffffff` | `#f2f2f2` | |
| `--toast-action` | `#7cc4ff` | `#8fcdff` | 4.9:1 on the dark toast ground. |
| `--scrim` | `rgba(0,0,0,0.32)` | `rgba(0,0,0,0.55)` | Dimming a dark surface takes more alpha to read as dimmed. |
| `--shadow-pop` | `0 4px 14px rgba(0,0,0,0.14)` | `0 4px 14px rgba(0,0,0,0.45)` | |
| `--shadow-modal` | `0 8px 28px rgba(0,0,0,0.24)` | `0 8px 28px rgba(0,0,0,0.5)` | |
| `--fill-hover` | `brightness(0.93)` | `brightness(1.12)` | Direction flips — see §6.4. |

---

## 5. What the swap must not change

Three rules from earlier phases are the reason this doc is longer than a colour table.

### 5.1 `--ok` appears in exactly three places, and stays quieter than amber

Header chip, the detail overlay's per-set in-sync line, the apply dialog's `already matches` rows.
Never a tree row, never a value line — in-sync is signalled by badge *absence* across 1,316 tokens
(`apply-and-drift.md` §8). Dark mode adds no fourth site. The one thing to watch during
implementation: `.chip.ok` uses `--ok-bg` as a fill, and dark tinted fills at low chroma can drift
toward "just a grey chip". `#24352b` is picked to stay visibly green-tinted against both `--bg` and
`--bg-raised` without becoming a green pill — §8's checklist verifies it by eye, since the ratio
doesn't capture it.

### 5.2 Amber stays the only attention colour

`.badge.needs`, `.entry`'s 3px left rule, `.gear.needs`, `.chip.warn.on`, `.conflict-box`,
`.field-note.warn`, `.plan-row .why`, `.sync-chip.warn`. All of them take `--warn` / `--warn-bg` and
all of them keep working unchanged. No new amber site, and no amber removed because it "looks loud
in dark" — it is supposed to.

### 5.3 Red stays a button and menu-label colour

The `--danger` / `--danger-text` split in §4.2 is a legibility fix, not a licence. After the split
there are still exactly two sites: `button.danger` (with its hover) and `.popover .item.danger`.
Any third site is a defect, and the same argument `apply-and-drift.md` §8 makes applies — a control
that wants red needs the §5.7 treatment, not a palette entry.

---

## 6. Beyond raw colour

### 6.1 Elevation inverts

In light mode, "above" is signalled by *white plus a shadow* against a greyish page. In dark mode
shadows barely read — a black shadow on a dark ground is nearly invisible — so **elevation is
signalled by a lighter surface**, which is why `--bg-raised` exists and why Figma's own dark chrome
works the same way. Practical consequences:

- `.popover`, `.modal-card`, `#panel`, `#repo`, `#settings`, `#crash`, `header` all move to
  `--bg-raised` and are *visibly lighter* than the panel behind them in dark. Their shadows stay
  (deepened per §4.3) but become edge separation, not the primary cue.
- `.popover` and `.modal-card` keep their 1px `--border`. In light this is nearly redundant; in dark
  it is the crisp edge that stops a lighter card from looking like a glow.
- `.tnode.group` currently takes `#fff` explicitly so group rows sit above the scroll ground. That
  becomes `--bg` — group rows are *floor*, not raised — and their distinction from token rows stays
  what it already is: `font-weight: 500` on `.tname.group-name`, plus the caret.

### 6.2 The toast gets lighter

`#toast` is today `#1a1a1a` on white: a dark chip floating over a light panel. The reflex flip
(white chip on a dark panel) is wrong — at 460px a white block reads as a modal, not a transient
line, and it would be the brightest thing on screen for 1.8 seconds. Instead the toast keeps
*contrast against the panel* by going the same direction elevation goes: `#4d4d4d`, lighter than
both `--bg` and `--bg-raised`, with `--shadow-modal` beneath it. It stays a small dark chip; it just
stops being the darkest thing on screen. (§9 Q4 records the alternative.)

### 6.3 Swatches and the checkerboard

`.swatch` / `.swatch-fill` render the user's actual token colour. Two supporting decorations are
ours and both need dark values (§4.3):

- The **hairline** at `rgba(255,255,255,0.22)`. Without it, a `#1a1a1a` token on `#2c2c2c` is an
  invisible 12px square, which is exactly the failure a colour tool cannot have.
- The **checkerboard** at `#3f3f3f` / `#555555`. Keeping the light checkerboard would make every
  semi-transparent token glow.

`.swatch.outlined` (dashed, no fill — the "no colour" case) needs nothing beyond `--border`.

### 6.4 The hover filter flips direction

`button.primary:hover` and `button.danger:hover` darken by `filter: brightness(0.93 / 0.92)`. On a
dark ground, darkening a fill reads as *receding* — the opposite of a hover. `--fill-hover` becomes
`brightness(1.12)` in dark. Both fills are saturated enough that lightening doesn't wash them out.

### 6.5 Native controls — `color-scheme`

`:root.figma-dark` must also set `color-scheme: dark`. Without it the browser renders every native
control in its light form on a dark panel: the `<select>` dropdown list, `.plan-row
input[type="checkbox"]`, the `input[type="color"]` swatch button in `detail.ts:816`, focus rings,
and — most visibly — the scrollbars in `main`, `#tokens-scroll`, `.panel-body`, `.modal-body` and
`pre`, of which this panel has many. One line, and it is the single highest-ratio line in the whole
change.

The one caveat this raises: **disabled opacity**. `opacity: 0.45` on muted text is already
marginal in light mode and does not get worse in dark, so it is out of scope here — but if
`@frontend-engineer` finds a disabled control genuinely unreadable in dark, raise it to `0.55` under
the dark class only and note it here rather than changing the light value.

### 6.6 Type

**The font stacks do not change.** `Inter, "Segoe UI", sans-serif` and
`ui-monospace, SFMono-Regular, Menlo, monospace` stay as they are, at 11px/10px, with the same
weights. One optional refinement: light-on-dark text renders visually heavier on macOS, so
`-webkit-font-smoothing: antialiased` **scoped to `:root.figma-dark`** thins it back toward the
light-mode weight. It is a genuine improvement at 11px and a genuine risk of over-thinning on
low-DPI displays — implement it, look at both, and keep it only if the dark panel looks like the
same typeface as the light one.

### 6.7 Icons and graphics

There are none. Every glyph in the panel is a text character (`⚙`, `⚑`, `●`, carets, arrows)
inheriting `currentColor`, and there is no image, SVG, or canvas asset anywhere in `src/ui/`. This
is the one part of dark mode that costs nothing, and it is worth stating so it stays true: **any
future icon must be a glyph or a `currentColor` SVG**, never a raster asset baked against white.

---

## 7. What is never re-themed

The panel displays the user's tokens. **Token content is never adjusted for the panel's theme**,
under any circumstance:

- `.swatch-fill` and `diffRow.ts:124`'s `fill.style.background = value` render the literal token
  colour. A `#ffffff` token renders white in dark mode. It is *supposed* to look bright — that is
  the fact the user came to check.
- `detail.ts:816`'s `input[type="color"]` shows and edits the literal value. `color-scheme: dark`
  changes its *chrome*; it must not change its value.
- Values, expressions, and resolved literals in `.vline .val`, `.resolve-line` and `.plan-row .diff`
  are text and take `--text` / `--muted` like any other text.

The line is: **chrome follows Figma's theme; content follows the token.** A future contributor
"fixing" a white swatch that looks too bright in dark mode would be deleting the panel's reason to
exist.

---

## 8. Acceptance — what to check before this is Implemented

1. **Light mode is byte-identical.** The tokenisation in §3.2 changes no light value. Diff the
   light panel against `main` screen by screen; any visible difference is a bug in the refactor.
2. **No `.figma-dark` selector exists except the one `:root` block.** A component-level dark
   override means a colour escaped §3.
3. **Live swap.** With the plugin open, toggle Figma's theme. Every surface, including an open
   popover, an open apply dialog, and a visible toast, changes in place. No reload, no flash.
4. **Green under amber.** Open a screen with a `● In sync` chip and an amber badge visible at once.
   The amber must be the thing your eye lands on.
5. **Swatch legibility.** A `#000000` token, a `#ffffff` token, and a 50%-alpha token, all in dark.
   Three distinguishable squares, each with a visible edge.
6. **Scrollbars, `<select>`, checkboxes and the colour input** all render dark (§6.5).
7. **The search highlight** is readable on a matched token path in dark (§4.3, §9 Q3).
8. **Every overlay reads as above the panel**: Settings, Repo, the token detail panel, the crash
   screen, the popover, the modal card.

---

## 9. Questions for Shyam

**Q1 — Follow Figma only, or offer an override in Settings?**
*Recommendation: follow Figma only, no setting.* The panel is a guest inside Figma's window; a
plugin that is light while the editor is dark is a defect regardless of who chose it. A
Light/Dark/Follow control in Settings is a preference to store, migrate, and explain, in service of
a case (wanting the plugin to disagree with the editor) that has no articulated user need. If the
answer is "add it", it is a small addition on top of §2 — the class becomes ours to stamp instead
of Figma's — but it should be a deliberate yes, not a default.

**Q2 — Independent greys, or match Figma's chrome exactly?**
§2 recommends hand-authored literals, which means our `#2c2c2c` may sit a shade off whatever Figma's
window chrome is doing on any given release, and any seam at the panel edge is ours to own. The
alternative — sourcing `--bg`, `--bg-raised`, `--text` and `--border` from `--figma-color-*` — buys
seamlessness at the cost of a swatch background we don't control (§1, §6.3). I'd take the seam.
Confirm you agree, because it's a taste call as much as a technical one.

**Q3 — The search highlight.** `--mark-bg` in dark is a dark amber wash (`#6b5a10`) with inherited
light text, rather than a pale-yellow highlighter with forced dark text. The wash is quieter and
consistent with everything else in the dark panel; the highlighter is more obviously "a match" at a
glance in a long list. My call is the wash, but this is the one place in §4 where the alternative is
genuinely defensible.

**Q4 — Toast direction.** §6.2 makes the dark toast *lighter* than the panel. The alternative —
near-black with a hairline border — keeps it visually identical to today's toast, at the cost of
barely separating from `#2c2c2c`. Confirm the lighter one.

**Q5 — Scheduling.** This is a self-contained change: one `showUI` option, one `:root` block, and a
mechanical tokenisation pass across ~23 declarations, with no new screens, states, or copy. It could
be Phase 10 (scope still TBD), a slice of Phase 11 (publishing — and a plugin shipped to the Figma
Community with no dark mode will be the first thing anyone reports), or a standalone ticket before
either. It should not ship *after* publishing.
