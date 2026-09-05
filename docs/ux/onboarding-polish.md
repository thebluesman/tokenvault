# UX: Onboarding and first-run polish (Phase 10)

**Status: Settled 2026-09-05.** Issue #22's two blocking questions were both answered by Shyam before
this was written (§2.3), so nothing here waits on a decision. §10 carries three questions that are
product-feel calls and none of them gates the build.
**Owner:** `@ux-designer`
**Covers:** `docs/ux/user-journeys.md` §13c gaps 11–14. PRD §6.4 (PAT auth), §6.7 (plugin panel),
build plan §9 Phase 10. Issue #22.
**Builds on:** `local-editor.md` (P4) §1 and §8, `git-sync.md` (P6) §5, §6.1 and §11,
`error-states.md` (P9) §1. Same panel, same 460 × 640 px, same vocabulary. Read those first — this
doc extends them and does not restate them.
**Depends on:** PR #31 (issue #23) being merged. §5.7 explains which sentence goes false without it.
**Amends:** `user-journeys.md` §4.2, §13c and §14 (applied here — §9.1); `git-sync.md` §5.1, §5.2
and §11, and `local-editor.md` §1 and §8 (stated in §9.2, to be applied when the build lands, per
the Phase 7 precedent in `references-math-themes.md` §12).

---

## 1. What we're designing against

Two of the four gaps were written from the docs rather than from the running panel, and both are
partly wrong. Establishing that first, because it changes what there is to design.

| Fact | Source | What it forces |
|---|---|---|
| **A bulk affordance already exists on the Import tab.** `Only unconfirmed` (on by default), `Set all shown to…`, and `Confirm all guesses as-is` all ship today. | `src/ui/importView.ts` `renderSubtypes` | Gap 12 is not "build a bulk affordance." It is "the bulk affordance is undocumented, unguarded, un-undoable, and can't act on a subset." §5. |
| **The chip has never read `132 local`, and structurally cannot.** The subtype dropdown writes `userSubtypes`, not the overlay (ADR-0004 §3); the chip counts overlay entries. | `src/ui/detail.ts` `renderSubtype`, `src/ui/main.ts` `renderStateSlot` | Gap 13's stated symptom doesn't exist. The real first-run misreadings are in three other places. §6. |
| **What a fresh unconnected scan actually reads is `Not compared`.** `driftKnown()` is false with no apply baseline and no repo. | `src/code.ts` `driftKnown`, ADR-0005 §8 | Correct, honest, and completely opaque to someone who has never used the plugin. §6.2. |
| **A confirmed subtype now travels via push/pull.** `adoptRepoSubtypes` runs before the rebuild on connect-adopt and after every pull. | PR #31 / issue #23 | The 132-row queue is a **first-machine** problem, not a per-machine one. That changes how much the grouping in §5.3 has to carry. |
| **A read-only token is currently caught at first push.** `git-sync.md` §11's *"This token can only read the repo"* fires on a 403 from the write. | `git-sync.md` §11 | The single worst moment in Journey A, and the permission is knowable at paste time. §4.3. |

And three constraints carried forward, all still load-bearing: 460 × 640 px; **no third badge
colour**; and the panel's own vocabulary — *Changed in Figma* not "drift", *Uncommitted* not
"unsaved", **Apply** writes the canvas, **Commit/Push** writes the repo, **Pull** writes neither.

One new constraint, and it is the one that most changes the register of the copy below:

**A stranger may install this.** Community publishing (Phase 13) is still on the table (§2.3), so
none of these four surfaces gets to assume the reader built the thing. That is not a licence to write
more words everywhere; it is a specific ban on three internal ones (§7.3) and a bias toward
explaining the system once, well, in the place it is true.

---

## 2. Scope

### In scope

The four gaps, and only the four: PAT setup friction inside the PAT flow (§4), the subtype
confirmation queue at real size (§5), first-run counts and chip framing (§6), and a first-run
explanation of the three-place model (§7).

### Explicitly out of scope

| Not this | Where it lives |
|---|---|
| **OAuth, and any change to the auth model** | PRD §6.4 fixes v1 on PAT; §2.3 records that this is not being revisited. An OAuth relay stays a v2 stretch goal (PRD §11). |
| **Dark mode** | Issue #21, shipped. Every surface here inherits `dark-mode.md`'s tokens and adds no colour. |
| **Token creation, rename, theme composition** | `user-journeys.md` §13a, Phase 11. A first-timer who wants to *make* a token is a real gap and is not this one. |
| **Making the subtype guess better** | ADR-0002 Am.1 §A owns the heuristic. This doc makes the queue survivable; it does not shorten it by guessing harder. |
| **A tour, a video, a sample file, a getting-started checklist** | §7.4 argues each one down. |
| **Anything that changes a number** | §6.4. Every count in the panel is correct today. The fix is framing. |

### 2.3 The two questions that blocked this, and their answers

Issue #22 reserved both for Shyam. Both were answered 2026-09-05, before a line of this was written.

1. **PRD §11's PAT/OAuth revisit — is v1 in daily use, and does OAuth move?**
   **No. OAuth is not being revisited; PRD §6.4/§11's v1 decision stands.** Gap 11 is therefore
   scoped as *reducing friction inside the PAT flow* — better copy, inline guidance, a
   paste-and-validate step. §4 does exactly that and nothing else. This also closes
   `user-journeys.md` §14 question 4.
2. **Private install or Figma Community?**
   **Community (Phase 13) stays on the table.** So §7 assumes a stranger, and leans explanatory
   rather than terse. This does not settle Phase 13 — it settles what onboarding has to survive.

---

## 3. The one thread through all four

Gaps 11–14 look like four unrelated papercuts. They are four instances of the same failure, and
saying it once is cheaper than saying it four times:

> **The panel is excellent at reporting state and has never once explained the state it reports.**

`132 unconfirmed` is a true number with no sentence attached. `Not compared` is a true state with no
sentence attached. `[ How ↗ ]` is a true pointer with no sentence attached. Every empty state in
`local-editor.md` §8 and `git-sync.md` §11 is a beautifully-worded local truth that assumes the
reader already holds the system.

That assumption is correct for exactly one person and it is the person who wrote it.

So the shape of all four fixes is the same: **keep every number, attach the sentence.** No count
changes, no state is suppressed, no first-run mode makes the panel say something different from what
it will say on day 400. Where a number reads as a problem and isn't one, the fix is a heading that
says which band it belongs to (§6.1), not a smaller number.

---

## 4. Gap 11 — PAT setup

Journey A step 7 is *"leaves the plugin"*. The user is now on GitHub's fine-grained token screen,
making three choices, one of which silently produces a token that works for everything they will try
next and fails at the one thing they are doing all this for. `[ How ↗ ]` is the entire assist, and it
is a link to a doc, from a plugin, about a website.

Four changes. The third is the one that matters.

### 4.1 The token field moves above the branch picker

Today's field order is Repository → Branch → Tokens folder → Access token (`git-sync.md` §5.2). The
branch control is *"a picker, populated on demand, from `GET …/branches`"* — a call that needs a
credential the user has not been asked for yet. So a first-timer's second interaction with Settings
is a dropdown that cannot load, above the field that would have made it load.

New order: **Repository → Access token → Branch → Tokens folder.** Repo first because the token
instructions name it (§4.2); token second because everything below it is a network call. Nothing else
about the overlay changes.

### 4.2 `[ How ↗ ]` becomes an inline, in-panel checklist

A disclosure under the token field, **open by default while the field is empty**, collapsed once a
valid token is stored, reopenable forever.

```
┌──────────────────────────────────────────────┐
│  Access token                                │
│  [ Paste a fine-grained token            ]   │
│                                              │
│  ▾ How to make one                           │
│                                              │
│    You do this on github.com — Tokenvault    │
│    can't create a token for you.             │
│                                              │
│    1  Repository access → Only select        │
│       repositories → thebluesman/folio-tokens│
│                                              │
│    2  Repository permissions → Contents →    │
│       Read and write                         │
│                                              │
│    3  Expiration → your call. Tokenvault     │
│       warns you a week before it lapses.     │
│                                              │
│    [ Open GitHub ↗ ]     [ Copy these 3 ]    │
└──────────────────────────────────────────────┘
```

Decisions, and why:

- **The three steps are the three choices on GitHub's form, in GitHub's own words.** Not a paraphrase.
  A user reading this is going to be looking at that form in a browser window a moment later, and
  copy that renames the controls makes them hunt.
- **The repo name is interpolated into step 1.** It is already in the field above. Step 1's whole
  risk is picking *All repositories* out of convenience, and naming the one repo is the cheapest
  argument against that.
- **`[ Copy these 3 ]` exists because the panel is about to be behind a browser window.** This is the
  one moment in the product where the instructions and the work happen in different applications, and
  a checklist you cannot see is not a checklist. It copies as plain text, same mechanism as the
  existing Copy-as-JSON.
- **`[ Open GitHub ↗ ]` goes to the new-token form, not to a doc.** The docs link was solving the
  wrong half: the user does not need reading, they need to be on the right page with the right three
  answers in hand.
- **The scope sentence from `git-sync.md` §5.2 stays** — *"A fine-grained token for this repo only,
  with Contents: read and write"* — as the collapsed summary line. Eleven words that survive the
  disclosure being shut is exactly what §5.2 argued for, and the disclosure is the *how*, not a
  replacement for the *what*.

### 4.3 Paste-and-validate — the read-only token gets caught where it was made

**The change with the most value in this doc.** Today a token scoped to Contents: **Read** passes
`[ Test connection ]`, populates the branch picker, connects, adopts a baseline, and fails hours
later on the first push, after the user has scanned, confirmed 132 subtypes, staged files and
written a commit message. `git-sync.md` §11's copy for that moment is good and arrives at the worst
possible time.

So: **the moment a token lands in the field, the panel checks it.** No button press. The check runs
on paste and on blur, and reports in place, in three lines, from GitHub's answer rather than from
what the user remembers choosing.

Healthy:

```
   Checking this token…

   ● This token can read and write thebluesman/folio-tokens.
     Expires 3 Dec 2026.
```

The failure that this whole section exists for:

```
   ⚑ This token can read thebluesman/folio-tokens, but not write to it.
     Step 2 above is the one to change — Contents needs
     Read and write, not Read.
     [ Open GitHub ↗ ]
```

- **It names the step number.** The checklist is three lines above it and still on screen. Pointing at
  step 2 turns a diagnosis into an instruction.
- **The other §11 failures keep their copy and their placement verbatim.** A 404 still reads
  *"Can't find `owner/repo` on `main`"* under the repo field; a 401 still reads *"GitHub rejected the
  token."* Only the read-only case moves, because only the read-only case was being reported at the
  wrong time. This is a scheduling change, not a rewrite of §11.
- **`[ Test connection ]` survives unchanged.** Paste-time validation covers the paste. Repo, branch
  and folder can all be edited afterwards, and there still has to be a button that asks GitHub about
  the current combination. What it stops being is the thing a first-timer must know to press.
- **How the write permission is determined is `@tech-lead` / `@frontend-engineer`'s call.** The repo
  response carries a permissions block, and fine-grained tokens carry their own metadata; which
  signal is authoritative is an implementation question. The design requirement is only this: *the
  read-only token must be named at paste time and must never be the reason a staged commit fails.*
  If it turns out not to be knowable without a write, say so and this section becomes a warning
  rather than a verdict — but do not leave it at first push.

### 4.4 Expiry becomes a state the panel holds

A fine-grained token expires. When it does, the user gets `git-sync.md` §11's 401 — *"GitHub rejected
the token. It may have expired or been revoked"* — which is an accurate description of a mystery. It
is also the only failure in the product that arrives with no user action at all, which makes it the
one most worth pre-empting.

- **The expiry date is shown in the token field's result line** (§4.3), where it costs nothing and is
  read once.
- **Inside 7 days, the gear takes its amber `⚑`** and the Repo tab gets an `.entry`:
  **Your GitHub token expires in 5 days.** Replace it before it lapses, or pushes will start failing.
  `[ Open settings ]`
- **This widens `git-sync.md` §5.1's rule, deliberately.** That section says the gear carries one
  state mark and only one — amber `⚑` when the connection is *broken* — and argues that a settings
  icon decorated when everything is fine teaches the user to ignore it. That argument holds. The rule
  becomes: **the `⚑` means the connection needs you**, of which *broken* and *about to break* are two
  members. An expiring token is not "fine"; it is a scheduled outage. It is still not a count and
  still never a green dot.

### 4.5 The status line says what is missing, not that the button is off

Today, Settings-never-configured reads `● Not connected` with `[ Test connection ]` disabled until a
repo and token exist (`git-sync.md` §11). A disabled button explains nothing about why.

| State | Status line |
|---|---|
| No repo, no token | `● Needs a repo and a token` |
| Repo, no token | `● Needs a token` |
| Token, no repo | `● Needs a repo` |
| Both present, unchecked | `● Not checked yet` · `[ Test connection ]` enabled |
| Configured, not connected for this file | `● Not connected for this file` `[ Connect ]` — §5.2, unchanged |

Same slot, same dot, one more sentence's worth of information for zero pixels.

---

## 5. Gap 12 — the subtype queue at real size

### 5.1 Correcting the record first

`user-journeys.md` §13c gap 12 says *"132 subtype confirmations with no bulk affordance."* There are
three, shipped, in `src/ui/importView.ts`:

- **`Only unconfirmed`**, a checkbox, **on by default** — so the list is already the queue and not the
  whole file.
- **`Set all shown to…`**, a dropdown that writes the chosen subtype to every currently-shown
  candidate it is valid for.
- **`Confirm all guesses as-is`**, a button that accepts every guess in one message.

`local-editor.md` §1 sized the problem (*"132 unconfirmed subtypes… import-quality state has to be
visible inside the browser"*) and never specified the toolbar, so the toolbar got built without a
spec and the survey read the spec instead of the panel. **This section is now that spec.** It keeps
all three controls and fixes four things.

### 5.2 `Set all shown to…` is an unguarded mass write

It is the single most consequential control on the Import tab and it has none of the protections the
panel gives to far smaller actions.

- **It does not say how many rows it will touch.** "Shown" is the product of a checkbox the user set
  two interactions ago. The label becomes **`Set all 132 shown to…`**, recomputed with the list.
- **It has no confirm.** Anything over **20 rows** gets `git-sync.md` §10.4's existing inline confirm
  strip — the one component Phase 6 added, for exactly this shape of problem (bulk `Take Figma's`).
  Not a modal; modals are for one decision and this is a footer:

  ```
  Set 132 variables to spacing?          [ Cancel ]  [ Set 132 ]
  ```

- **It has no undo.** Both bulk actions get the existing 10-second toast undo, same surface as delete
  (`local-editor.md` §7): **132 set to `spacing`. [ Undo ]**. `set-subtypes` already carries a map, so
  the inverse is the previous map.
- **Per-row changes keep no undo**, as today. The asymmetry is right: a dropdown you just changed is
  its own undo, and 132 of them are not.

### 5.3 The affordance the gap actually named: grouping

*"These 90 are all `spacing`, accept them all"* is not something `Set all shown to…` can express. It
acts on the whole filtered list, and the only filter is confirmed / unconfirmed. So the list gains
**grouping by the guess**, with a per-group action:

```
┌──────────────────────────────────────────────┐
│ Number & string types — 132 to confirm       │
│                                              │
│ These are guesses, not errors. Tokenvault    │
│ read Figma's scopes to guess each one.       │
│ Accepting them all is fine — you can change  │
│ any token's type later from its detail panel.│
│                                              │
│ [✓] Only unconfirmed   [ Confirm all 132 ]   │
│                                              │
│ ▾ spacing · 90          [ Confirm 90 ] [ ▾ ] │
│     grid-gutter    default  [ spacing    ▾ ] │
│     inset-sm       default  [ spacing    ▾ ] │
│     …                                        │
│ ▸ fontSize · 24         [ Confirm 24 ] [ ▾ ] │
│ ▸ borderRadius · 12     [ Confirm 12 ] [ ▾ ] │
│ ▸ no guess · 6                         [ ▾ ] │
└──────────────────────────────────────────────┘
```

- **Group by the guessed subtype, because that is the axis the decision is made on.** The user scans
  ninety names and asks one question — *are these all spacing?* — and answers it once. That is the
  sentence the gap wrote down, rendered.
- **Collection was the other candidate and is worse.** A collection mixes subtypes, so a per-collection
  bulk action is never the answer to a single question. Collection stays where it is: in the row's
  hover title, alongside scopes and the sample value.
- **Groups are collapsed by default, except the largest.** A 132-row wall is the thing being fixed;
  opening one group shows what a group looks like without rebuilding the wall.
- **Largest group first.** It is both the biggest win and the likeliest to be a uniform, correct guess.
- **`no guess` is its own group and gets no `[ Confirm ]`** — there is nothing to confirm. It gets
  the `[ ▾ ]` set-all only, and it is last because it is the group that genuinely needs reading.
- **`[ ▾ ]` is `Set all N in this group to…`**, and it obeys §5.2's threshold and undo like any other
  bulk write.

### 5.4 `Confirm all guesses as-is` becomes the primary

The guesses come from Figma's own scopes (ADR-0002 Am.1 §A). On a well-scoped file most of them are
right, and the honest fast path for a first-timer is to take them and correct individuals later from
the token detail panel, where the same dropdown already lives (`detail.ts` `renderSubtype`).

So it gets `.primary`, it gets the count in its label — **`Confirm all 132 guesses`** — and the
paragraph above the section (drawn in §5.3) says the two things that make accepting them reasonable:
*they are guesses, not errors*, and *you can change any of them later, here's where*.

That paragraph is also half of gap 13's fix, which is why it is worth its four lines.

### 5.5 The queue has to visibly empty, and let you back in

When the last candidate is confirmed, the section collapses to the existing line — *Every number
variable has a confirmed or auto-detected type.* — with `Only unconfirmed` still checked and no
obvious way back except an unlabelled checkbox. A user who bulk-confirmed faster than they meant to
is stuck looking at a sentence.

It gains a button: **`[ Show all 132 ]`**, which unchecks the filter. And the empty line gains a
second sentence for a stranger: *Every number and string variable has a type. You can change any of
them from a token's detail panel.*

### 5.6 Visual language

No new colour, no new badge. The group header is a disclosure row — the same caret row
`local-editor.md` §9 added for the tree — with a `.badge`-weight count. The `.badge.needs` amber on
`subtypeSource` stays exactly as it is: an unconfirmed subtype is still *needs you*, and grouping it
does not downgrade it.

### 5.7 The dependency on PR #31

One sentence in this section is only true once issue #23's fix is merged: **the second machine's
queue is short.** Before PR #31, a second device pulling the same tree rebuilt every confirmed token
as `subtypeSource: "default"` and re-asked all 132. The grouping above is a first-machine tool by
design, and it is proportionate *because* the queue is answered once per repo rather than once per
device. If #31 is not merged when this is built, §5.3 is still correct but under-scoped, and gap 16's
durability problem is back in the room.

---

## 6. Gap 13 — the first-run counts

### 6.1 What is actually wrong: the summary grid

`user-journeys.md` says the first chip reads `132 local`. It does not, and cannot — §1's second row.
The number the user actually meets is on the Import tab, in a nine-box grid whose last three boxes are:

```
   13 Flagged        3 Partial       132 Unconfirmed
```

Three numbers, one row, same weight, same colour. Two of them are import defects — *we couldn't
represent this*, *we represented part of this* — and the third is a job. Rendered identically, all
three read as *132 things went wrong*, and the largest number is the one that didn't.

Fix: **band the grid, and rename the count.**

```
   Read from this file
    4 Collections   9 Modes   612 Variables   704 Styles
    1316 Tokens     704 from styles

   Needs a look
    13 Flagged      3 Partial       132 to confirm
```

- **Two headings, not two colours.** The `needs a look` band is not amber. Making it amber would say
  *132 problems* louder than the current layout says it by accident.
- **`Unconfirmed` → `to confirm`.** "Unconfirmed" names a defect state of a token. "To confirm" names
  a job of the user's, which is what it is, and it matches the section header below it.
- **The band headings are for a stranger** as much as for the count. *Read from this file* answers
  "what did this thing just do", which nothing on the screen currently does.

### 6.2 `Not compared` keeps its words and gains a sentence

The first unconnected scan puts `Not compared` in the state slot: correct, deliberate (ADR-0005 §8 —
*"we haven't checked" and "nothing to report" are different answers*), and completely opaque to
someone meeting it cold.

The chip keeps those two words — the slot is ~100 px, and they are the right two. The sentence goes
where the chip already leads on tap: the Changes list's `!driftKnown` branch, which today is terse.
It becomes, for a stranger:

> **Nothing to compare against yet.** Tokenvault compares this file against the last time you applied
> tokens to it, or against your repo. You haven't done either yet, so there's nothing it can honestly
> call a change.

That is the pattern from §3 in miniature: keep the state, attach the sentence, put the sentence one
tap away rather than in the 100 px.

### 6.3 The first push reads `↑ 12`, and that is right

After `git-sync.md` §5.3's connect modal, `↑ 12` is exactly what the user chose. One addition, once:
on a **first push into an empty `tokens/`**, the Repo tab's file list heads itself

> **12 files · none of these exist in `main` yet. This first push creates them.**

not *12 changes*. `git-sync.md` §11 already has *"Nothing in `tokens/` yet. Your first push creates
it"* for the not-yet-staged case; this is the same sentence surviving one screen further, into the
place the count appears.

### 6.4 What is deliberately not done

**No number changes.** No first-run mode on the chip, no suppression, no zeroing of a true count, no
"we'll show you this later." Every figure in the panel is correct today and every one of them stays.

A chip that softens a true number once to be friendly is a chip nobody believes on the day the number
matters — and in a panel whose entire job is state legibility across three places, that is the only
thing it cannot afford to spend.

---

## 7. Gap 14 — the three-place explainer

Every empty state in the panel is excellent locally and none of them explains the system. A
first-timer can read *"No tokens yet. Scan the file on the Import tab"* and still not know that the
plugin holds a copy, that editing changes nothing in Figma, or that there is a third place at all.

### 7.1 One component, three placements

**Not a tour, not a modal, not a dismissible carousel.** Three reasons, in order of weight: a tour is
a thing people skip; a first-run modal is the single most-complained-about pattern in a Community
plugin listing, and §2.3 says a stranger may be reading; and the panel's local empty states are
already good — the missing thing is the *system*, which is best explained standing inside the part of
it you are in.

So: a compact static strip, ~11 px, no interaction, that appears **inside an existing empty state,
above its existing copy**, highlighting the place that screen owns and greying the other two. Same
drawing as `user-journeys.md` §2, because that drawing already works.

```
   Figma file  ──scan──▶  Tokenvault  ──push──▶   GitHub repo
       ▲                    │    ▲                    │
       └──────apply─────────┘    └──────pull──────────┘
```

| Screen | State | Highlighted | The one line under it |
|---|---|---|---|
| **Import** | never scanned | Figma file | **Start here.** Tokenvault reads your Figma Variables and Styles into a set of token files it keeps for you. Nothing in Figma changes. |
| **Tokens** | `No tokens yet` | Tokenvault | **Your tokens live here, not in Figma.** Edits stay in the plugin until you **Apply** them to the file or **Push** them to a repo. |
| **Repo** | not connected | GitHub repo | **A repo makes your tokens outlive this file.** **Push** sends the token JSON to GitHub; **Pull** brings back what someone else changed. |

- **One sentence per screen, each naming the verb that screen owns.** The user meets the model one
  third at a time, in the place that third is true. Three sentences total is the whole explanation
  budget, and it buys the entire model.
- **It disappears by being outgrown, not by being dismissed.** Each strip is inside an empty state, so
  it is gone the moment that screen has content. Nothing to skip, nothing to remember having skipped,
  no dismissal flag in `clientStorage`, and it comes back — correctly — for a user who opens a fresh
  Figma file six months later (Journey H).
- **The existing empty-state copy is untouched and stays beneath it.** `local-editor.md` §8 and
  `git-sync.md` §11 are right about the local situation. The strip explains the system; the sentence
  under it explains the screen; the button under that does the thing.

### 7.2 The permanent page: `How Tokenvault works`

A link in the **footer of the Settings overlay**, under `[ Disconnect ]` — the one place in the panel
a person goes when they don't know something. A footer row rather than a body row, so it is reachable
when the fields above are full.

One scrolling screen:

- The full strip from §7.1, nothing highlighted.
- **The three places**, one short block each: what it holds, what moves things into it, and what
  clears it. The last part matters most and has never been said in the panel: the plugin's working
  copy and your token are **on this device only**, and a repo is the only thing that makes either
  survive a new machine (ADR-0004 §1). A stranger has to be told that before they trust it with a
  week of work.
- **The four verbs** in a four-row table: **Scan** reads Figma · **Apply** writes Figma · **Push**
  writes the repo · **Pull** writes neither.
- **The two things Tokenvault never does**: it never writes outside your tokens folder, and it never
  changes your Figma file without an explicit Apply. Both are true (ADR-0006 §8, ADR-0005), both are
  the two fears a stranger installs this with, and neither is stated anywhere a user can find.

It exists as much for Journey H — the person returning after a month — as for the first-timer, which
is why it is permanent rather than part of the first-run sequence.

### 7.3 Copy register: three banned words

Assume a stranger. Concretely, on these four surfaces and the page above, three internal words are
banned outright: **overlay**, **baseline**, **DTCG**. ("Drift" is already banned panel-wide by
`apply-and-drift.md` §3 — this doc just doesn't get to be the exception.) None of them has leaked
into user-facing copy yet and none gets to start here.

What stays: **token set**, **theme**, **push**, **pull**, **commit**. Someone installing a token
plugin knows the first two, and the last three are the ones this doc argued in §7.2 are worth teaching
in a four-row table rather than avoiding.

### 7.4 What is not built, and why

| Not built | Why |
|---|---|
| A first-run tour or modal | §7.1. It gets skipped, and it is the pattern a Community listing gets marked down for. |
| A getting-started checklist with tick boxes | It would be a fifth surface reporting state, in a panel whose hardest problem is that it already reports three. |
| A video or an animated walkthrough | 460 px, and it ages the moment a screen changes. |
| A sample/demo token file | It puts tokens the user didn't make into a file they care about. The wrong first impression to risk. |

---

## 8. Visual language

**No new colour, no new badge** — the budget `git-sync.md` §12 and `error-states.md` §1 both kept.

**Two new components across the whole doc:**

1. **The three-place strip** (§7.1) — static, three placements, one drawing.
2. **The grouped candidate list** (§5.3) — a disclosure row the tree already has, with a count and two
   buttons on it.

Everything else is reuse, and the reuse is the argument that these four gaps were framing problems
rather than design problems:

- `.entry` for every PAT failure and the expiry warning (§4.3, §4.4).
- `git-sync.md` §10.4's inline confirm strip for the bulk write (§5.2) — its second use, and the use
  it was shaped for.
- The existing 10-second toast for bulk undo (§5.2).
- The existing `.count` boxes for the re-banded grid (§6.1) — two headings, same boxes.
- The existing empty states for all three strip placements (§7.1).

One **rule** changes rather than a component: the gear's `⚑` widens from *broken* to *needs you*
(§4.4).

---

## 9. Amendments

### 9.1 `user-journeys.md` — applied 2026-09-05, in this commit

That doc is a survey and two of its rows are wrong. Corrected in place rather than carried forward:

- **§4 step 5 and §4.2 bullet 3** — the chip does not read `132 local` on first run. It reads
  `Not compared`. Subtype confirmations write `userSubtypes`, never the overlay (ADR-0004 §3).
- **§13c gap 12** — three bulk affordances already ship; the gap is that they are undocumented,
  unguarded and can't act on a subset. §5 of this doc.
- **§13c gap 13** — restated against the three places the misreading actually lives (§6).
- **§13d gap 16 / §14 question 1** — closed by PR #31. The tags travel.
- **§14 question 4** — closed. OAuth is not being revisited (§2.3).

### 9.2 To apply when the build lands

Per the Phase 7 precedent (`references-math-themes.md` §12), these are stated here and applied to the
target docs by whoever ships the change, each with a dated note:

| Doc | Section | Change |
|---|---|---|
| `git-sync.md` | §5.1 | The gear's `⚑` means *the connection needs you*; an expiring token is a member. §4.4. |
| `git-sync.md` | §5.2 | Field order (token above branch); `[ How ↗ ]` becomes the disclosure; paste-time validation; the status line names what's missing. §4.1–4.5. |
| `git-sync.md` | §11 | The read-only-token row moves its first catch to paste time; two new rows for expiring and expired tokens. §4.3, §4.4. |
| `git-sync.md` | §11 | Repo-tab-not-connected empty state gains the three-place strip. §7.1. |
| `local-editor.md` | §1 | The 132-row queue gets a designed shape — pointer to §5. |
| `local-editor.md` | §8 | `No tokens yet` gains the three-place strip. §7.1. |

---

## 10. Questions for Shyam — none of them gates the build

1. **Is 20 the right threshold for the bulk confirm strip** (§5.2)? Below it, a mass write happens
   with no confirm and only the toast undo; above it, a footer strip. Twenty is chosen because it is
   roughly "more rows than fit on screen" — past that the user cannot see what they are about to
   change. Ten would be safer and noisier; fifty would leave a 45-row write unguarded.
   **Recommendation: 20, as written.**
2. **Is 7 days the right expiry warning window** (§4.4)? Long enough to act on, short enough not to be
   ambient. The counter-argument is that a solo user who opens the plugin twice a month can miss a
   7-day window entirely, and 30 would be safer. The counter-counter-argument is that a 30-day amber
   `⚑` is a `⚑` that is lit 8% of every token's life. **Recommendation: 7, as written.**
3. **Does `How Tokenvault works` (§7.2) double as the Figma Community listing description** if Phase
   13 goes public? It is written to the same audience and says the same five things a listing has to
   say. Writing it once and rendering it twice is cheaper and cannot drift. This is not a UX call —
   it touches Phase 13's scope — and it changes nothing about §7.2 either way.
   **Recommendation: write it as the panel page, and revisit at Phase 13.**

---

## 11. Build notes for `@frontend-engineer`

- **Nothing in this doc calls Figma.** Not one surface here reads or writes the canvas.
- **No count changes.** §6 is entirely headings, labels and one sentence per state. If a task starts
  wanting to suppress, defer or soften a number, stop — that is §6.4's boundary and it is hard.
- **The bulk undo is the inverse map, not a snapshot.** `set-subtypes` already carries
  `Record<variableId, selection | null>`; capture the previous values for exactly the ids in the
  outgoing map. Do not snapshot `userSubtypes` wholesale.
- **Grouping is a view-model concern.** Group the existing `SubtypeCandidate[]` by `candidate.subtype`
  (with `undefined` as the `no guess` group) at render time. Do not add a grouping field to the
  payload — the guess is already on every candidate.
- **The three-place strip is one function with an enum**, rendered into three existing empty states.
  If the build produces three drawings, the design was misread.
- **§4.3's permission check is the one open implementation question in this doc**, and it is genuinely
  yours: if the write permission cannot be determined without attempting a write, the copy becomes a
  warning rather than a verdict and this section gets amended. What must not happen is the read-only
  token continuing to be discovered at first push.
- **§5 assumes PR #31 is merged.** If it is not, build §5 anyway and raise §5.7.
