# UX: User journeys (as built, Phases 1–9)

**Status:** Survey — not a spec. Every journey below describes what the panel does **today**, after
Phases 1–9. Nothing here proposes new design; §12 and §13 name where the built thing is rough, and
that is the whole point of the document. Amend it when a phase changes a flow.
**Owner:** `@ux-designer`
**Covers:** PRD §6.1–§6.7 end to end, build plan §9 Phases 1–9. Written to inform **Phase 10's TBD
scope** (PRD §9.10) — it does not decide it.
**Grounded in:** `local-editor.md` (P4), `apply-and-drift.md` (P5), `git-sync.md` (P6),
`references-math-themes.md` (P7), `error-states.md` (P9), the shipped export pipeline
(`scripts/export.mjs`, `.github/workflows/export-tokens.yml`, `README.md` "Exporting to code"), and
ADR-0002 through ADR-0007.

---

## 1. What this doc is, and isn't

The five existing UX docs are each **vertical**: one phase, one feature, one screen inventory. Each one
is correct and each one assumes the reader already has the rest. Nothing in `docs/ux/` has ever traced
a **horizontal** line — one person, one afternoon, one Figma file, from *"I opened the plugin"* to
*"the CSS is in my codebase"* — and that horizontal line is where the seams show.

So this doc reads the panel the way its one user does: as a sequence, not as a feature set.

Three rules it holds itself to:

1. **Only what is built.** Every step cites the doc and phase that specifies it. Where a journey
   requires leaving the plugin, doing something by hand, or accepting that a thing is not there, the
   step says so in the step, not in a footnote.
2. **No new design.** Where a journey is rough, §13 records the roughness and stops. Naming a fix
   would be scoping Phase 10, which is Shyam's call from this document plus discussion (§14).
3. **The panel's own vocabulary.** *Changed in Figma*, never "drift" (`apply-and-drift.md` §3).
   *Uncommitted*, not "unsaved" (`git-sync.md` §3). **Apply** writes the canvas, **Commit/Push**
   writes the repo, **Pull** writes neither.

---

## 2. The user, the file, and the three places a token can live

One user (PRD §5: Shyam). One 460 × 640 px panel. And — this is the fact every journey below turns on
— **three places the same token exists**, added one phase at a time:

| Place | Since | What it is | What moves a token into it |
|---|---|---|---|
| **Figma** — Variables and Styles | always | The file. The thing a designer actually looks at. | **Apply** (P5) |
| **The tree + overlay** — the plugin's working copy | P2 scan, P4 overlay | An import result in `clientStorage`, plus edit intent layered over it (ADR-0004 §1) | **Scan**, then editing (P4), then **Pull** (P6) |
| **The repo** — `tokens/*.json` on a branch | P6 | The source of truth (ADR-0006 §2) | **Commit / Push** (P6) |

Plus a fourth that only ever *receives*: **`exports/css/*.css`**, written by CI or by hand from the
repo (P8). Nothing in the plugin reads it back.

The state legibility problem this panel exists to solve is: *given three copies that can each move
independently, say which one is ahead, in 140 px, without lying.* The header chip is the answer
(`git-sync.md` §6.1, `references-math-themes.md` §9) and every journey below passes through it.

```
   Figma file  ──scan──▶  tree + overlay  ──push──▶   repo   ──CI──▶  exports/css
       ▲                      │      ▲                  │
       └────────apply─────────┘      └──────pull────────┘

   chip left half  ──────┘              └────── chip right half
   [ 7 local · 3 changed │ ↑ 3 ]
```

---

## 3. The journeys, at a glance

| # | Journey | Phases it crosses | Verdict |
|---|---|---|---|
| A | First run — fresh file to first push | 2, 3, 4, 6 | Works. Longest unassisted stretch in the product; §4.4. |
| B | Day-to-day edit loop | 4, 5, 6 | Works, and is the one flow with no missing pieces. |
| C | Authoring a reference, an expression, a theme | 7 | Authoring works; **theme composition and rename do not exist**. |
| D | Someone else pushed — the pull loop | 6, 5 | Works, with one dead end: tokens the repo has and Figma doesn't. |
| E | Divergence | 6 | Works, and is deliberately a refusal. |
| F | Export to code | 8 | Works — **entirely outside the plugin**. Largest seam in the product. |
| G | Recovering from an error | 9 + every phase's own table | Covered. The audit in `error-states.md` §5 is the evidence. |
| H | Second machine, second file, or a returning user | 4, 6 | Partly built. The least-designed journey. |

---

## 4. Journey A — first run: a fresh Figma file to a first push

The bootstrap. Nothing in `clientStorage`, no repo, 1,316 tokens sitting in Figma that have never been
a file.

| # | The user | The panel | Source |
|---|---|---|---|
| 1 | Runs the plugin from **Plugins → Development** | Import tab. Tokens tab disabled: *"Scan the file first"* | `local-editor.md` §3 |
| 2 | **Scan file** | Reads every collection/mode and every paint/text/effect/grid style in one pass; merges them; Variables win collisions and both sides are named | ADR-0002, ADR-0003; `README.md` "The import" |
| 3 | Reads the report | Counts, generated file list, and the fail-loud rows: 132 unconfirmed subtypes, 13 flagged, 3 partial in the Folio fixture | `local-editor.md` §1 |
| 4 | Confirms subtypes / tags a duration | Number Variables Figma couldn't scope are `spacing` / `subtypeSource: "default"` until confirmed; duration and easing arrive **only** as an explicit tag | PRD §6.1; ADR-0002 Am.1 §A |
| 5 | Switches to **Tokens** | Merged tree, one row per dotted path, value lines per set. Header chip: `132 local` or similar, from the tagging in step 4 | `local-editor.md` §4.2, §5.4 |
| 6 | Opens **⚙ Settings** | Repo, branch (a picker, fetched), tokens folder, PAT — write-only field, last four shown, `[ How ↗ ]` for the scope instruction | `git-sync.md` §5.2 |
| 7 | *Leaves the plugin.* Creates a fine-grained PAT on github.com, scoped to one repo, Contents: read **and** write | Nothing. This step is entirely outside the panel | PRD §6.4 (PAT in v1) |
| 8 | Pastes the token, **Test connection** | `● Connected · main · checked just now`, or §11's named failure under the field that caused it | `git-sync.md` §5.2, §11 |
| 9 | **Connect** | Repo empty → no modal, baseline empty, chip reads `↑ 12`. Repo already has tokens → the phase's only modal, *"Which one should Tokenvault start from?"*, repo preselected | `git-sync.md` §5.3 |
| 10 | **Repo tab → Review… → Commit to main** | File-shaped diff with token rows nested, editable message, per-file checkboxes | `git-sync.md` §7.2 |
| 11 | Sees `● In sync` | Green, no divider, and it now means *all three agree* | `git-sync.md` §6.1 |

### 4.1 What's genuinely good here

**First connect asks one question and defaults to the non-destructive answer.** ADR-0006 §4's state
table calls every file diverged on connect, which is true and useless; §5.3 replaces it with a modal
that shows counts, preselects *the repo*, and states that nothing is written yet. The rejected
alternative — open the Repo tab with 12 diverged files — was more honest and a miserable first five
minutes.

**Nothing is silently dropped at import.** Gradients, image fills, stacked paints and blur-only
effects are flagged, not mangled (PRD §11's stated risk, discharged in ADR-0003).

### 4.2 Where it's rough

- **Step 7 is a hole in the middle of the flow.** The one moment a first-time user is most likely to
  stall — GitHub's fine-grained token screen, three choices, one of which silently produces a
  read-only token that works until the first push (`git-sync.md` §11, *"This token can only read the
  repo"*) — happens with the plugin closed. `[ How ↗ ]` is the entire assistance.
- **Step 4 is 132 decisions with no batch affordance.** The subtype confirm list is per-token by
  design (`local-editor.md` §1: import-quality state is visible *inside* the browser), but a fresh
  import of a real file starts with a three-digit queue and nothing that says *"these 90 are all
  `spacing`, accept them all"*.
- **The chip's first-ever reading is `132 local`**, from confirmations rather than edits. That is
  correct — a subtype tag is an overlay entry — and it reads as *"I have made 132 changes"* on a file
  the user has not yet touched.
- **There is no "you are done" moment.** `● In sync` is it, and it is a chip.

---

## 5. Journey B — the day-to-day edit loop

The one that runs a hundred times. Also the only journey with no missing piece.

```
edit a token ──▶ chip: [ 8 local │ ↑ 3 ] ──▶ Apply ──▶ rescan ──▶ Review… ──▶ Commit
   P4 §5           P5 §6.3 / P6 §6.1        P5 §5.2   ADR-0005 §6   P6 §7.2
```

| # | The user | The panel | Source |
|---|---|---|---|
| 1 | Taps a value line, edits it inline (scalar) or in a full-panel overlay (composite) | The tree updates immediately; the edit persists to `clientStorage` as intent, not a snapshot | `local-editor.md` §5.1, §5.4; ADR-0004 §1 |
| 2 | Watches the chip | `Local edits · N` becomes the left half of the two-half chip once connected | `git-sync.md` §6.1 |
| 3 | **⋯ → Apply**, or applies from the Changes list | A modal — never a silent write. Lists Figma targets grouped Variables / Styles. Conflicted targets are refused, not auto-resolved | `apply-and-drift.md` §5.2; ADR-0005 §5 |
| 4 | Confirms | Writes only the edited overlay. References apply as **native Figma aliases**, not flattened values | `apply-and-drift.md` §5.6 |
| 5 | Wants to undo | ⌘Z, and the dialog footer says so. There is no plugin-side undo for canvas writes | `apply-and-drift.md` §5.5 |
| 6 | Post-apply | Automatic rescan retires the applied entries; states collapse downward to *in sync* | ADR-0005 §6; `apply-and-drift.md` §3 |
| 7 | **Repo tab → Review…** | Diff grouped by file, token rows nested; message; commit | `git-sync.md` §7.2 |
| 8 | Success | Toast with `[ View commit ↗ ]` — the entire git-client surface Tokenvault offers | `git-sync.md` §7.5 |

**The interleaved case: someone edited the file in Figma.** A rescan finds it and the token gets `⚑`
*Changed in Figma*. Resolution is the two-value compare block, per token, in the detail overlay:
`[ Put back ]` / `[ Take Figma's ]` (`apply-and-drift.md` §6.4). Once connected, that block rebaselines
against the repo rather than the last scan (`git-sync.md` §10) — which is the single most invisible
upgrade in the product, and §10.3 makes connecting say so.

### 5.1 Where it's rough

- **Nothing pushes on its own, and that is decided** (`git-sync.md` §8.5). A day of editing and
  applying leaves the repo untouched until someone taps Review. The chip is the only reminder.
- **"Changed in Figma" is found by rescanning, never proactively.** Drift is a changelog against a
  watermark, not a live comparison (`apply-and-drift.md` §6.1, post-build revision). A designer who
  edits Variables directly for two hours sees nothing until they rescan.
- **Steps 3 and 7 are two confirmations of the same intent** — "make my edits real, in Figma; make my
  edits real, in the repo" — with different units (targets vs. files) and different screens. Correct
  per §3 of `git-sync.md`, and it is still two full review passes over one change.

---

## 6. Journey C — authoring a reference, an expression, or a theme

| # | The user | The panel | Source |
|---|---|---|---|
| 1 | Types `{` in a value field | Path picker over the merged tree, three groups — including the cycle-forming candidates, shown but untappable | `references-math-themes.md` §4.2 |
| 2 | Types `{core.space.4} * 2` in the same field | **No mode toggle.** One field takes a literal, a reference or an expression; a resolve line shows the computed value | §4.1, §6.2 |
| 3 | Writes `{a} * 1` | The editor commits it and offers a one-tap swap to the plain reference — the **only** steering nudge, because a warning on every correct use is how `⚑` stops meaning anything | §6.5 |
| 4 | Creates a loop | The cycle renders as **the loop itself, with no value at all** — never a zero, never the last good number. One component, three callers: value field, detail overlay, apply dialog's blocked row | §7.1–7.3; `error-states.md` §5.3 |
| 5 | Switches the theme chip | Re-resolves every reference and expression in the panel. **Writes nothing** — not canvas, not overlay, not repo. Toast: *"Resolving against Dark. 3 tokens have no value in this theme."* | §8.1, §8.3 |
| 6 | Wants the canvas to follow | A separate, explicitly labelled `[ Switch this page to Dark ]` in the popover footer — the only thing in Phase 7 that touches the document. Page scope, settled by the API: `PageNode` carries `ExplicitVariableModesMixin`, `DocumentNode` does not | §8.4; ADR-0007 open question 1 |

### 6.1 Where it stops

- **Theme composition does not exist.** No new theme, no rename, no set checkboxes — a picker, not an
  editor (`references-math-themes.md` §2, ADR-0007 §7b unbuilt). PRD §6.2's *"themes composed from
  combinations of token sets"* is met only where Figma's collections already compose them.
- **A file with 2+ multi-mode collections gets no themes at all**, and the chip says
  `Theme: none ▾` with a full explanation rather than disappearing (§8.5). That is the right copy for
  a limitation, and it is still a limitation with no path through it inside the plugin.
- **Sub-key references on composites are not authorable** — a typography token's `fontSize` cannot be
  set to `{a}`; `boundVariables` are displayed and the numeric fields take numbers (§2, ADR-0007 §10).
- **Rename does not exist**, and it is the one deferral that was explicitly pointed at Phase 7 and did
  not land there. `local-editor.md` §10.5 deferred it *"to Phase 7, where inbound references can be
  rewritten"*; Phase 7's §2 handed it back to ADR-0004's open questions. ADR-0004 defines
  `set-value`, `set-description` and `delete` ops and **no rename op**, so this needs an ADR amendment
  before a UX spec, not the reverse.
- **Creation does not exist** either (`local-editor.md` §6), which is what makes the picker's rule 1 a
  refusal rather than an offer to create (`references-math-themes.md` §5.1).
- **A deeply-referenced token can be permanently undeletable.** Delete is blocked while anything
  points at it, the explanation panel lists every referrer as a tap target, and there is deliberately
  no *"remove all references"* button (`local-editor.md` §7). Phase 7 made re-pointing *possible*, one
  token at a time; it did not make it quick.

---

## 7. Journey D — someone else pushed

| # | The user | The panel | Source |
|---|---|---|---|
| 1 | Opens the panel | Status is checked automatically, per file, on open and on tab open — one cheap request, so *"Checked just now"* is usually literally true | `git-sync.md` §6.2; ADR-0006 §4 |
| 2 | Sees `↓ 2` | Right half of the chip. Taps it → Repo tab, files listed with token counts | §6.1, §6.2 |
| 3 | **Pull 2 files** | **Does not change Figma.** Materializes as pending overlay entries tagged `from repo`. Toast: *"Pulled 12 changes from `main`. They're pending — apply them to update Figma."* | §8.1, §8.2 |
| 4 | Watches the chip | `↓ 2` → `12 local`. State visibly hops from the repo half to the Figma half — the clearest demonstration of what pull just did | §8.1 |
| 5 | Applies | Phase 5's dialog, unchanged. Pulled references hit the alias-apply path built in P5 and unreachable until now | §8.3; `apply-and-drift.md` §5.6 |
| 6 | Hits a conflict | Phase 4's block, with the other side finally nameable: *Yours* / *From the repo* | §8.2; ADR-0006 §5 |

### 7.1 Where it's rough

- **The dead end is step 5.** Tokens the repo has and this file doesn't are listed, named, and given a
  workaround — *"Add these in Figma and scan again"* — because **Tokenvault can update a Variable or
  Style but cannot create one** (`git-sync.md` §8.4; ADR-0006 §11 deferred, still deferred). The copy
  is honest and the workaround is real manual labour, per token, in Figma's own UI.
- **That same gap makes a repo-first workflow impossible.** A repo authored outside Tokenvault pulls
  in read-only. There is no path from *"the tokens exist in git"* to *"the tokens exist in this Figma
  file"* that does not run through a designer hand-building Variables.
- **Pull that means "not yet"** is architecturally right and permanently counterintuitive; §8.1 spends
  a paragraph on the one sentence that has to land.

---

## 8. Journey E — divergence

Short, and deliberately a refusal.

Both sides moved on one file. The chip's right half goes amber and takes the whole half —
`1 diverged`, a word and never a glyph, because it is the one term the user has no reason to know
(`git-sync.md` §6.1). It blocks **per file, never globally**: ten clean files still push in one commit
(§9.1). It is never a modal, never a banner over the Tokens tab; the user came here to edit tokens and
can keep doing that.

`[ Sort this out ]` opens the Diverged files screen: both sides summarized with counts first, the
overlap called out separately — *"2 tokens changed on both sides"*, the number that says whether this
is a collision or two people in different corners — `[ Compare ]` for a read-only token-level diff,
and two symmetrically-styled buttons, `[ Take the repo's ]` / `[ Keep mine ]`, whole-file (§9.2).

**There is no third option and no greyed one**, because per-token picking *is* the three-way merge
ADR-0006 §6 refuses, and a UI for it here would be smuggling it in.

**Where it's rough:** whole-file granularity is the correct v1 call and it is also the moment the user
most wants the thing the design refuses. `[ Compare ]` shows them exactly which four tokens they are
about to discard and offers no way to keep two of them. The escape hatch is outside the plugin —
resolve it in a real git client and re-scan.

---

## 9. Journey F — export to code

The largest seam in the product, and it is a seam by design (PRD §6.6, §7: Style Dictionary runs
locally or in CI, never in the plugin).

| # | Where | What happens | Source |
|---|---|---|---|
| 1 | Plugin | Push token JSON to `tokens/` on `main` | `git-sync.md` §7 |
| 2 | GitHub Actions | `push` on `tokens/**` triggers `export-tokens.yml`; the `paths:` filter is also the loop guard, since output goes to `exports/`, outside the token folder | `.github/workflows/export-tokens.yml` |
| 3 | CI | `npm run build:tokens` — one CSS build per theme enumerated from `$manifest.json`. Order is **theme → references → expressions**, because an expression's operands resolve through the active theme's stack, so `{a} * 2` is a different number in Light than in Dark | `README.md`; ADR-0007 |
| 4 | CI | A cycle, dangling reference, or expression error **fails the whole build and writes nothing** — never a partial or wrong stylesheet | PRD §9.8 |
| 5 | Repo | `exports/css/<theme>.css` committed back. `--check` gates staleness without writing | `README.md` |
| 6 | The designer | Learns none of this from the plugin | — |

Validated for real: 1,162 CSS properties per theme, correct light/dark divergence, `--check`
behaving, against a live test repo (PRD §9.8).

### 9.1 Where it's rough

- **The plugin says nothing about export, before or after.** Phase 7 wrote the boundary explicitly:
  *"Nothing in the panel promises anything about what an expression becomes in exported code"*
  (`references-math-themes.md` §2). The consequence is that the last leg of PRD §10's success metric
  — token → code — is invisible from the surface the user works in. A push that produced a red build
  reads, in the panel, as `● In sync`.
- **`tokensDir` is duplicated by hand.** It is a user setting in the plugin (ADR-0006 §3), and it
  appears twice in the workflow — the `paths:` filter and `TOKENS_DIR` — because GitHub forbids
  expressions in a path filter. Changing the folder in Settings and not editing the workflow produces
  *a build that never triggers*, which is the quietest possible failure. The workflow header and the
  README both warn; the panel does not, and the panel is where the setting lives.
- **A cycle costs a build.** Cycles are caught at three checkpoints in the plugin (editor, build/merge,
  apply plan — ADR-0007), and a theme-scoped cycle that no one authored in the editor can still reach
  the repo and fail CI. The plugin has the loop; CI reports it somewhere else.

---

## 10. Journey G — recovering from an error

Phase 9's contribution, and the audit behind it is the evidence this journey holds up.

| What broke | What the user gets | Source |
|---|---|---|
| Scan throws | Notice **prepended** to the existing Import view — the previous report survives, the Tokens tab is never disabled, the cached tree is still valid | `error-states.md` §2.1 |
| Scan never returns | Its own treatment | §2.3 |
| Unhandled exception | A real crash screen, not a blank iframe. A message, never a stack. Recovery via the `ui-ready` handshake, not `location.reload()` | §3 |
| `clientStorage` overlay unreadable | The blob is **quarantined to a separate key before any write can reach the live one**, whatever parses is recovered, and the panel reports what was dropped — it never poses as "no local edits" | §4 |
| Storage quota full | *"Your changes are still in this session. Copy the tree as JSON before closing the panel."* | `local-editor.md` §5.4 |
| Apply fails | `.entry` notice naming what failed; failed edits stay in the overlay and stay visible in the tree | `error-states.md` §5.2 |
| Delete-in-Figma fails | The confirmation **stays open**; a retry resends only what is still pending | §5.1 |
| GitHub says no | Thirteen named states, no bare status codes — offline, 401, 404, 403 rate limit, read-only token, branch moved mid-push | `git-sync.md` §11; ADR-0006 §10 |
| A cycle blocks an apply | The blocked row carries `[ Show the loop ]`, keyed by `(setId, path)` — a path-only lookup answered a sibling row with another set's cycle | `error-states.md` §5.3 |

The convention holds across all of it: **notice** (`.entry`) for a failure the user must act on,
**toast** only for a success whose result isn't on screen, because a toast carrying the only copy of
an error is a lost error (`error-states.md` §1).

**Where it's rough:** three states in `error-states.md` were flagged as not-yet-validated live in
Figma desktop as of 2026-09-04 — a manual checklist was handed to Shyam and not yet returned. And the
one row with no implementation and no plan is *"file is read-only (viewer, branch permissions)"*:
Figma exposes no capability check, so a failed write is the only way to find out, and that lands in
the apply-failure notice with Figma's own refusal in it (§5.5). Recorded, not hidden.

---

## 11. Journey H — the second machine, the second file, the return after a month

The least-designed journey, because no phase owned it.

| Situation | What actually happens | Source |
|---|---|---|
| **Second Figma file, same repo** | Settings already has the repo and token — they're the *user's*. The connection is the *file's*, so the status line reads `● Not connected for this file · [ Connect ]`. The panel doesn't explain the split; it shows it | `git-sync.md` §5.2; ADR-0006 §3 |
| **Second machine** | PAT and overlay both live in `clientStorage`, which is per-device and unsynced. The token must be re-entered. Uncommitted edits are **not there** — that is what *local* was always the honest word for | `local-editor.md` §5.4; ADR-0004 |
| **Browser data cleared** | The overlay is gone. `[ Copy whole tree as JSON ]` stays prominent precisely because of this | ADR-0004 §Consequences |
| **Return after a month** | Cached import loads; status is re-checked on open; drift is measured against a **watermark from a month ago**, so the first rescan can report a great deal at once | `apply-and-drift.md` §6.1 |
| **Stored theme is gone** after a rescan or pull | Falls back to the first theme in the manifest and says so: *"`Brand` isn't in this file any more. Showing `Light` instead."* | `references-math-themes.md` §8.3 |

**Where it's rough:**

- **A per-device overlay against a per-repo source of truth is a real asymmetry**, and it means
  "uncommitted work" is genuinely at risk in a way "unpushed commits" in a git client are not.
  Everything about the design is honest about it; nothing about the design reduces it beyond urging a
  push.
- **Subtype confirmations are ambiguous here.** The `README.md` import section says user tags are held
  in `clientStorage` and *"tags still live in the overlay regardless of connection state"*, while
  `subtype` is a `$extensions.com.tokenvault` field that travels in the pushed JSON. Whether 132
  confirmations made on machine A survive to machine B — via pull — or have to be redone is a
  question this doc will not guess at. **Open for Shyam / `@tech-lead`** (§14).
- **One branch, no PR flow.** Push commits directly to the selected branch (`git-sync.md` §7.5, §13.4
  — decided). Fine for one person on `main`; the moment a second person appears it is the constraint
  they hit first.

---

## 12. The seams between phases

Journeys A–H cross five phase boundaries. Four of them are invisible. These are the ones that aren't.

| Seam | What the user experiences | Why it is that way |
|---|---|---|
| **Editor → Apply** | Two confirmations for one intent, at two different units | Deliberate: apply lists Figma targets, commit lists files (`git-sync.md` §3) |
| **Apply → Push** | Same again, a second time | Same |
| **Pull → Apply** | *Pull* means "not yet" | Reuses P5's one write path instead of building a second (ADR-0006) |
| **Push → Export** | **A wall.** Nothing crosses back | Export is repo-side by architecture (PRD §7) |
| **Import report → Tokens tab** | Import-quality state (`⚑ 12`, `● 4`) is carried into the browser as filter chips | Deliberate and good — `local-editor.md` §1 |
| **Figma → tokens, for things Figma doesn't have** | No path at all: no create, no rename, no theme authoring | Three separate deferrals (P4 §6, ADR-0004 open questions, ADR-0007 §7b) that happen to land on the same user need |

The last row is the one worth staring at. Token creation, path rename, theme composition, sub-key
references, and creating a Variable for a pulled token were each deferred for a **good local reason**,
in four different documents, at four different times. Read horizontally they are one thing:
**Tokenvault can edit what Figma already made, and cannot author anything Figma didn't.** No single
phase decided that; it is the sum of five decisions none of which was wrong.

---

## 13. Candidate gaps and friction — input to Phase 10 scoping

**Not a recommendation, and not ordered by priority.** Each row states the gap, the journey it hurts,
where it came from, and roughly what it would cost to close. Phase 10's scope is Shyam's call from
this list plus discussion (PRD §9.10).

### 13a. Authoring gaps — the horizontal theme of §12

| # | Gap | Hurts | Origin | Rough cost |
|---|---|---|---|---|
| 1 | **No token creation** | A, D | Deferred P4 §6, 2026-09-01, for want of a consumer. Consumers now exist: P5 applies, P6 commits | UX spec + ADR-0004 op. The stated reason for deferring has expired |
| 2 | **No path rename** | C | Deferred P4 §10.5 *to Phase 7*; Phase 7 handed it back | **ADR-0004 amendment first** — there is no rename op. Then reference-rewriting UX |
| 3 | **No theme composition** | C | ADR-0007 §7b designed, deferred by Shyam 2026-09-03 | Design exists in the ADR; unbuilt. Would also discharge §8.5's `Theme: none` case |
| 4 | **Can't create a Figma Variable/Style for a pulled token** | D | ADR-0006 §11, "its own ticket, probably its own ADR" | The one that makes repo-first workflows possible at all |
| 5 | **No sub-key references on composites** | C | ADR-0007 §10, own ticket | Narrow, well-bounded |
| 6 | **`bind to selected layers` never shipped** | — | `apply-and-drift.md` §5.4 is written and is that ticket's spec; ADR-0005 §12 deferred it | **The only unmet line in PRD §6.5.2.** Spec is done; property mapping needs subtype confirmation |

### 13b. Seam friction

| # | Friction | Hurts | Origin |
|---|---|---|---|
| 7 | **Export is invisible from the panel** — no build status, no link to `exports/`, no warning that a push may have failed CI | F | PRD §7's architecture; nothing has ever proposed a surface for it |
| 8 | **`tokensDir` duplicated between Settings and the workflow**; a mismatch is a build that never runs | F | GitHub forbids expressions in `paths:`. Warned in two places, neither of them the panel |
| 9 | **A cycle is caught three times in the plugin and can still fail CI** | C, F | Correct in both places; nothing joins them |
| 10 | **Two review passes for one change** (apply dialog, then Review & push) | B | Deliberate — two units (`git-sync.md` §3). Named here because it is the most-repeated friction in the most-repeated journey |

### 13c. Onboarding and first-run

| # | Friction | Hurts | Origin |
|---|---|---|---|
| 11 | **PAT creation happens outside the plugin**, at the exact moment a first-timer is most likely to stall | A | PRD §6.4 (PAT in v1). `[ How ↗ ]` is the whole assist. Note PRD §11 already flags the PAT/OAuth tradeoff for revisiting *"once v1 is in daily use"* — which is now |
| 12 | **132 subtype confirmations with no bulk affordance** | A | Per-token by design (`local-editor.md` §1); the design never sized the queue |
| 13 | **First-ever chip reads `132 local`** on an untouched file | A | Correct — a tag is an overlay entry — and it reads as 132 changes |
| 14 | **No plugin-side README, tour, or empty-state that explains the three-place model** | A, H | Every empty state is excellent locally; none of them explains the system |

### 13d. Durability and multi-context

| # | Friction | Hurts | Origin |
|---|---|---|---|
| 15 | **Overlay and PAT are per-device**; uncommitted work doesn't travel | H | ADR-0004, honest about it throughout. Mitigated only by "push often" and Copy-as-JSON |
| 16 | **Subtype confirmations across machines: unclear** | H | Contradiction-shaped gap between `README.md` and ADR-0004. **Needs an answer before it needs a design** |
| 17 | **Drift measured against a watermark that can be a month old** | H | `apply-and-drift.md` §6.1. Correct and cheap; the first rescan after a long gap is a wall of `⚑` |
| 18 | **One branch, no PR flow** | E, and any second person | Decided out, `git-sync.md` §13.4. Revisit only if PRD §5's "secondary users later" becomes now |

### 13e. Loose ends already on the books

| # | Item | Origin |
|---|---|---|
| 19 | Phase 9's three new error states are **not yet validated live in Figma desktop** — a manual checklist is with Shyam | CLAUDE.md, Phase 9 |
| 20 | `apply-and-drift.md` §5.4 (bind) is an **implemented doc with a section that has no code** | `docs/ux/README.md` |
| 21 | `Theme: none` files — ADR-0002 §6's `ambiguous` deferral is **still undischarged** after Phase 7 | `references-math-themes.md` §8.5 |
| 22 | **Publish target** — private install vs. Figma Community — moved out of Phase 9 into Phase 11 | PRD §9.11 |

**One observation offered without a recommendation:** items 1–6 are six separate tickets and one
sentence. Items 7–9 are three symptoms of one missing surface. Whether either grouping is a phase is
not this document's call.

---

## 14. Open questions — for Shyam

Surfaced rather than guessed at, per the operating principle.

1. **Subtype confirmations across machines** (§11, gap 16) — do the 132 tags survive a push/pull round
   trip to a second device, or are they redone? `README.md` and ADR-0004 read differently. This is a
   fact about the implementation before it is a design question; `@tech-lead` or
   `@frontend-engineer` can settle it, and the answer decides whether there is anything to design.
2. **Does Phase 10 have a theme?** §13's five groups are five different products: an *authoring*
   phase (13a), a *pipeline visibility* phase (13b), an *onboarding* phase (13c), a *durability*
   phase (13d), or a cleanup phase (13e). Picking one is more coherent than picking the top item from
   each.
3. **Is Phase 11 still the last phase?** Several items in 13a are things a Community listing would be
   judged on — a stranger who installs Tokenvault and cannot create a token will file that as a bug,
   not a deferral. If publishing stays public, 13a and Phase 11 are related; if it stays private, they
   are not.
4. **PRD §11's PAT/OAuth revisit** (gap 11) says *"once v1 is in daily use."* Is it?
