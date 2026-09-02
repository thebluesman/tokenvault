# UX: Git sync (Phase 6)

**Status:** Provisional — written ahead of the build. Six questions in §13 are open and marked; everything else is specified.
**Owner:** `@ux-designer`
**Covers:** PRD §6.4 (git sync, PAT auth, branch selection, pre-commit diff), §6.7 (plugin panel — sync status indicator, settings panel), build plan §9 Phase 6.
**Builds on:** `docs/ux/local-editor.md` (Phase 4) and `docs/ux/apply-and-drift.md` (Phase 5) — same panel, same 460 × 640 px, same vocabulary. Read both first; this doc extends them and does not restate them.
**Depends on:** ADR-0006 (`docs/adr/0006-git-sync.md`) — **Proposed**. Where this doc and the ADR disagree, the ADR wins and this doc gets amended.
**Amends:** `docs/ux/apply-and-drift.md` §6.4. Phase 5 wrote temporary drift copy and said so; §10 here takes it back, exactly as that section predicted.

---

## 1. What we're designing against

Phase 5 removed the sentence *"editing a token changes nothing on the canvas."* Phase 6 removes a bigger one: **until now, the tokens have only ever lived in this Figma file.** Three things become true the moment a repo is connected, and every design decision below falls out of one of them.

| New fact | Source | What it forces |
|---|---|---|
| **The repo is the source of truth; Figma is a rendering of it.** | ADR-0006 §2 | Every state label in the panel has to say *in sync with what*. Phase 5's `In sync` meant "the tree matches Figma". It now has to mean all three agree, or it is a lie. §3, §6. |
| **There is a third party that can change things, and it isn't in the room.** | ADR-0006 §4 | The panel needs a state the user did not cause and cannot see coming — remote changes — and a blocking one for when both sides moved. §8, §9. |
| **Sync status is one API call and costs nothing.** | ADR-0006 §4 | So it can be answered live, at every panel open, per file. This is the rare case where the honest design is also the cheap one — no "last checked 3 hours ago" hedging, unlike drift in Phase 5 §6.1. |

And one constraint that shapes more of this doc than anything else:

**The header state slot now has six things to say and about 140 px to say them in.** Local edits, changed in Figma, conflicts (Phase 5), plus to-push, to-pull and diverged (Phase 6). §6 is the answer, and it is the piece of this design most worth arguing about.

Constraints carried forward and still load-bearing: 1,316 tokens, 11 sets, 460 px wide; every token has `figma` provenance; apply is the only verb that writes to the canvas; there is no plugin-side undo for anything that touches the file.

**A new one joins them, and it is the same shape:** *commit* and *push* are the only verbs that write to the repo, and nothing else may borrow them. The panel now has two destinations and three write verbs — **Apply** (canvas), **Commit** (repo), **Pull** (into pending changes). Phase 5 already reserved this: *"Phase 6's git write must be Commit / Push, not 'apply to the repo'."*

---

## 2. Scope

### In scope (Phase 6)

Connecting a Figma file to one GitHub repo and branch with a fine-grained PAT (§5); a settings surface for repo, branch, tokens folder and token (§5.2); live per-file sync status in the header and the Changes list (§6); a pre-commit diff and an editable commit message (§7); pull, materialized as pending changes that route through Phase 5's apply flow (§8); a per-file divergence state that blocks rather than merges (§9); and the drift rebaseline that Phase 5 deferred to here (§10).

### Explicitly out of scope

| Not this phase | Where it lives | What that means here |
|---|---|---|
| **Creating a Figma Variable or Style for a pulled token that has no counterpart in this file** | Its own ticket, probably its own ADR (ADR-0006 §11) | A repo authored outside Tokenvault **pulls in read-only**. These tokens are reported, named, and do nothing — §8.4. This is the single most likely thing to read as a bug, so it gets copy rather than silence. |
| Branch creation, PRs, merge, history browsing | Open question §13.4 | The branch picker **reads** (`GET …/branches`). There is no `[ New branch ]` and no `[ Open a PR ]` — see §7.5 for the one link that hands the user to GitHub instead. |
| OAuth, GitLab, Bitbucket | v2 / PRD §4 | The settings panel says "GitHub" in the section header, not "Git provider". Don't design a provider picker for one provider. |
| Automatic or scheduled push | Open question §13.2 | Phase 6 pushes when asked. Status checks are automatic; writes never are. |
| Theme composition, math, authoring or editing references | Phase 7 | Unchanged from Phases 4 and 5. **But pulled data can now contain references the user never authored** — which makes Phase 5 §5.6's alias-apply spec reachable for the first time. §8.3. |
| Merging diverged content | Refused by ADR-0006 §6, not deferred | There is no three-way merge UI to design, and §9 is about making a refusal feel like a decision point rather than a dead end. |
| Committing `$import-report.json` | Never (ADR-0006 §5) | It never appears in the diff, the file list, or the commit message. It is not a hidden file the user can reveal; it is not part of the repo. |

---

## 3. The state model — a third question about the same tree

Phase 5's spine was a 2 × 2 table: *did you edit it* × *did Figma change*. Phase 6 does **not** add a third dimension to that table. It adds a second table, about a different unit.

| | Unit | Question | Where it shows |
|---|---|---|---|
| **Token state** (Phases 4–5) | one token at one target | Does the tree agree with Figma? | `⚑` badges on value lines, the Changes list |
| **File state** (Phase 6) | one `tokens/*.json` file | Does the repo agree with what we'd write? | The header chip's repo segment, the Files section of the Changes list |

**They are deliberately different units, and pretending otherwise is the main trap in this phase.** A commit's unit is a file, because that is the unit git has (ADR-0006 §5). A user's unit is a token. The design does not resolve that tension by picking one — it puts each in the place where it is the right answer: **the tree and the Changes list are token-shaped; the commit surface is file-shaped, with token rows nested inside each file.** §7.2.

### The four file states

Straight from ADR-0006 §4's SHA table, with the copy fixed here:

| local vs. base | remote vs. base | State | Panel copy |
|---|---|---|---|
| same | same | in sync | *(no label — files in sync are not listed)* |
| differs | same | local changes | **To push** |
| same | differs | remote changes | **To pull** |
| differs | differs | diverged | **Diverged** — §9 |

Plus two that aren't in the table because they aren't comparisons:

| State | When | Panel copy |
|---|---|---|
| **Not connected** | no repo configured for this file | The repo segment of the chip is absent entirely — not greyed, not `—`. §6.1. |
| **Can't reach GitHub** | offline, or the request failed | `Can't reach GitHub`. The local tree is unaffected and everything else keeps working (ADR-0006 §10). §11. |

### Wording

**Never say "diverged" without saying what it means in the same breath.** It is the right internal word and ADR-0006's word, and it is the one term in this phase a designer has no reason to already know. Every place it appears, the next line is plain: *"This file changed in the repo and here. Tokenvault won't guess which is right."*

**"Local changes" becomes "uncommitted", and Phase 4's chip becomes literally true.** ADR-0006 §2 demotes the overlay to uncommitted work, which is what Phase 4's *local edits* wording was always reaching for. Phase 6 is where *saved* starts meaning something, and the word for the thing that hasn't been saved is **uncommitted**, in the panel and in this doc.

---

## 4. Screen inventory

```
Header:  Folio design system        Import│Tokens   ⚙   ← gear is new (§5.2)

State slot (§6):
  ┌ not connected ────────────────────────────────────────┐
  │ [ 7 local · 3 changed ]        ← Phase 5, unchanged   │
  └───────────────────────────────────────────────────────┘
  ┌ connected ────────────────────────────────────────────┐
  │ [ 7 local · 3 changed │ ↑ 3 ]  ← one chip, two halves │
  │ [ ● In sync ]                  ← all three agree      │
  │ [ 7 local │ 1 diverged ]       ← amber, blocks sync   │
  └───────────────────────────────────────────────────────┘
        │
        └── tap ──▶ Changes list (Phase 5 §6.3, grown)
                    ┌──────────────────────────────────┐
                    │ ←  Changes                       │
                    │ [Local 7][Changed 3][Conflicts 2]│
                    │ [ Repo 3 ]      ← NEW 4th tab    │  A. §6.2
                    │  … file rows …                   │
                    │ [ Pull ]          [ Push… ]      │
                    └──────────────────────────────────┘
                         │                   │
      ┌──────────────────┘                   └──────────┐
      ▼                                                 ▼
 ┌────────────────────────┐              ┌────────────────────────┐
 │ Pulled 12 changes      │              │ Commit and push      ✕ │  B. Commit
 │ They're pending —      │  toast +     │ 9 changes → 3 files    │     modal
 │ apply to update Figma  │  Local tab   │ ☑ theme/light.json     │     (§7.2)
 └────────────────────────┘              │ Message [          ]   │
                                         │ [Cancel] [Commit to main]│
                                         └────────────────────────┘

 ⚙ ──▶ ┌──────────────────────────┐      ⚠ ──▶ ┌──────────────────────┐
       │ ←  Settings              │            │ ←  Diverged files    │  D. §9.2
       │ GitHub                   │  C. §5.2   │ theme/light.json     │
       │ Repository / Branch /    │            │ [Compare][Take repo] │
       │ Tokens folder / Token    │            │          [Keep mine] │
       └──────────────────────────┘            └──────────────────────┘

 First connect ──▶ ┌──────────────────────────┐
                   │ This repo already has    │  E. §5.3
                   │ tokens. Start from which?│
                   │ ( ) The repo  ( ) Figma  │
                   └──────────────────────────┘
```

Phase 6 adds **one header control** (the gear), **one tab inside an existing screen** (Repo), **two full-panel overlays** (Settings, Diverged files), **two modals** (Commit, First connect) and **one segment on an existing chip**. It adds **no new tab to the panel** and **no new badge colour**.

**Why no third top-level tab.** Phase 4 argued tabs are for places you work, and there are two: Import and Tokens. Sync is not a third place — it is a property of the tokens you are already looking at. Putting a Sync tab beside them would split *what needs me?* across two screens, which is the same objection Phase 5 §6.2 raised against a Drift tab, and it would leave the Tokens tab unable to answer the question on its own.

---

## 5. A. Connecting

### 5.1 The gear, and where sync settings live

A **gear icon in the header**, right of the tabs, opening a full-panel Settings overlay with a back arrow. Not a tab (§4), not a section inside the Tokens tab (it has nothing to do with a token), not a modal (it has several fields and a connection test, and modals are for one decision — Phase 5 §5.2).

The gear carries **one state mark and only one**: an amber `⚑` when the connection is broken (bad token, missing repo, missing branch). Not a count, not a green dot when healthy. A settings icon that is decorated when everything is fine teaches the user to ignore its decoration.

### 5.2 The Settings overlay

```
┌──────────────────────────────────────────────┐
│ ←  Settings                                  │
├──────────────────────────────────────────────┤
│ GitHub                                       │
│                                              │
│  Repository                                  │
│  [ thebluesman/folio-tokens              ]   │
│  Paste a repo URL or type owner/repo.        │
│                                              │
│  Branch                                      │
│  [ main                                  ▾ ] │
│                                              │
│  Tokens folder                               │
│  [ tokens/                               ]   │
│  Where Tokenvault reads and writes token     │
│  JSON. Nothing outside this folder is        │
│  ever touched.                               │
│                                              │
│  Access token                                │
│  [ ••••••••••••••••••••  ab12 ] [ Replace ]  │
│  A fine-grained token for this repo only,    │
│  with Contents: read and write.  [ How ↗ ]   │
│                                              │
├──────────────────────────────────────────────┤
│ ● Connected · main · checked just now         │
│ [ Test connection ]           [ Disconnect ] │
└──────────────────────────────────────────────┘
```

Decisions, and why:

- **The token field is write-only, and looks it.** `••••` plus the last four, an inert field, and a `[ Replace ]` button that clears it and gives you an empty input. There is no reveal, no copy button, no "show token" toggle. This is ADR-0006 §1's rule rendered as UI: the PAT is never placed in the DOM as a value. The last four exist for exactly one job — *is this the token I think it is* — and that is the whole job a masked credential should do.
- **The scope instruction is copy, not a link to figure out.** *"A fine-grained token for this repo only, with Contents: read and write."* One sentence naming the three choices a user has to make on GitHub's token screen, then `[ How ↗ ]` to the docs. A PAT set up too broadly is the difference between a leaked token costing one repo and costing an account, and that is worth eleven words in the panel.
- **Repository accepts a pasted URL.** Nobody has `owner/repo` on their clipboard; they have `https://github.com/owner/repo`. Accept both, normalize to `owner/repo`, show the normalized form. Refusing a paste to enforce a format is the panel making its parsing the user's problem.
- **Branch is a picker, populated on demand**, from `GET …/branches`, with the current value always present even if the list fails to load. It is a `▾` with a text fallback, not a free-text field: a typo'd branch name is a 404 the user then has to debug, and the list is one cheap call.
- **The tokens folder gets a sentence about blast radius**, because "Tokenvault writes to my repo" is a scary sentence and *"nothing outside this folder is ever touched"* is the true and reassuring one (ADR-0006 §8's `base_tree`).
- **`[ Test connection ]` is explicit and always available.** It runs the status check and reports in place — `● Connected · main · checked just now`, or the §11 failure copy right below the field that caused it. Every field here can be wrong in a way that only GitHub can tell you about, so there is a button that asks GitHub.
- **`[ Disconnect ]` is not destructive styling and not red.** It clears the repo settings and `tokenvault:sync:<file-id>`; it touches no tokens, no Figma, and nothing in the repo. It does prompt once — *"Disconnect from thebluesman/folio-tokens? Your tokens and local changes stay exactly as they are; drift goes back to comparing against your last scan."* — because the last clause is a real consequence nobody would predict (§10).
- **Repo, branch and token are the user's; the connection is the file's.** ADR-0006 §3 stores the credential per user and the sync state per Figma file. The panel doesn't explain this, but it shows it: open a second Figma file and Settings already has the repo and token filled in, with the connection not yet established for that file. The status line is the tell — `● Not connected for this file · [ Connect ]`.

### 5.3 First connect — the one-time bootstrap

The moment a file is first pointed at a repo, ADR-0006 §4's state table calls every single file diverged, which is technically true and useless. So first connect gets its own question, asked once, in a modal over Settings:

```
┌────────────────────────────────────────┐
│ Connect to folio-tokens              ✕ │
│ main · 12 token files already in       │
│ tokens/                                │
├────────────────────────────────────────┤
│ Both sides already have tokens.        │
│ Which one should Tokenvault start      │
│ from?                                  │
│                                        │
│  (•) The repo                          │
│      Its 12 files become the baseline. │
│      Anything Figma says differently   │
│      shows up as pending changes you   │
│      can review and apply.             │
│      Nothing is written anywhere yet.  │
│                                        │
│  ( ) This Figma file                   │
│      Your tokens become the baseline   │
│      and overwrite the repo's on your  │
│      next push.                        │
│                                        │
├────────────────────────────────────────┤
│ [ Cancel ]              [ Connect ]    │
└────────────────────────────────────────┘
```

- **The repo is preselected**, because it is the source of truth by ADR-0006 §2 and because it is the non-destructive direction: adopting produces pending changes that still need an apply, so *nothing is written anywhere* until the user confirms again. Publishing Figma over the repo is a real overwrite, and a default that overwrites someone's repo on first run is not a default.
- **The counts are in the header**, so the choice is made against a number rather than a feeling. `12 token files already in tokens/`.
- **When the repo has no tokens folder, there is no question.** The modal doesn't open; connect succeeds with an empty baseline and the chip reads `↑ 12` — everything to push, which is exactly right. Asking "adopt or publish?" when there is nothing to adopt is a dialog with one real answer.
- **When the Figma file has never been scanned**, likewise no question: adopt the repo, and the Tokens tab's existing *"Scan the file first"* state handles the rest.
- **"Review file by file" is deliberately not a third option.** It is what the panel already does, every day, after connecting: the Repo tab lists per-file states and the user works through them. Offering it here would be offering a mode for something that is just the product.

*Marked open — §13.5. The recommendation above is adopt-the-repo-by-default; the alternative worth taking seriously is refusing to guess and opening the Repo tab with all 12 files diverged, which is more honest and much more work on day one.*

---

## 6. B. Sync status — the chip and the Changes list

This is PRD §6.7's sync status indicator, and the hardest 140 px in the panel.

### 6.1 One chip, two halves

Phase 5's chip answered *what state is my work in* relative to Figma. Phase 6 has a second relationship to report and cannot have a second chip beside it without asking the user to parse two vocabularies in one glance — the failure Phase 5 §6.2 spent a section avoiding.

So: **one chip, split by a hairline divider. Left half is Figma. Right half is the repo.**

```
[ 7 local · 3 changed │ ↑ 3 ]
```

| Situation | Chip |
|---|---|
| Not connected | `7 local · 3 changed` — Phase 5 verbatim, **no divider and no right half at all** |
| Connected, everything agrees | `● In sync` — green, single, no divider |
| Files to push | `… │ ↑ 3` |
| Files to pull | `… │ ↓ 2` |
| Both | `… │ ↑ 3 ↓ 2` |
| Any diverged file | `… │ 1 diverged` — amber, and it takes the whole right half |
| Offline / request failed | `… │ ⚠ offline` |
| Left half empty (clean against Figma) | `● In sync │ ↑ 3` — the green dot describes the left half only |

Four decisions carry this:

- **The divider is doing semantic work, not decoration.** It is what makes *in sync with what* answerable without a word. Left of it: this file. Right of it: the repo. Nothing crosses.
- **`↑` and `↓` are file counts, not token counts, and the list says so in words.** They are the one piece of borrowed git vocabulary in the panel, and they are borrowed because every developer already reads them and they cost two characters where "3 files to push" costs fifteen. The moment the user taps through, the Repo tab spells it out: **3 files to push**. A glyph in the chip and a sentence in the list is the trade this slot has to make.
- **`diverged` is a word, never a glyph.** It is the one state that blocks an operation, it is the one term the user won't know, and compressing it into a symbol would be economising on exactly the wrong thing.
- **`● In sync` now means all three agree** — the tree matches Figma, and the repo matches what we'd write. It is a stronger claim than Phase 5's and it is finally a claim worth making, because there is a real source of truth to be in sync with. When only half is clean, the green dot stays attached to the left half and the right half speaks for itself.

**Precedence, when it doesn't all fit** — and it often won't:

1. **Diverged** wins everything. It is the only state that stops an operation the user is about to try.
2. **Conflicts** next, as in Phase 5.
3. Then repo counts, then Figma counts.
4. `● In sync` only when there is genuinely nothing in either half.

### 6.2 The Repo tab in the Changes list

Phase 5 called the Changes list *"the one place the whole state of the world is legible"* and expected Phase 6's sync state to land in the same slot. It does — as a **fourth section tab**, not a new screen.

```
┌──────────────────────────────────────────────┐
│ ←  Changes                                   │
│ [ Local 7 ][ Changed 3 ][ Conflicts 2 ][Repo 3]│
├──────────────────────────────────────────────┤
│ thebluesman/folio-tokens · main              │
│ Checked just now · [ Check again ]           │
├──────────────────────────────────────────────┤
│ To push · 3 files                            │
│  ▸ tokens/theme/light.json        6 tokens   │
│  ▸ tokens/theme/dark.json         1 token    │
│  ▸ tokens/$manifest.json          1 set      │
│                                              │
│ To pull · 2 files                            │
│  ▸ tokens/base/mode-1.json       12 tokens   │
│  ▸ tokens/styles/text.json        2 tokens   │
│                                              │
│ ⚑ Diverged · 1 file                          │
│  ▸ tokens/theme/light.json                   │
│    Changed in the repo and here.             │
│    [ Sort this out ]                         │
├──────────────────────────────────────────────┤
│ [ Pull 2 files ]        [ Push… ]            │
└──────────────────────────────────────────────┘
```

- **Files, not tokens, at the top level** — this is the one screen in the panel where the unit is a file, because it is the screen about the repo (§3). Expanding a file shows its token rows in the same `before → after` shape as everywhere else, so the two units nest rather than compete.
- **The repo and branch are named at the top of the tab, every time.** A user with two Figma files and two repos should never have to remember which one this panel is talking to, and the sentence costs one line.
- **`[ Check again ]` and a freshness line, but no staleness anxiety.** Unlike Phase 5's drift (*"scanned 12 minutes ago"*, hedged because a rescan is expensive), a status check is one request. It runs on panel open, on tab open, and after every push or pull. *"Checked just now"* is usually literally true.
- **A diverged file cannot be expanded into token rows inline.** It gets `[ Sort this out ]`, which opens §9.2. Rendering a diverged file's tokens in the same list as pushable ones would put three different meanings on one arrow.
- **`[ Push… ]` has an ellipsis; `[ Pull 2 files ]` does not.** Push opens the commit modal — there is a message to write and a review to do. Pull is one action with a fully described outcome, and it writes nothing to Figma or the repo (§8), so it needs no confirmation screen. The ellipsis is carrying that distinction honestly.
- **Both buttons disable with a reason, never silently.** No changes → `[ Push… ]` is disabled with `Nothing to push` beneath it. Diverged files present → both are enabled but scoped, and §9.1 explains what they do.

---

## 7. C. Pushing

### 7.1 The verb

**Commit and push are one action in this panel, and the button says both.** Git separates them; Tokenvault has no local repo, no staging area, and nothing a commit could sit in unpushed — the Git Data sequence only becomes visible at the final ref update (ADR-0006 §8). Offering a commit that doesn't push would be modelling a state that does not exist. The button is `[ Commit to main ]` and the toast says pushed.

### 7.2 The commit modal

A **modal card over the dimmed Changes list**, the same container as Phase 5's apply dialog, for the same reason: this answers *am I sure*, and the user does it often.

```
┌──────────────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒ Changes list, dimmed ▒▒▒▒▒▒▒▒▒▒▒▒▒│
│  ┌────────────────────────────────────────┐  │
│  │ Commit and push                      ✕ │  │
│  │ 8 changes in 3 files → main            │  │
│  ├────────────────────────────────────────┤  │
│  │ ☑ tokens/theme/light.json    6 changes▲│  │
│  │    color.border.accent.default         │  │
│  │      ■ #b4342a  →  ■ #c33a2e           │  │
│  │    color.border.accent.strong          │  │
│  │      ■ #c94a3f  →  ↗ {…red-warm.60}    │  │
│  │    spacing.100          16  →  20      │  │
│  │    + 3 more                            │  │
│  │ ☑ tokens/theme/dark.json     1 change ▼│  │
│  │ ☑ tokens/$manifest.json               ▼│  │
│  │    Theme / Dark  ·  289 → 290 tokens   │  │
│  ├────────────────────────────────────────┤  │
│  │ ⚑ 1 file can't be pushed               │  │
│  │  tokens/base/mode-1.json  diverged     │  │
│  │  [ Sort this out ]                     │  │
│  ├────────────────────────────────────────┤  │
│  │ Message                                │  │
│  │ [ Update Theme tokens                ] │  │
│  │ [ 6 values in Theme/Light, 1 in      ] │  │
│  │ [ Theme/Dark, 1 set added.           ] │  │
│  ├────────────────────────────────────────┤  │
│  │ [ Cancel ]      [ Commit to main ]     │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

Decisions:

- **Files at the top level, tokens nested and collapsed by default except the first.** The commit is file-shaped (§3), the review is token-shaped, and a user who wants to check one value should not have to expand three files to find it. The first file opens because a modal that opens fully collapsed makes the user work to see anything at all.
- **`+ 3 more` inside a file, not a scrollbar race.** Each file shows its first three token rows and a count; tapping expands in place. A 200-token commit stays readable, and the list still scrolls inside the card with the footer pinned — Phase 5 §5.2's rule, unchanged.
- **Per-file checkboxes, all checked.** File-level, not token-level: git cannot commit half a file, and a checkbox that implies otherwise is a lie about the unit. Unchecking is the escape hatch for "push the theme change, not the manifest change yet".
- **This is the same row component as the apply dialog**, deliberately — Phase 5 §10 said to build it as `{ target, before, after, state }` and keep it out of Phase-5-specific modules, precisely so this screen could have it. Same swatches, same `↗` reference preview, same left-truncated paths.
- **Diverged files appear, above the button, blocked and unchecked** — never hidden. Same treatment as the apply dialog's blocked rows: the failure is visible before the write, not after.
- **The manifest row explains itself.** `tokens/$manifest.json` means nothing to a designer, so its nested line says what changed in human terms — *"Theme / Dark · 289 → 290 tokens"*, or *"1 set added"*. A file in the diff that the user cannot interpret is a file they will learn to ignore.
- **`$import-report.json` is never in this list**, and there is no toggle to show it (ADR-0006 §5). It is not hidden; it is not part of the repo.

### 7.3 The commit message

Two fields — a one-line summary and a body — both prefilled, both editable, the summary focused on open.

| Field | Generated default |
|---|---|
| Summary | `Update Theme tokens` · `Update Theme and Spacing tokens` · `Add Theme / Dark` — named from the sets touched, not the file count |
| Body | `6 values in Theme/Light, 1 in Theme/Dark, 1 set added.` One sentence, regenerated live as checkboxes change |

- **Prefilled and editable, per ADR-0006 §8** — *"a repo whose history is 200 identical `Update tokens` commits is a history nobody reads."* The generated message is good enough to accept without reading and specific enough to be worth reading later, which is the bar for a default.
- **The summary is required and cannot be emptied.** Clearing it restores the generated text on blur rather than blocking the button. An empty commit message is not a state the user wants; it is a state they arrived at by selecting-all and typing.
- **The body regenerates while it is untouched, and stops the moment the user types in it.** Nothing is more annoying than a field that eats what you wrote because you toggled a checkbox.
- **No `Tokenvault` byline, no emoji, no trailer.** The commit author is already the PAT's owner; the repo does not need the plugin to sign its work.

### 7.4 Feedback

**Success** — toast, with the one link this phase offers:

> **Pushed 8 changes to `main`.** `[ View commit ↗ ]`

The chip's right half drops to nothing; if the left half is also clean it becomes `● In sync`, which is the payoff moment of the phase and should be visibly, not quietly, clean — the same rule Phase 5 applied to apply.

**Rejected because the branch moved** — the honest and most likely failure (ADR-0006 §8's `force: false`):

> **`main` moved while you were writing.** Nothing was pushed. `[ Check again ]`

Then the status re-runs, and either the push is still clean (retry) or files are now diverged (§9). This is the one error where the plugin should offer the next step as a button, because there is exactly one sensible next step.

**Everything else** — §11's table. No partial commit state exists (ADR-0006 §10), so failure copy can always say *nothing was pushed* and mean it.

### 7.5 The one link out

`[ View commit ↗ ]` on the success toast, and a `[ Open on GitHub ↗ ]` in Settings. That is the entire git-client surface area Phase 6 offers, and it is the deliberate answer to "shouldn't there be a history view / a PR button / a branch creator": **the user already has a git client, and it is better than anything a 460 px panel will build.** Tokenvault's job is to get tokens in and out of the repo legibly; browsing history is not that job. *Open — §13.4.*

---

## 8. D. Pulling

### 8.1 What pull does, and the sentence that has to land

**Pull does not change Figma.** It fetches the repo's version of the changed files, works out what that means for this file's tokens, and leaves them as **pending changes** — Phase 4's overlay entries, tagged `from repo` (ADR-0006 §5). Getting them onto the canvas is Phase 5's apply flow, unchanged.

This is architecturally elegant and, as a user expectation, completely counterintuitive: *pull* in every other tool means the thing arrives. So the toast says it in one breath, and the panel state backs it up:

> **Pulled 12 changes from `main`.** They're pending — apply them to update Figma. `[ Review ]`

`[ Review ]` opens the Changes list on the **Local** tab, where the twelve entries are sitting. The chip goes from `↓ 2` to `12 local`, which is the state moving from the repo half of the chip to the Figma half — visibly, in one hop, which is the clearest possible demonstration of what just happened.

Two reasons to hold this line rather than making pull write to Figma: it reuses Phase 5's confirmation, ordering and per-entry failure reporting instead of building a second write path (ADR-0006's saving), and a pull that silently rewrote a designer's file because someone else pushed is exactly the failure this whole project is careful about.

### 8.2 Pulled changes look like local ones, with one difference

In the Local tab and in the apply dialog, a pulled entry carries a small grey `from repo` tag on its row. That is the whole visual difference, and it is grey rather than a badge, because a pulled change **needs nothing from you** beyond the apply you were going to do anyway.

Where it earns its keep is in conflict copy. When a pulled change lands on a token the user has also edited, Phase 4's `edit-conflict` block appears — but the block can now name the other side properly:

```
│ ⚑ Conflict                                    │
│   Yours          ■ #c33a2e                    │
│   From the repo  ■ #b4342a                    │
│   You edited this token; the repo changed it  │
│   too. Pick one.                              │
│   [ Keep mine ]          [ Take the repo's ]  │
```

That is ADR-0006 §5's `origin` field doing UX work: *"so a conflict message can name the repo rather than the user"*. Phase 4's merge table is otherwise untouched — a pulled entry merges, conflicts and retires exactly like an authored one.

### 8.3 References arrive for the first time

Phase 5 built alias-preserving apply and noted that nothing in Phase 5 could reach it: the editor refuses to edit a reference, so no overlay entry could hold one. **A pulled tree can.** Phase 5 §5.6's spec — `↗ {…path}` as the primary value with the resolved colour muted beneath, blocked rows where a pointer can't be carried, `↗ can't be aliased · applying #c33a2e as a literal` never silent — becomes live in Phase 6 with no new design. It was written as a Phase 6 spec that shipped early, and this is the phase that calls it.

### 8.4 Tokens the repo has and this file doesn't

The deferred case from ADR-0006 §11, and the one most likely to be read as a bug. After a pull:

```
├──────────────────────────────────────────────┤
│ 4 tokens are in the repo but not in this file │
│  folio.color.bg.raised          Theme/Light   │
│  folio.color.bg.raised          Theme/Dark    │
│  … 2 more                        [ List ]     │
│                                               │
│  Tokenvault can update Variables and Styles   │
│  but can't create them yet. Add these in      │
│  Figma and scan again, and they'll sync from  │
│  then on.                                     │
└──────────────────────────────────────────────┘
```

- **Listed, named, and given a workaround.** *"Add these in Figma and scan again"* is a real path through the problem and it takes one sentence. Silence here means a designer pulls, applies, and never finds out four tokens were skipped.
- **No action button**, because there is no action. A greyed `[ Create ]` would promise a feature that isn't built.
- **It appears once per pull, in the pull result, and does not become a persistent badge.** It is a property of the repo's content, not a problem with this file, and putting a permanent counter on it would nag about something the user may have deliberately not built.

### 8.5 Auto-pull

**No.** Status is checked automatically; pulling is not. A pull creates pending work — entries the user then has to review and apply — and an app that silently generates work-in-progress on open is an app you learn to distrust. The badge saying `↓ 2` is enough: it is visible, it is accurate, and acting on it takes one tap. *Open — §13.2.*

---

## 9. E. Divergence

The state ADR-0006 refuses to merge, and the moment §1 says this phase will be judged on.

### 9.1 The shape of the refusal

Three rules, and the second is the one that makes this liveable:

1. **Divergence blocks per file, never globally.** Two files diverged out of twelve means ten files still push and pull normally. A push with one diverged file is one commit containing the ten clean ones — which is exactly what git would do, and refusing the whole operation over one file would make a single stale file lock the plugin.
2. **Nothing about it is a full-panel interruption.** No blocking banner over the Tokens tab, no modal on panel open, no *"you must resolve this before continuing"*. The user came here to edit tokens and can keep doing that; the diverged file is a flagged item in the Repo tab and a blocked row in the commit modal, in the amber `.entry` treatment every other blocker in this panel already uses.
3. **Both escape hatches are per-file and both are named plainly.** *Take the repo's* and *Keep mine*. No third "merge" option, because there isn't one, and no greyed one, because a greyed control promises a feature.

### 9.2 The Diverged files screen

Reached from `[ Sort this out ]` in the Repo tab or the commit modal. Its own full-panel overlay, because it is a screen you go to deliberately to make a real decision — the same weight rationale as Phase 5's delete confirmation, and the opposite of a modal you dismiss with a stray backdrop tap.

```
┌──────────────────────────────────────────────┐
│ ←  Diverged files                        1/2 │
├──────────────────────────────────────────────┤
│ tokens/theme/light.json                       │
│                                               │
│ This file changed in the repo and here.       │
│ Tokenvault won't guess which is right, so     │
│ it won't sync this file until you pick.       │
├──────────────────────────────────────────────┤
│ In the repo · 4 tokens differ                 │
│   color.border.accent.default  ■ #b4342a      │
│   color.bg.surface             ■ #f7f4f2      │
│   … 2 more                        [ Compare ] │
│                                               │
│ Here · 6 tokens differ                        │
│   color.border.accent.default  ■ #c33a2e      │
│   spacing.100                  20             │
│   … 4 more                        [ Compare ] │
├──────────────────────────────────────────────┤
│ ⚠ 2 tokens changed on both sides.             │
├──────────────────────────────────────────────┤
│ [ Take the repo's ]          [ Keep mine ]    │
│ Whichever you pick applies to the whole file. │
└──────────────────────────────────────────────┘
```

- **Both sides are summarized before either button.** Counts first, then the first two token rows of each, then `[ Compare ]` for the full side-by-side. A file-wide decision made without seeing what is in the file is a coin flip, and this screen exists to stop it being one.
- **The overlap count is called out separately** — *"2 tokens changed on both sides"* — because that is the number that tells the user whether this is a real collision or two people working in different corners of the same file. Four-and-six-with-zero-overlap is a merge anyone would want; four-and-six-with-two-overlap is a conversation.
- **`[ Compare ]` opens a read-only token-level diff** for that file, using the commit modal's row component with `repo` and `here` columns and unchanged tokens collapsed. Read-only and per-token selection is **not** offered: picking tokens individually is the three-way merge ADR-0006 §6 refuses, and building a UI for it here would be smuggling it in.
- **Neither button is styled destructive.** Both discard something, symmetrically, and neither deletes anything from the file or the repo — *Keep mine* is a normal commit whose parent is the current head, so the repo's version stays in history and is recoverable by ordinary git means. Making one red would imply the other is safe.
- **What each does, stated under the buttons rather than in a tooltip:**

| Button | What happens |
|---|---|
| **Take the repo's** | The repo's version of this file becomes the baseline, and its differences arrive as pending changes — §8's pull, scoped to one file. Your local changes to this file are dropped, and the panel says how many before it does it. |
| **Keep mine** | The file is cleared to push: your version commits over the repo's on the next push, with the current head as its parent. Nothing is lost from the repo's history. |

- **`1/2` in the header, with the next file arriving after a choice.** Two diverged files is a queue, not a list to navigate; resolving one advances. Backing out at any point leaves the rest unresolved, and the Repo tab still shows them.

*The whole of §9 is marked open — §13.1. This is the recommendation, not a settled design.*

---

## 10. Drift, rebaselined — amending `apply-and-drift.md` §6.4

Phase 5 wrote drift copy it knew was temporary and said so in the doc: *"This is Phase 5 language, and Phase 6 takes it back."* This is that.

### 10.1 What changed

In Phase 5, the token tree was re-derived from Figma on every scan, so a drifted-but-unedited token **already showed Figma's value**. There was no second source, so drift was a changelog against the last scan and the labels had to say so: `At your last scan` / `Now in Figma`.

Once a file is connected, ADR-0006 §7 swaps the baseline to the last-pulled repo value. The repo now holds a value that is genuinely independent of Figma, and the two rows are once again two different things.

### 10.2 The two forms of the block

| | **Connected to a repo** | **Not connected** |
|---|---|---|
| Before row | `In the repo` | `At your last scan` |
| After row | `Now in Figma` | `Now in Figma` |
| Explanation | *"The repo and Figma disagree about this token."* | *"Someone edited this in Figma after your last scan. Your tree already shows the new value."* |
| Left button | **`Take the repo's`** — writes the repo's value into Figma, through the apply dialog | `Put Figma back` — writes the pre-change value into Figma, through the apply dialog |
| Right button | **`Take Figma's`** — the token adopts Figma's value **as an uncommitted change that needs pushing** | `Take Figma's` — clears the flag, writes nothing |

```
┌──────────────────────────────────────────────┐
│ ⚑ Changed in Figma                           │
│   In the repo    ■ #f0a19a                   │
│   Now in Figma   ■ #ef9f98                   │
│   The repo and Figma disagree about this      │
│   token.                                      │
│   [ Take the repo's ]    [ Take Figma's ]    │
└──────────────────────────────────────────────┘
```

- **`In the repo`, not `Your token`.** The original Phase 4 framing was `Your token`, and it is still not quite right: the tree renders `build(scan) + overlay`, so "your token" is showing Figma's value on this row. `In the repo` names the thing the row actually holds, which is the whole point of the correction.
- **The button pair is now symmetric, and it matches §8.2's conflict block verbatim.** `Take the repo's` / `Take Figma's` — two sources, two buttons, one vocabulary for picking between them everywhere in the panel. `Put Figma back` survives only in the disconnected case, where there is no repo to name.
- **`Take Figma's` gains a consequence it did not have in Phase 5.** It now creates an uncommitted change. The toast says so: *"Accepted the change from Figma — 1 change to push."* — where Phase 5's was *"Accepted the change from Figma."* full stop. Phase 5's build note *"`Take Figma's` writes nothing"* is true only while disconnected, and needs an `if connected` beside it.
- **The added / removed drift kinds are unchanged.** A target that appeared or vanished between scans still has no baseline to restore and still offers `Take Figma's` alone.

### 10.3 Connecting visibly upgrades drift

ADR-0006 §7 pins that an unconnected file keeps Phase 5's drift exactly, and says the upgrade should be visible. It is, in two places: the disconnect prompt (§5.2) names the consequence — *"drift goes back to comparing against your last scan"* — and the block's own labels change. Nothing announces the upgrade on connect; the labels changing is the announcement, and a toast about baseline semantics is not a sentence anyone wants to read.

---

## 11. Empty and error states

### Empty states

| When | Copy |
|---|---|
| Repo tab, not connected | **This file isn't connected to a repo.** Point it at a GitHub repo to push and pull your tokens. `[ Open settings ]` |
| Repo tab, connected, nothing to do | **Everything's pushed.** `main` matches your tokens. *(green, per Phase 5 §8)* |
| Commit modal with nothing checked | `[ Commit to main ]` disabled, `Nothing selected` beneath it |
| Repo has no tokens folder yet | **Nothing in `tokens/` yet.** Your first push creates it. |
| Pull with nothing incoming | *(no modal)* toast: **`main` has nothing new.** |
| Settings, never configured | Fields empty, status line reads `● Not connected`, `[ Test connection ]` disabled until a repo and token exist |

### Error and degraded states

Every one of these is named, per ADR-0006 §10 — the panel never reports a bare status code.

| State | Treatment | Copy |
|---|---|---|
| **Offline / can't reach GitHub** | Chip right half `⚠ offline`; `.entry` in the Repo tab. Everything local keeps working. | **Can't reach GitHub.** Your tokens and local changes are fine — sync will pick up when you're back online. |
| **401 — bad or expired token** | `.entry` in the Repo tab and an amber `⚑` on the gear | **GitHub rejected the token.** It may have expired or been revoked. `[ Open settings ]` |
| **404 — repo, branch, or access** | `.entry` in Settings, under the repo field | **Can't find `owner/repo` on `main`.** Either it doesn't exist, or your token doesn't have access to it — GitHub's answer is the same either way. |
| **403 with a rate limit** | `.entry`, with the reset time | **GitHub's rate limit is used up.** Try again after 14:32. |
| **Rate limit running low** | Quiet grey line in the Repo tab, below the freshness line | `142 GitHub requests left this hour.` |
| **Token lacks write access** (read worked, push 403) | `.entry` on the commit modal, which stays open with the message intact | **This token can only read the repo.** Push needs a token with Contents: read **and** write. `[ Open settings ]` |
| **Branch moved mid-push** | Modal stays open, nothing written | **`main` moved while you were writing.** Nothing was pushed. `[ Check again ]` — §7.4 |
| **File diverged** | Blocked row in the commit modal; flagged item in the Repo tab | **Changed in the repo and here.** Tokenvault won't guess which is right. `[ Sort this out ]` — §9 |
| **Pulled token has no Figma counterpart** | Listed in the pull result, no action | §8.4's copy |
| **Pulled reference can't be aliased** | Blocked or explicitly-flattened row in the apply dialog | Phase 5 §5.6's copy, unchanged — now reachable for the first time |
| **Repo file isn't valid token JSON** | `.entry` in the Repo tab, that file excluded from pull | **Can't read `tokens/theme/light.json`** — it isn't valid token JSON. Other files pulled normally. |
| **Repo settings exist, this file isn't connected** | Settings status line | `● Not connected for this file` `[ Connect ]` — §5.2 |
| **Push succeeded, status check after it failed** | Success toast still shows; freshness line reads unknown | **Pushed.** Couldn't re-check status. `[ Check again ]` |

**Circular references are still not a Phase 6 state to design.** A cycle arriving in pulled data surfaces as an ordinary blocked row in the apply dialog, exactly as ADR-0005 §11 already handles it. The real circular-reference error state is Phase 7's, where a user can author one.

---

## 12. Visual language — nothing new

Phase 6 introduces **no new colour, no new badge, and no new component**. That is worth stating as a result rather than an absence, because a phase that adds a network, a credential and a third source of truth could easily have argued for all three.

| Element | Reused from |
|---|---|
| Chip's right half | Phase 5's header state slot — third occupant, as predicted |
| `⚑ diverged`, `⚑` on the gear | Phase 4's `.badge.needs` amber. Divergence is *needs you*, the same as a conflict |
| `● In sync` green | Phase 5 §8's green, in its existing home — the chip. Its meaning strengthens; its placement doesn't move |
| `.entry` amber block | Every error in §11 |
| Commit modal container | Phase 5 §5.2's apply dialog — same card, same backdrop, same three ways out |
| Commit / diff / compare rows | Phase 5's `{ target, before, after, state }` row component, built for this |
| Settings, Diverged files | Phase 4's full-panel overlay with a back arrow |

Two additions that are not colours:

1. **`↑` and `↓` glyphs**, in the chip's right half only (§6.1). Never in the tree, never on a token row, never on a file row in the Repo tab — those say **To push** and **To pull** in words. The glyphs exist because the chip has 140 px; nothing else in the panel has that excuse.
2. **The chip's divider.** A hairline, the same weight as the panel's other separators. It is not a border and does not turn the chip into two controls — tapping either half opens the Changes list, on the tab matching the half you tapped.

**Green does not spread.** No green on a pushed file, no green tick on an in-sync file row. Phase 5 §8's rule holds: in a list, in-sync is the absence of a mark. In-sync files are not listed in the Repo tab at all, which is the strongest version of the same idea.

---

## 13. Open questions for Shyam

Five come from ADR-0006, one is inherited from Phase 5 and comes due now. Each carries a recommendation so there's something to push against — but **none of them is decided.**

1. **What divergence actually looks like.** ADR-0006 §6 fixes that the plugin doesn't merge; it doesn't fix what the user sees.
   **Recommended:** §9 as written — per-file blocking (never global, never a full-panel interruption), a dedicated *Diverged files* screen reached from a flagged item, both sides summarized with an overlap count, `[ Compare ]` for a read-only token-level diff, and two symmetric buttons `Take the repo's` / `Keep mine` that apply to the whole file.
   **The alternatives:** a blocking banner across the Tokens tab (rejected — it stops the user doing unrelated work over a file they may not care about today), or per-token selection in the compare view (rejected — that *is* the three-way merge the ADR refuses, arriving through the UI).
   **The thing to react to:** whether "whole file, pick a side" is too blunt. It will be, occasionally. The bet is that it's rare, and that a bad merge is worse than an annoying refusal.

2. **Manual push only, or scheduled/automatic?** And separately, auto-pull on panel open.
   **Recommended:** manual push, manual pull, **automatic status check**. Status is a read, costs one request, and answers a question the user always wants answered. Push and pull both create consequences someone else can see — a commit in a shared repo, or pending work in your panel — and neither should happen without a tap.
   **The thing to react to:** auto-push is a coherent design, not a lazy one — it would make the repo the live state and delete the "uncommitted" concept entirely. It's a different product, and worth saying no to deliberately rather than by default.

3. **New surface, or grow Phase 5's Changes panel?**
   **Recommended:** grow it. A fourth tab, `Repo`, in the existing Changes list (§6.2), with the commit surface as a **modal over it** (§7.2) rather than a screen beside it. The Changes list keeps its role as the one place the whole state of the world is legible; the modal answers *am I sure*, which is what modals in this panel are for.
   **The thing to react to:** the commit modal is doing more than the apply dialog — file grouping, nested token rows, two text fields, per-file checkboxes. If it grows one more control it stops being a confirmation and should become its own screen. §7.2 is close to that line already.

4. **How much git should Tokenvault expose?**
   **Recommended:** push and pull against one selected branch, and nothing else. No branch creation, no PR flow, no history browsing — instead, one `[ View commit ↗ ]` link that hands the user to GitHub, which is better at all three than a 460 px panel will ever be (§7.5).
   **The thing to react to:** branch creation is genuinely small on top of ADR-0006 §8, and "commit to a new branch" is a real safety valve for someone nervous about pushing to `main`. If that's the actual use case, the cheapest version isn't a branch creator — it's the branch picker gaining a `+ New branch from main` row, and no PR flow at all.

5. **Does the first connect adopt the repo or overwrite it?**
   **Recommended:** ask once, in a modal, with **adopt the repo preselected** (§5.3) — it's the source of truth by ADR-0006 §2, and it's the direction that writes nothing until a second confirmation. Skip the question entirely when the repo has no tokens folder, or when the file has never been scanned.
   **The thing to react to:** the alternative is refusing to guess and dropping all twelve files into §9's divergence queue. More honest, and a miserable first five minutes. The recommendation trades a small amount of honesty for a first run that works.

6. **Inherited from Phase 5 §9.9, and now due: does bulk `Take Figma's` need a confirmation?** Phase 5 closed this because the question dissolved — the tree already held Figma's values, so accepting forty drift flags wrote nothing. Connected to a repo, that premise is gone: accepting in bulk now produces forty uncommitted changes headed for a shared repo. Phase 5 flagged this exact reopening.
   **Recommended:** still no confirmation dialog — but the outcome is now stated in the toast (*"Accepted 40 changes from Figma — 40 changes to push."*) and visible in the chip, and nothing reaches the repo without the commit modal, which is a full review surface. The consequence is confirmed at the point it becomes real, which is push, not accept.
   **The thing to react to:** whether two taps between "accept forty" and "commit forty" is enough separation.

---

## 14. Build notes for `@frontend-engineer`

- **Read ADR-0006 first.** This doc specifies how states *read*; the ADR owns the transport, the SHA comparison, the commit sequence, storage keys and the failure taxonomy. Where they disagree, the ADR wins.
- **The PAT never enters the DOM.** §5.2's field renders `••••` plus four characters from stored metadata, not from the token. No `value` attribute, no reveal toggle, no autofill-able input, and the field is inert until `[ Replace ]` swaps it for an empty one. This is ADR-0006 §1 as a UI requirement, not a nicety.
- **No error message passes through unscrubbed.** Every string in §11's table is written by us from a status code. Never render GitHub's response body, and never a URL that could carry a token.
- **The chip is one component with two slots.** Don't build two chips that happen to sit together — the divider and the shared tap target are what make *in sync with what* answerable. Right slot renders empty and takes no space when not connected.
- **File state and token state are separate models.** §3. The Repo tab and the commit modal are file-keyed; everything else is `{ path, setId }`-keyed. Don't unify them behind one "change" type — they have different identities, different counts, and different resolutions.
- **Reuse Phase 5's row component for the commit diff, the compare view, and the apply dialog.** Phase 5 §10 built it as `{ target, before, after, state }` for exactly this. If Phase 6 introduces a second diff row, something went wrong.
- **A status check runs on panel open, on Repo tab open, and after every push and pull** — and never on a timer (ADR-0006's no-polling position, and Phase 5 §9.5's).
- **Pull writes overlay entries with `origin: "pulled"` and nothing else.** No Figma writes, no second write path, no bypassing the apply dialog. The `from repo` tag is grey text on the row, not a badge.
- **`$import-report.json` is excluded at the push boundary**, not filtered in the UI. It should be impossible for it to reach the diff list.
- **Divergence blocks per file.** A push with one diverged file commits the other files. Never refuse the whole operation.
- **`Take Figma's` writes nothing while disconnected and creates an overlay entry while connected.** Phase 5's build note said "writes nothing" unconditionally; §10.2 amends it. The toast copy differs between the two, and both strings need to exist.
- **The drift block's labels are keyed to connection state, not to a feature flag.** Connected → `In the repo` / `Now in Figma` with `Take the repo's`. Not connected → Phase 5's `At your last scan` / `Now in Figma` with `Put Figma back`. Both are live code paths; a file can be disconnected at any time.
- **Preserve `$extensions."com.tokenvault"` byte-for-byte through pull and apply.** ADR-0002 §7's byte-identical guarantee is what makes the whole blob-SHA design work — a round-trip that reorders one key makes every file look changed.
- **Section 2's out-of-scope table is the scope boundary.** If a task starts needing Variable creation, a merge algorithm, a PR, or a second git provider, stop and raise it.
