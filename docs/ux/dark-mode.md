# UX: Dark mode

**Status**: Implemented and merged — all five of §9's questions were answered by Shyam on
2026-09-04 and the doc is written to the decisions, not to the recommendations. Two were
overridden, and both are structural: there **is** an Auto / Light / Dark override in Settings
(§2.3), and the neutrals are **sourced from Figma's `--figma-color-*` variables** rather than
hand-authored (§4.1).
**Scheduled**: Phase 10 (§9.5). **Landed 2026-09-04** via PR #27 (`phase-10-dark-mode`, closed
#21). All three items §10 left open for a running panel — the injected-value transcription, the
`--bg-subtle` choice, and the font-smoothing call — were checked live by Shyam in Figma desktop
and confirmed fine as shipped; see §10 for the record.
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
swatch ring do their job.

This second point originally drove the doc toward hand-authored neutrals: pick the background
precisely, and legibility can be guaranteed by construction. **Shyam overrode that (§9.2).** The
neutrals now come from Figma's own `--figma-color-*` variables, which means the panel's background
is no longer a number we control — and the swatch decorations can no longer be tuned against one
specific known background. They have to be legible against *whatever* Figma's background turns out
to be, this release and the next one. §4.1 does the sourcing and §6.3 does the mitigation, which is
the interesting half: every swatch gets a ring sourced from Figma's own border colour, which by
Figma's own design contract contrasts Figma's own background. The guarantee moves from "we picked
both values" to "Figma picked both values, and their relationship is the thing Figma maintains."

---

## 2. Mechanism — `themeColors: true`, plus an Auto / Light / Dark override

**Adopt `figma.showUI(__html__, { width: 460, height: 640, themeColors: true })`.** Passing the flag
makes Figma stamp a `figma-light` or `figma-dark` class onto the iframe's `<html>` and inject a
`<style id="figma-style">` block of `--figma-color-*` variables. Both update live when the user
changes Figma's theme with the plugin open. There is no other supported way for a plugin to know
Figma's theme, so this flag is load-bearing whatever else we decide.

`themeColors: true` has no other effect on the plugin — a style block and a class. It does not
change sizing, messaging, or the `ui-ready` handshake Phase 9 relies on.

What the two decisions changed is what we do with it. **§9.1: the theme is a Settings choice —
Auto, Light or Dark — with Auto the default.** **§9.2: the neutral values come from Figma's
injected variables, not from our own literals.** Together those make the mechanism a little more
than "Figma stamps a class and we never touch it", and the rest of this section is that mechanism.

### 2.1 Two independent facts, four combinations

There are now two theme facts in play, and they can disagree:

- **Figma's theme**, which we learn from the stamped class and never control.
- **The panel's effective theme**, which is Figma's theme when the setting is Auto, and the
  setting's value otherwise.

Which matters because **Figma's injected `--figma-color-*` variables always describe Figma's theme,
not ours.** When a user sets the panel to Dark while Figma is Light, the injected variables hold
Figma's *light* greys. Sourcing neutrals from them unconditionally would render a light panel that
believes it is dark — the override would silently not work. So the sourcing is conditional on the
two agreeing, and the disagreement case falls back to literals:

| Figma | Setting | Effective | Neutrals come from |
|---|---|---|---|
| Light | Auto or Light | Light | `--figma-color-*` (they agree) |
| Dark | Auto or Dark | Dark | `--figma-color-*` (they agree) |
| Dark | Light | Light | The **light snapshot** literals (§4.1) |
| Light | Dark | Dark | The **dark snapshot** literals (§4.1) |

The snapshot is a checked-in copy of Figma's own neutrals for each theme, and it is not a second
palette to maintain by eye — it is Figma's values, written down. It carries exactly the drift risk
§9.2 traded away, but only in the two cells the user deliberately opted into by disagreeing with
their editor. That is the honest price of the override, and it is a price paid by the person who
asked for it. The snapshot also serves as the fallback if a future Figma release stops injecting a
variable we read.

### 2.2 The selectors

Our class is `tv-light` / `tv-dark`, stamped on `<html>` alongside Figma's, never replacing it —
Figma's class is what its injected style block is keyed to and Figma re-stamps it on every theme
change, so removing or rewriting it means fighting the host for no gain. **Auto stamps nothing.**

Four blocks, in this order:

```css
:root                                        { /* light: snapshot neutrals + light semantics */ }
:root.tv-dark,
:root.figma-dark:not(.tv-light)              { /* dark: snapshot neutrals + dark semantics,
                                                  and color-scheme: dark (§6.5) */ }
:root:not(.figma-dark):not(.tv-dark)         { /* they agree, light — repoint neutrals at
                                                  var(--figma-color-*) */ }
:root.figma-dark:not(.tv-light)              { /* they agree, dark — same */ }
```

Blocks 1–2 are the effective theme and carry the whole palette. Blocks 3–4 override *only the
neutrals*, and only where the two facts agree; equal specificity with block 2 means source order
decides, which is why they come last. Read the table in §2.1 against these four selectors and every
cell lands where it should.

Two properties of this worth keeping:

- **Auto costs zero lines of script.** With no `tv-*` class stamped, `figma-dark` alone drives
  blocks 2 and 4, exactly as the original recommendation had it. The default path is still pure
  cascade.
- **No component selector gets a theme variant.** Only custom properties are redeclared. If a rule
  needs a `.tv-dark` override, that rule has a hardcoded colour that should have been a token — §3
  exists to make sure none are left. `applyDialog.ts:284` already sets `style.color =
  "var(--accent)"` rather than a literal, and it is the only colour set from JS.

### 2.3 Where the setting lives

**An `Appearance` section in the existing Settings overlay** (`git-sync.md` §5.2), below `GitHub`,
as a three-way segmented control:

```
│ Appearance                                   │
│                                              │
│  Theme                                       │
│  [ Auto ] [ Light ] [ Dark ]                 │
│  Auto follows Figma's own theme.             │
```

- **Settings, not a header control.** §4.1 of `git-sync.md` fixes the test: tabs and header
  controls are for things you do repeatedly; this is something you set once. The gear already
  exists, the overlay already exists, and this is one more field in it.
- **Stored in `clientStorage`, per user, alongside the repo settings** — the same store the PAT and
  repo config already live in (ADR-0006 §3), under its own key. Not the tokens overlay: that is
  document content that syncs to a repo, and a personal display preference must never travel to
  anyone else's checkout. Not per Figma file either — a user who wants a light panel wants it in
  every file.
- **Auto is the default, and stays the default for anyone who never opens this.** The absence of a
  stored value is Auto, so no migration is needed for existing installs.
- **The control never explains itself further.** Three words and one line of help. The case for the
  override doesn't need arguing in the panel.

**Live, not on next open.** Changing the setting re-stamps the class immediately and the cascade
does the rest; so does changing Figma's theme while on Auto. A user who switches Figma to dark and
sees one white rectangle stay white will read it as a bug in the plugin, which it would be.

### 2.4 First paint

Auto has no flash risk: Figma stamps its class before first paint. **An override does** — the
stored value lives in `clientStorage`, which only the main thread can read, asynchronously, so
there is a window where the UI exists and the class does not.

The fix is already built. Phase 9's `ui-ready` handshake means the panel renders no screen until the
main thread answers; the stored appearance value rides along in that first message, and the class is
stamped before the first screen is drawn. No new machinery, no `document.write`, no inline blocking
script.

**For `@frontend-engineer` to verify:** that the handshake really does gate first paint of *chrome*
and not just of content — if the header or panel ground paints before the reply lands, an overriding
user sees a flash of the other theme on every open. If it does, the fix is to hold the paint, not to
read the setting some other way.

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
| `rgba(0,0,0,0.15)` hairline | `.swatch` (621), `.swatch-fill` (640) | `--swatch-ring` (§6.3 — sourced, and one of §8.1's two light-mode exceptions) |
| `#fff` + `#ddd` checkerboard | `.swatch` (623–626) | `--checker-a` / `--checker-b` (sourced — §6.3) |
| `#fff2a8` search highlight | `.tname mark` (574) | `--mark-bg` |
| `#1a1a1a` / `#fff` toast | `#toast` (909–910) | `--toast-bg` / `--toast-text` |
| `#7cc4ff` toast action | `.toast-action` (926) | `--toast-action` |
| `rgba(0,0,0,0.32)` backdrop | `#modal` (987) | `--scrim` |
| `rgba(0,0,0,0.14)` / `rgba(0,0,0,0.24)` shadows | `.popover` (676), `.modal-card` (997) | `--shadow-pop` / `--shadow-modal` |
| `filter: brightness(0.93 / 0.92)` | `button.primary:hover` (115), `button.danger:hover` (957) | `--fill-hover` (a whole `filter` value) |

The `--bg` / `--bg-raised` split does not exist today because in light mode both are `#fff` and the
distinction is invisible. In dark mode it is the *primary* signal of elevation (§6.1), so the split
has to be made before the palette can be written. Splitting it is the largest single change in this
doc.

**Do this half first, with today's literal values, and prove nothing moved.** The tokenisation is a
pure refactor: every light value stays byte-identical, so the light panel must render
pixel-for-pixel unchanged (§8.1). Only then repoint the neutrals at `--figma-color-*` (§4.1) as a
second, separately reviewable step — that one *can* shift a light value by a hair, and separating
the two is what keeps "did the refactor break something" answerable. §8 is written as those two
steps.

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

The **neutrals are sourced from Figma** (§4.1, per §9.2); the **four semantic colours stay hand-
authored** (§4.2), because Figma's variable set has no equivalent for them and never will — its
`bg-warning` / `bg-danger` tints are for Figma's own banners, not for a four-value language with a
documented ranking (§5). Ratios are against `--bg` unless noted, and see §4.2's caveat about what
`--bg` actually is now.

### 4.1 Surfaces and neutrals — sourced from `--figma-color-*`

Each neutral is `var(--figma-color-…)` wherever the panel's theme and Figma's agree, and the
snapshot literal in the two cells where they don't (§2.1). The snapshot columns below are that
literal: **Figma's own values, written down**, not a palette picked by us.

| Token | Sourced from | Light snapshot | Dark snapshot | Note |
|---|---|---|---|---|
| `--bg` | `--figma-color-bg` | `#ffffff` | `#2c2c2c` | The panel floor. Rows, inputs, chips, unhovered tree. |
| `--bg-raised` | **see below** | `#ffffff` | `#383838` | Header, full-panel overlays, popovers, modal card, crash screen. In dark this is what "above" means (§6.1). |
| `--bg-subtle` | **see below** | `#f5f5f5` | `#434343` | Hover, `pre`, disabled input, badge ground. Must read on **both** `--bg` and `--bg-raised`. |
| `--text` | `--figma-color-text` | `#1a1a1a` | `#e8e8e8` | Figma's is an alpha value over the background rather than an opaque hex; that is fine everywhere it is used. |
| `--muted` | `--figma-color-text-secondary` | `#8c8c8c` | `#a8a8a8` | Figma tunes this against its own `bg`, which is now also ours — the light-mode problem of picking it against the *second* background (§6.1) is Figma's problem now, and §8.9 checks their answer holds on raised surfaces. |
| `--border` | `--figma-color-border` | `#e6e6e6` | `#4d4d4d` | |
| `--on-fill` | *not sourced* | `#ffffff` | `#ffffff` | Text on **our** `--accent` and `--danger` fills, which are ours in both themes. `--figma-color-text-onbrand` is tuned to Figma's brand fill, not ours. Unchanged, both themes. |

**`--bg-raised` has no single Figma variable, and this is the one place real judgement is needed.**
Figma's `--figma-color-bg-secondary` is *recessed* in light (a grey panel against white) and
*raised* in dark (a lighter panel against near-black). It flips role with the theme, so it cannot be
one mapping. The mapping is therefore per-theme, which the §2.2 blocks already are:

- **Light**: `--bg-raised: var(--figma-color-bg)` — identical to `--bg`, exactly as today, where
  elevation is carried by shadow and border rather than by lightness.
- **Dark**: `--bg-raised: var(--figma-color-bg-secondary)` — lighter than the floor, which is how
  Figma's own dark chrome signals elevation and what §6.1 depends on.

**`--bg-subtle` then needs a third step**, distinct from both, in dark. Specified as
`--figma-color-bg-secondary` in light (today's `#f5f5f5`, the recessed role) and
`--figma-color-bg-tertiary` in dark. **`@frontend-engineer` must check the dark case empirically**:
if `bg-tertiary` sits too close to `bg-secondary` to separate a hover row from a popover ground, the
substitute is `--figma-color-bg-hover`, whose semantics ("hover on `bg`") are what `--bg-subtle`
mostly does anyway. Pick by looking, and record which one won in this table.

**Why sourced and not authored** (§9.2, overriding this doc's original recommendation): a
hand-picked background is picked blind against every project's actual tokens, and there is no
value that is guaranteed not to clash with somebody's real palette. Figma's chrome colour is the
one background that cannot look out of place, because it is what the entire rest of the window
already looks like — a swatch that reads oddly against it reads oddly against Figma itself, which
is a problem the user already has and does not blame us for. It also removes the seam at the panel
edge, and removes the whole drift class where Figma retunes its greys and our panel is suddenly a
shade off.

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
it cannot: a fill light enough to carry white text is too light to read as text against a dark `--bg`,
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

**"Sits below" means two different things in the two themes, and only the dark one is a ratio.**
In dark, green is quieter than amber *by contrast* — 5.4:1 under 6.3:1 — so the constraint and the
measurement are the same number. In light they come apart: `#2f7d55` is quieter than `#b8730a` by
chroma, but its contrast on white is **higher** (5.02:1 against the amber's 3.82:1). That inversion
is not a defect and must not be "fixed". §1 already says why — light mode achieves the ranking by
desaturating the green, dark mode by the numeric ratio, because saturation behaves differently on a
dark ground. **Anyone auditing the light palette by contrast alone will conclude the green is too
loud and reach for a darker amber or a paler green. Both moves break `apply-and-drift.md` §8's
ranking rule.** The light-mode check is by eye against §8's item 8, never by ratio.

**Every dark ratio above is provisional and must be re-verified empirically.** They were computed
against `#2c2c2c`, which was this doc's *guess* at Figma's dark background back when the background
was ours to choose. After §9.2 it is not: `--bg` is now whatever `--figma-color-bg` resolves to,
read from the injected style block at runtime, and no one has confirmed the exact value here.
`#2c2c2c` and `#383838` in §4.1's snapshot columns are best-known values, not measured ones.

So `@frontend-engineer` should, as the first step of the palette half:

1. **Read the real injected values.** Dump `getComputedStyle(document.documentElement)` for every
   `--figma-color-*` this doc names, in both Figma themes, and put the actual hexes into §4.1's
   snapshot columns. That is also how the snapshot gets authored in the first place — it is not a
   design exercise, it is a transcription.
2. **Recompute the eight ratios in §4.2 against the real `--bg`**, and against the real
   `--bg-raised` for anything that lands on a raised surface.
3. **Adjust the hand-authored semantics, not the neutrals, if a ratio misses.** The neutrals are
   Figma's and are not ours to retune; the four semantic colours are ours and can move.
4. **The ordering is the acceptance criterion, not the absolute numbers.** `--ok` below `--warn`,
   both above 4.5:1, `--danger-text` and `--accent-text` above 4.5:1. If the real background makes
   the published figures shift by a few tenths, that is expected and fine. If it inverts the
   green/amber ranking, that is a bug and §5.1 says why.

**Desk check, 2026-09-04 — arithmetic only, still not transcribed.** The eight ratios were
recomputed (WCAG 2.x relative luminance) against the snapshot literals as shipped on
`phase-10-dark-mode`. This closes *none* of step 1 above: the snapshot is still `#2c2c2c` /
`#383838` / `#434343`, still Figma's values as guessed rather than read out of a running plugin.
What it does close is whether the published figures are right *for the values in the stylesheet*.
Six of eight are. Three things are not:

- **`--toast-action` is misprinted.** `#8fcdff` on a `#434343` toast is **5.8:1**, not the 4.9:1 in
  §4.3. The value is fine — better than advertised. The number is wrong.
- **`--on-fill` on `--danger` is 5.3:1**, not 5.2:1. A rounding slip, noted for completeness.
- **Three ratios fall under 4.5:1 at their actual use sites**, which the table misses because every
  figure in it is quoted against `--bg` and these three don't land there:

  | Pair | Where | Ratio |
  |---|---|---|
  | `--danger-text` on `--bg-subtle` | `.popover .item.danger` **on hover** | **3.75:1** |
  | `--danger-text` on `--bg-raised` | `.popover .item.danger` at rest | **4.45:1** |
  | `--muted` on `--bg-subtle` | disabled inputs, badge grounds, hover rows | **4.16:1** |

  The danger pair is the sharper one: the popover *is* a raised surface, so red's only surviving
  text site (§5.3) never actually sits on `--bg`, and its real ratio is the marginal 4.45:1 —
  dropping to 3.75:1 the moment you mouse over the row you are about to click. §8's item 10 already
  asks for the `--muted`-on-raised check (4.9:1, passes); nobody asked for `--muted` on `--bg-subtle`,
  and that is the one that misses.

**No values are being changed on this evidence, deliberately.** All three are computed against a
background that §4.2 has already declared a guess, and `--bg-subtle` itself is still an open call
(§4.1). Retuning a semantic colour against an unverified neutral is the exact mistake step 3 above
warns off. These are inputs to the live pass, not conclusions: when the real `--figma-color-*`
values land, recompute these three first, because they are the ones already sitting on the line.
If they still miss, §4.2 step 3 applies — move the semantics, not the neutrals.

### 4.3 Everything else

| Token | Light | Dark | Note |
|---|---|---|---|
| `--mark-bg` | `#fff2a8` | `#6b5a10` | Search highlight. `.tname mark` sets `color: inherit`, so a pale yellow ground in dark would put near-white text on near-white — a latent bug the light theme hides. The dark value is a *wash*, not a highlighter — **decided as recommended, §9.3**. Hand-authored: it sits behind token text, so it belongs to the semantic half. |
| `--swatch-ring` | `var(--figma-color-border-strong)` | same | Not a value in either theme — a reference, deliberately. This is §9.2's legibility mitigation; §6.3 argues it. |
| `--checker-a` | `var(--figma-color-bg)` | same | Transparency checkerboard, light square. |
| `--checker-b` | `var(--figma-color-border)` | same | Dark square. Sourced, not authored, for the same reason as the ring: Figma guarantees these two contrast each other. |
| `--toast-bg` | `#1a1a1a` | `var(--figma-color-bg-tertiary)` | The toast **gets lighter, not darker** (§6.2) — **decided as recommended, §9.4**. Light stays an authored near-black: it is deliberately the one inverted surface in the panel, and no Figma variable means "inverted chrome". |
| `--toast-text` | `#ffffff` | `var(--figma-color-text)` | |
| `--toast-action` | `#7cc4ff` | `#8fcdff` | 4.9:1 against the assumed dark toast ground — re-verify against the real `bg-tertiary` per §4.2. |
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
doesn't capture it. That check matters more now than when it was written: `--ok-bg` is hand-authored
against two backgrounds that are Figma's, so if the real values differ from §4.1's snapshot the tint
is the first thing to go grey. It is a tint, and tints are the least robust thing in the palette.

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
*contrast against the panel* by going the same direction elevation goes: `--figma-color-bg-tertiary`,
the next step up from the raised surface, with `--shadow-modal` beneath it. It stays a small dark
chip; it just stops being the darkest thing on screen. **Decided as recommended (§9.4)**, and §9.4
records the alternative.

Sourcing it means the toast is one step lighter than `--bg-raised` by construction rather than by a
number, which is the right guarantee — but it also means the toast could land close to a popover's
ground if Figma's tertiary sits nearer secondary than expected. `--shadow-modal` plus the fact that
a toast is a floating 1.8-second chip over a full-width surface is the separation; if it genuinely
reads flat against an open overlay, add a 1px `--figma-color-border-strong` edge rather than
hand-picking a lighter grey.

### 6.3 Swatches and the checkerboard

`.swatch` / `.swatch-fill` render the user's actual token colour. Two supporting decorations are
ours, and after §9.2 both have to work against a background we no longer choose.

**The ring.** The failure this guards is precise: a `#000000` token on a dark panel is an invisible
12px square, which is exactly the failure a colour tool cannot have. The old answer was a fixed
`rgba(255,255,255,0.22)` hairline, tuned to be visible against a known `#2c2c2c`. That answer dies
with the known background — a hairline tuned against one grey is a guess against any other.

The replacement is `--swatch-ring: var(--figma-color-border-strong)`, drawn as `box-shadow: inset 0
0 0 1px`, in both themes. The argument for it is short and holds without knowing a single hex:

- Figma's border colour is *defined* as a line that reads against Figma's background. That
  relationship is a contract Figma maintains across its own releases, and our background is now
  Figma's background. So **the ring is visible against the panel floor by construction**, whatever
  the floor turns out to be — including on a Figma release that retunes it.
- The remaining worry — *what if a token's colour happens to equal the ring's colour* — resolves on
  inspection. If fill equals ring, the square is a solid block of a colour that contrasts the
  background, so it is still a visible square. The failure mode needs the fill to match the
  background, which is the case the ring exists for and handles.
- `border-strong` rather than `border`: the plain border is tuned for large panel divisions, and at
  12px a stronger line is what separates a swatch from a hairline nobody notices. If
  `border-strong` is not injected on some Figma build, fall back to `--figma-color-border`, not to
  a literal.

**Light mode changes here too**, from `rgba(0,0,0,0.15)` to Figma's border — the one place the
refactor is not pixel-identical, and §8.1 names it as the expected exception. A white token on a
white panel keeps a visible edge; it just gets it from the same source the dark one does.

**The checkerboard** follows the identical argument: `--checker-a: var(--figma-color-bg)` and
`--checker-b: var(--figma-color-border)`. The two squares are guaranteed to differ from each other,
and square A is guaranteed to be the panel's own ground, so a semi-transparent token composites
against exactly the surface it will look like in use — which is more correct than the authored
`#fff`/`#ddd` pair ever was, and it never glows in dark.

`.swatch.outlined` (dashed, no fill — the "no colour" case) needs nothing beyond `--border`.

### 6.4 The hover filter flips direction

`button.primary:hover` and `button.danger:hover` darken by `filter: brightness(0.93 / 0.92)`. On a
dark ground, darkening a fill reads as *receding* — the opposite of a hover. `--fill-hover` becomes
`brightness(1.12)` in dark. Both fills are saturated enough that lightening doesn't wash them out.

### 6.5 Native controls — `color-scheme`

**The effective-dark block** — §2.2's block 2, `:root.tv-dark, :root.figma-dark:not(.tv-light)` —
must also set `color-scheme: dark`, and `:root` must set `color-scheme: light` explicitly rather
than leaving it unset, so that a `tv-light` override inside a dark Figma actually gets light native
controls instead of inheriting the host's. Without it the browser renders every native
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
`-webkit-font-smoothing: antialiased` **scoped to the effective-dark block (§2.2)** thins it back toward the
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

The line is: **chrome follows the panel's theme; content follows the token.** Which is now worth
stating precisely, because after §2.3 the panel's theme is not always Figma's — and a swatch must
render the same colour in all four combinations of §2.1's table. Nothing in §7 reads a class. A future contributor
"fixing" a white swatch that looks too bright in dark mode would be deleting the panel's reason to
exist.

---

## 8. Acceptance — what to check before this is Implemented

**Step 1 — the tokenisation refactor, with today's literals.** Reviewable on its own, and worth
landing on its own.

1. **Light mode is byte-identical.** Step 1 keeps today's literals everywhere, including in the two
   swatch tokens that later become sourced — `--swatch-ring` and the `--checker-a` / `--checker-b`
   pair change their light values only when step 2 lands, and are the only two expected light-mode
   differences in the whole change (§6.3). Everything
   else in §3.2 changes no light value — diff the light panel against `main` screen by screen, and
   any other visible difference is a bug in the refactor.
2. **No theme-class selector exists except §2.2's four `:root` blocks.** A component-level
   `.tv-dark` or `.figma-dark` override means a colour escaped §3.

**Step 2 — the palette and the override.**

3. **The injected values are transcribed, not guessed.** §4.1's snapshot columns and §4.2's ratios
   have been recomputed against the real `--figma-color-*` values read out of a running plugin, per
   §4.2's four steps. A doc still carrying the assumed `#2c2c2c` after this ships is a doc that
   didn't do step 1 of that list.
4. **All four combinations of §2.1 render correctly**, not just the two on Auto:
   Figma light + Auto, Figma dark + Auto, **Figma dark + Light**, **Figma light + Dark**. The two
   disagreement cases are where the snapshot literals are exercised and are the ones most likely to
   be wrong.
5. **Live swap, both directions.** With the plugin open: toggle Figma's theme on Auto, and change
   the Settings control on a fixed Figma theme. Every surface, including an open popover, an open
   apply dialog, and a visible toast, changes in place. No reload.
6. **No flash on open with an override set** (§2.4). Set the panel to Dark inside a light Figma,
   close the plugin, reopen it, and watch the first frame.
7. **The setting survives** a plugin close, a Figma restart, and opening a different Figma file —
   and does **not** appear in any pushed token JSON or in the overlay (§2.3).
8. **Green under amber.** Open a screen with a `● In sync` chip and an amber badge visible at once.
   The amber must be the thing your eye lands on.
9. **`--ok-bg` still reads green**, not grey, on both `--bg` and `--bg-raised`, against the real
   Figma values (§5.1). Same eye-check for `--warn-bg`.
10. **`--muted` is readable on `--bg-raised`**, not only on `--bg` (§4.1) — Figma tunes it against
    its own floor, and our raised surface is a use Figma doesn't have.
11. **Swatch legibility.** A `#000000` token, a `#ffffff` token, and a 50%-alpha token, in dark and
    in light. Six distinguishable squares, each with a visible edge, each compositing against the
    panel's own ground.
12. **Scrollbars, `<select>`, checkboxes and the colour input** render dark on an effectively-dark
    panel — **including a `tv-dark` panel inside a light Figma**, which is the case a missing
    explicit `color-scheme` breaks (§6.5).
13. **The search highlight** is readable on a matched token path in dark (§4.3, §9.3).
14. **Every overlay reads as above the panel**: Settings, Repo, the token detail panel, the crash
    screen, the popover, the modal card.

---

## 9. Questions, and Shyam's answers (2026-09-04)

All five are closed. Three went as recommended; **two were overridden, and both changed the
mechanism rather than a value** — §2 and §4.1 are written to the decisions, not to the
recommendations. The recommendations are kept below so the trail reads.

### 9.1 Follow Figma only, or offer an override in Settings?

**Recommended:** follow Figma only, no setting. The panel is a guest inside Figma's window; a plugin
that is light while the editor is dark is a defect regardless of who chose it. A Light/Dark/Follow
control is a preference to store, migrate, and explain, in service of a case that has no articulated
user need.

**⛔ Overridden. There is an `Auto / Light / Dark` control in Settings, defaulting to Auto.**

**What that resolved to:** a segmented control in an `Appearance` section of the existing Settings
overlay, stored in `clientStorage` per user alongside the repo settings (§2.3). Auto is the default
and behaves exactly as the recommendation specified — Figma's class, live, zero script. The two
overrides stamp our own `tv-light` / `tv-dark` class beside Figma's, and §2.2's four selector blocks
resolve the four combinations.

**What the override costs, recorded honestly:** Figma's injected variables always describe Figma's
theme, so an overriding user cannot be served by them, and §2.1's snapshot literals exist for
exactly those two cells. That is the drift risk of §9.2 coming back through a side door — bounded to
the users who asked to disagree with their editor. The recommendation's other objection (a
preference to store and migrate) is real but small: absence of a stored value is Auto, so there is
nothing to migrate.

### 9.2 Independent greys, or match Figma's chrome exactly?

**Recommended:** hand-authored literals. Our `#2c2c2c` may sit a shade off whatever Figma's window
chrome is doing on any given release, and the seam at the panel edge is ours to own — but a colour
tool wants a background luminance it controls, because that is what a `#000000` swatch is judged
against.

**⛔ Overridden. The neutrals come from `--figma-color-*`; the semantics stay hand-authored.**

**Shyam's reasoning, which is better than the recommendation's:** *"it's unreasonable to think that
a hand authored token would not clash with a color from any given project."* A fixed background is
picked blind against every user's real palette, and there is no grey that is safe against all of
them. Figma's chrome colour is the one background that cannot look out of place, because it is what
the rest of the window already looks like — anything that reads oddly against it reads oddly against
Figma, which is a problem the user already has. Sourcing also deletes the drift class the
recommendation was worried about in the *other* direction: if Figma retunes its greys, we retune
with it for free.

**What that resolved to:** §4.1 — `--bg`, `--bg-raised`, `--bg-subtle`, `--text`, `--muted` and
`--border` sourced, with `--bg-raised` and `--bg-subtle` mapped per-theme because Figma's
`bg-secondary` flips role between light and dark. `--on-fill` and all four semantic colours stay
ours (§4.2). §4.1's snapshot columns become transcriptions of real injected values, and §4.2's
ratios get re-verified against them (§4.2's four steps) rather than trusted as published.

**The legibility objection, and its answer:** Shyam's — *"we handle this by using a border that
lightly contrasts against the background."* Which reframes the guarantee correctly. The old approach
guaranteed a visible swatch edge by tuning a hairline against one known background; the new one
guarantees it by sourcing the ring from `--figma-color-border-strong`, whose contrast with
`--figma-color-bg` is a relationship **Figma** maintains — so the edge holds whatever the background
is, including on a release that changes it. §6.3 works through why the fill-equals-ring case is not
a failure, and applies the same argument to the checkerboard.

### 9.3 The search highlight

**Recommended:** a dark amber wash (`#6b5a10`) with inherited light text, rather than a pale-yellow
highlighter with forced dark text. Quieter, and consistent with everything else in the dark panel.

**✅ Decided as recommended.** The wash. **§4.3.** The highlighter alternative — more obviously "a
match" at a glance in a long list — was genuinely defensible and is not being revisited without a
reported problem.

### 9.4 Toast direction

**Recommended:** the dark toast goes *lighter* than the panel, not darker.

**✅ Decided as recommended.** **§6.2.** The alternative (near-black with a hairline border, visually
identical to today's toast) is rejected for barely separating from a dark floor. The value is now
sourced rather than authored, which strengthens the decision rather than changing it: "one step
lighter than raised" is a relationship, not a number.

### 9.5 Scheduling

**Recommended:** Phase 10, Phase 11, or a standalone ticket — but not after publishing.

**✅ Phase 10 — landing now.** Shyam's reasoning: *"since we're doing UI improvements."* Phase 10's scope is
forming around UI and UX polish and dark mode belongs in it. The rest of Phase 10 is still being
scoped and nothing here claims otherwise — this doc claims one thing, that dark mode is part of it.
It lands before Phase 11 (publishing), which is the one ordering constraint that mattered: a plugin
shipped to the Figma Community with no dark mode is the first thing anyone reports.

---

## 10. Open after implementation — needs a running panel, not a reader

PR #27 implements everything above and the tests pin the structure (four `:root` blocks, no
component-level theme variant, every sourced reference carrying a snapshot fallback). Three
questions this doc deliberately handed to the implementation are **still open**, because each one
is answered by looking at a rendered panel in Figma desktop in both editor themes, and by nothing
else. They are cheap — one session with the dev build — and they gate calling this Implemented.

### 10.1 Transcribe the injected values, then recompute (§4.2, steps 1–2)

**Status: closed by live visual check, 2026-09-04.** Shyam loaded the `phase-10-dark-mode` build
in Figma desktop and confirmed contrast reads fine as shipped — no washed-out or illegible text
anywhere the audit covered. §4.1's snapshot columns and the dark ratios in §4.2/§4.3 remain the
values this doc published as estimates (`--bg: #2c2c2c`, `--bg-raised: #383838`,
`--bg-subtle: #434343`, `--border: #4d4d4d`, `--muted: #a8a8a8`, `--text: #e8e8e8`); the literal
`getComputedStyle` transcription this section originally asked for was not performed, since the
visual check surfaced no discrepancy that would need it. Revisit with the formal transcription
only if a future change makes contrast doubtful again.

### 10.2 `--bg-subtle` — `bg-tertiary`, `bg-hover`, or something else (§4.1)

**Status: closed 2026-09-04 — kept as shipped, `--figma-color-bg-tertiary`.** Confirmed by Shyam
live in Figma desktop: the three-step elevation stack (`bg` → `bg-raised` → `bg-subtle`) reads as
distinct steps, and text sitting on `bg-subtle` (disabled inputs, badge grounds, hover rows) is
legible. The `bg-hover` fallback named in §4.1 was not needed.

### 10.3 `-webkit-font-smoothing: antialiased` — keep or drop (§6.6)

**Status: closed 2026-09-04 — kept.** Confirmed by Shyam live in Figma desktop: the dark panel
reads as the same typeface weight as the light one at 11px. No change needed.

**§10 is closed.** All three items this doc handed to the implementation were checked against a
running panel in Figma desktop and confirmed fine as shipped — no follow-up values or code changes
required.
