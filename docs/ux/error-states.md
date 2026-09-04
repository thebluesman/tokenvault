# UX: Error states (Phase 9)

**Status**: Implemented — built and validated in the Phase 9 polish pass, 2026-09-04.
**Scope**: issue #19 §2. Three failure classes that had no designed treatment anywhere, plus the
audit of every other async operation against the error table its own phase doc already owns.

This doc is cross-phase by construction, and it deliberately does **not** absorb the four existing
error tables. `local-editor.md` §8, `apply-and-drift.md` §7, `git-sync.md` §11 and
`references-math-themes.md` §10 stay authoritative for their own operations; a fifth table repeating
them would rot. What lives here is what none of them could own: the failure of the *scan* they all
sit downstream of, the failure of the *panel itself*, and the failure of the *store* the edits live
in.

---

## 1. The convention the three new states inherit

Nothing here invents a treatment. Phases 4–7 already settled a two-level vocabulary and Phase 9's job
was to notice that the three gaps are ordinary members of it:

| Level | Treatment | Used when |
|---|---|---|
| **Notice** | `.entry` block — 1px border, 3px amber left rule, a `.kind` label and a sentence, sometimes a button | The operation failed; the panel is fine. Every row in `apply-and-drift.md` §7 and `git-sync.md` §11 is one of these. |
| **Toast** | 1.8s line at the foot of the panel | The operation *succeeded* and the result isn't visible on screen. Never a failure the user has to act on — a toast that carries the only copy of an error is a lost error. |

Phase 9 adds exactly one new container, and only because neither level can hold it: the **crash
screen** (§3), which is a full-panel takeover for the case where the panel can no longer be trusted
to render a notice inside itself. One new component for a whole phase is the same budget `git-sync.md`
§12 kept, and for the same reason.

**No new colour, no new badge.** The crash screen uses `--warn` and the existing `.entry`
vocabulary at full-panel size.

---

## 2. Scan / Figma API failure

The scan is the plugin's first action and — until Phase 9 — its least defended one. `handleScan`
awaits two Figma reads; anything that rejected there was caught by the message pump's catch-all,
turned into `import-error`, and rendered by wiping the Import tab down to a bare box with Figma's raw
message in it. Three things were wrong with that, and all three are now fixed.

### 2.1 The failure never destroys what the panel already had

The old `showImportError` called `contentEl.textContent = ""` first. A rescan that failed therefore
took the previous report — counts, subtype rows, generated files — off the screen with it, which is
precisely backwards: **a failed rescan changes nothing about the tree the panel is holding.** The
cached tree is still valid, the overlay is still durable, the Tokens tab still works.

So the notice is now *prepended* to the existing Import view rather than replacing it, and the Tokens
tab is never disabled by a scan failure. The header keeps the file name and the state chip. The only
thing that changes is that a notice appears and the button goes back to `Scan file` / `Rescan`.

### 2.2 The copy says what failed, what survived, and what to do

```
┌──────────────────────────────────────────────┐
│ couldn't read this file                      │
│ Tokenvault couldn't finish reading this       │
│ file's Variables and Styles. Nothing was      │
│ changed — in Figma, or in your local edits.   │
│                                               │
│ Figma said: Cannot read properties of null    │
│                                               │
│ [ Try again ]  [ Copy details ]               │
└──────────────────────────────────────────────┘
```

Three rules the copy follows:

- **Name the blast radius before the cause.** *"Nothing was changed"* is the sentence the user
  actually needs; the underlying message is for whoever debugs it. A scan is read-only, so this
  sentence is always true and can be stated flatly rather than hedged.
- **Figma's own words, attributed.** Prefixed `Figma said:`, in the monospace `.kind` face, never
  rewritten into a friendlier sentence that loses the only diagnostic there is. Same call
  `apply-and-drift.md` §7 already made for apply failures (*"the underlying reason"*), and the same
  call `firstFailure` in `main.ts` implements for the apply toast.
- **A way out, not just a diagnosis.** `[ Try again ]` re-sends `scan`. Transient Figma failures are
  real and a retry is one tap; making the user find the header button again is a small insult.
  `[ Copy details ]` puts the message plus the plugin's own context on the clipboard.

### 2.3 A scan that never comes back

Figma imposes no timeout on a plugin's own `await`, so a scan on a very large file does not *fail* —
it just doesn't return, and the panel sits on `Scanning…` indefinitely with no way to tell a slow
file from a wedged one. That state is not made into an error, because the plugin genuinely does not
know that it is one; it is made **legible**:

> Still reading — large files can take a while. `[ Cancel ]` is deliberately absent: the read can't
> be interrupted, and a button that lies about that is worse than the wait.

The line appears after 20 seconds of a scan that hasn't returned, sits under the Scan button, and
disappears when the scan lands or fails. It is grey, not amber: waiting is not a warning.

**Out of scope, and named so it isn't re-litigated:** there is no scan cancellation, no partial
scan, no chunked read, and no "file too large, import a subset" path. All four are real features
rather than error handling, and §6 of issue #19 fences them out.

---

## 3. Unhandled exception — the crash screen

Before Phase 9 an exception thrown outside a handled path — in a render function, in the message
pump, in a `JSON.parse` over a malformed payload — left the panel in whatever state it had reached.
Usually that meant a half-rendered tree that no longer responded, which is indistinguishable from a
hung plugin. The plugin *sandbox* was better off (its queue already caught, so one bad message never
broke the next), but it reported every such failure as `import-error`, which yanked the user to the
Import tab and told them the import failed even when the operation that actually failed was a pull.

Phase 9 separates the two and gives the second one a screen.

### 3.1 What it looks like

A full-panel takeover, in front of every other surface:

```
┌──────────────────────────────────────────────┐
│  Something went wrong.                        │
│                                               │
│  Tokenvault hit an error it didn't expect and  │
│  stopped where it was. Your local edits are    │
│  saved — they're in this file's plugin storage │
│  and reloading won't touch them.               │
│                                               │
│  While applying an edit                        │
│  Cannot read properties of undefined           │
│  (reading 'entries')                           │
│                                               │
│  [ Reload the panel ]   [ Copy details ]       │
└──────────────────────────────────────────────┘
```

- **The second paragraph is the whole point of the screen.** The user's first question after a crash
  in an editor is *did I just lose my work?*, and for Tokenvault the answer is a genuine no: edits are
  written to `clientStorage` on every change (ADR-0004 §1), not held in the UI. The screen says so in
  the same breath as the failure, because an unanswered version of that question sends people
  screenshotting their token values.
- **Message, never a stack.** The `error.message` line is shown; the stack goes onto the clipboard
  behind `[ Copy details ]` and nowhere else. A stack dump in an 11px panel teaches nothing and makes
  a recoverable state look fatal — and it does **not** go to the console, because ADR-0006 §1 forbids
  the PAT reaching a log and `gitInvariant.test.ts` asserts that no module in the product calls
  `console.*`. A crash handler that logs whatever was in flight is exactly how a credential ends up
  in one. `[ Copy details ]` puts the same information one deliberate tap away, taken by the person
  who owns the token.
- **A context line where there is one.** `While applying an edit` — derived from which message the
  plugin was handling, not guessed. Absent rather than invented when the failure came from the iframe
  with no operation in flight.

### 3.2 Recovery, and why it isn't `location.reload()`

`[ Reload the panel ]` **re-runs the UI's startup handshake** — it clears the crash screen, resets
the view state, and re-sends `ui-ready`, which makes the plugin re-emit the connection, the cached
import and the overlay. It is a reload of the *UI's model*, not of the document.

A literal `location.reload()` was rejected: the plugin iframe's document is injected by Figma rather
than served from a URL, so reloading it is unreliable across Figma versions and would in any case
throw away nothing that the handshake doesn't already re-derive. The handshake path is exercised
every time the panel opens, which makes it the recovery route most likely to still work in the state
a crash leaves behind.

Nothing about recovery touches the overlay, the Figma document or the repo. If the same crash
reproduces immediately, the screen comes straight back — which is the honest outcome, and the user
still has `[ Copy details ]` and the Figma-level "close the plugin" escape.

### 3.3 What routes here, and what deliberately doesn't

| Source | Routes to |
|---|---|
| `window.onerror` / `unhandledrejection` in the iframe | Crash screen |
| A throw inside the `window.onmessage` pump | Crash screen |
| A throw inside the plugin sandbox handling any message **other than** `scan` | Crash screen, with the failing operation named |
| A throw inside the plugin sandbox handling `scan` | §2's scan notice — a named, expected, retryable failure of one operation |
| Anything an operation's own error table already covers (a 404, a refused write, a quota rejection) | That table's notice. **Never here.** |

The last row is the load-bearing one. Everything Phases 4–7 designed a failure state for is *handled*
by definition, and routing a handled failure through a crash screen would train the user to treat the
crash screen as noise — which is exactly how a last-resort surface stops working.

---

## 4. Corrupt or unreadable overlay

`local-editor.md` §8 covers the overlay's *write* failure (quota) and ADR-0004 §6 pins the policy —
surfaced, never swallowed. Neither covers the **read**: a blob under `tokenvault:edits:<file-id>`
that isn't the shape the parser expects. Before Phase 9, `parseOverlay` answered that with
`emptyOverlay()` and no signal at all — the panel opened looking like a file with no local edits, and
the next edit overwrote the unreadable blob with a fresh one-entry overlay. Silent data loss, and
then the evidence destroyed.

### 4.1 The decision: recover, quarantine, and say so

Issue #19 poses it as a binary — fall back to no overlay, or block. Neither, exactly:

1. **Recover every entry that is individually readable.** The overlay is a list. One malformed entry
   is not a reason to discard the other forty, and the parser already skipped bad entries one at a
   time — it just never counted them.
2. **Quarantine the raw blob** to `tokenvault:edits-unreadable:<file-id>` before anything can
   overwrite it. Copying two hundred bytes is cheap; a store that destroys the only copy of the
   user's work while reporting a problem with it is not defensible at any price.
3. **Say what was lost, in a notice that doesn't block.** The panel stays usable. Blocking was
   rejected for the same reason `local-editor.md` §8 doesn't block on a quota failure: the tree, the
   scan, the repo and every other feature are unaffected, and a modal that says *"your local changes
   are unreadable"* over a fully working panel makes the user close the plugin — the one action that
   helps least.

ADR-0004 is not amended by this. §6's rule is *"never silently"* and §1's rule is *"never evicted,
never silently dropped"*; recovering what parses, keeping what doesn't, and reporting both is those
two rules applied to a case the ADR didn't enumerate.

### 4.2 The two forms

**Partially readable** — some entries survived:

> **Some local edits couldn't be read.** 38 of 41 were recovered; 3 were unreadable and have been set
> aside. The recovered edits are live and everything else works normally.
> `[ Copy the unreadable data ]`

**Wholly unreadable** — the blob isn't an overlay at all:

> **Your saved local edits couldn't be read.** The stored data for this file is corrupt, so
> Tokenvault has started from a clean slate. Nothing in Figma or in the repo has changed, and the
> unreadable data has been set aside rather than deleted.
> `[ Copy the unreadable data ]`

Both are `.entry` notices at the top of the Tokens tab, above the freshness line, and both persist
for the session — no auto-dismiss. `[ Copy the unreadable data ]` puts the quarantined JSON on the
clipboard, which is the same rescue route `local-editor.md` §5.4 already leans on for the quota case
(*"copy the tree as JSON"*), pointed at the thing that actually failed.

**Word choice.** *"Set aside"*, not *"deleted"* and not *"saved"*: the blob is still in
`clientStorage` under another key, which is neither of those two things and shouldn't be described as
either.

### 4.3 What counts as unreadable

The parser's answer, unchanged in substance from Phase 4 — a wrong `version`, a non-array `entries`,
a non-object blob at the top level, an entry with no recognised `op`, or an entry whose target keys to
nothing. What is new is that each of those now *increments a counter* instead of falling through a
`continue`, and the counters are what the two notices above report.

---

## 5. The audit — where doc and implementation disagreed

Issue #19 §2's second half is a verification pass over every other async operation. Two disagreements
turned up. Both are recorded in the phase docs that own them, dated 2026-09-04, and are summarised
here so the pass has one readable result.

### 5.1 Delete-in-Figma failure — implementation fixed

`apply-and-drift.md` §7: *"Delete in Figma failed → `.entry` block on the confirmation, **which stays
open**."* The implementation closed the confirmation on the confirming tap and reported the failure
in a toast, which is the treatment for a *success* whose result isn't on screen — for a failed
destructive action it is the wrong level entirely, and it also threw away the blast-radius screen the
user would want to look at again.

**Fixed in the implementation, not the doc.** The panel now stays open in a submitting state, and on
failure renders the §7 notice inside itself with Figma's message. On success it closes as before.

### 5.2 Apply failure — doc amended

`apply-and-drift.md` §7 asks for two things after a failed apply: an `.entry` block when it failed
entirely, and *"the dialog reopens with the failed rows still checked"* when it failed partway.

The `.entry` block is now implemented — it was a toast, at the wrong level, for the same reason as
§5.1. The **reopening dialog is not**, and the doc has been amended rather than the code, because
ADR-0005 §6 makes the reopen incoherent: every apply is followed by a rescan, and that rescan is what
retires overlay entries and rebuilds the plan. A dialog reopened with the pre-rescan rows would be
showing a plan built against a tree that no longer exists — the exact stale-state failure
`openApplyDialog`'s guards exist to prevent. What lands instead is the notice, naming what failed and
why, with the failed edits still in the overlay and still visible in the tree, where the user
re-applies them through the ordinary dialog.

### 5.3 A blocked cycle row couldn't show its loop — implementation fixed

`references-math-themes.md` §7.3c gives the cycle block three callers: the value field while
authoring, the detail overlay for a cycle that arrived by scan or pull, and the apply dialog's
blocked row, *"with `[ Show the loop ]` opening the block rather than repeating it inside a list
row"*. The first two shipped in Phase 7; the third did not — the row carried the message and nothing
else, which leaves the user hunting a 1,316-token tree for a loop the plugin had already found.

**Fixed in the implementation.** A blocked row whose reason is `alias-cycle` or `expression-cycle`
now carries `[ Show the loop ]`, and it opens the same `cycleBlock` component the other two callers
use. §7.2's "one component, three callers" is now literally true.

### 5.4 Verified with no change needed

- **Scan / import** against `local-editor.md` §8 — every listed state present (the quota notice,
  `edit-conflict`, `orphaned-edit`, dangling references, partial tokens, the empty states). §8's
  *"Editing a reference / disabled field"* row is superseded by Phase 7 and is amended in place.
- **Push, pull, connect / branch fetch** against `git-sync.md` §11 — all thirteen rows reachable,
  each carrying §11's copy verbatim, and the named-not-numbered rule of ADR-0006 §10 holds: the panel
  reports no bare status codes.
- **References, expressions, themes** against `references-math-themes.md` §10 — every row present
  except one, fixed above (§5.3), including the two the round-1 review of Phase 7 caught.
- **The sync status chip** against `git-sync.md` §6.1 and PRD §6.7 — two halves, five-rung
  precedence, all three PRD states reachable. `main.ts`'s `renderStateSlot` / `repoHalf` match the
  doc as written.
- **The settings panel** against `git-sync.md` §5.1–5.2 — gear, repo, branch, tokens folder, PAT with
  last-four masking, test connection, disconnect. Covers PRD §6.7's repo URL, branch and auth token.

### 5.5 Not built, and why

The **freshness affordance** issue #19 offers as a nice-to-have is not built: the Tokens tab already
carries `scanned 12 minutes ago · [ Rescan ]` and the Repo tab already carries its own freshness line,
so the staleness PRD §6.7 worries about is already stated in both places the chip's two halves point
at. A third statement on the chip itself would be the same fact in a 100px slot.

`apply-and-drift.md` §7's **"File is read-only (viewer, branch permissions, Dev Mode)"** row has no
implementation and gets none. `manifest.json` declares `editorType: ["figma"]`, so Dev Mode never
loads the plugin, and Figma exposes no capability check for the viewer/branch-permission cases — a
write attempt is the only way to find out, and that path now lands in §5.2's apply-failure notice with
Figma's own refusal in it. Recorded in `apply-and-drift.md` §7 rather than left as a silent gap.
