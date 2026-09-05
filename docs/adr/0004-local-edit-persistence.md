# ADR-0004 — Local edit persistence and re-import merge

**Status**: Accepted
**Date**: 2026-09-01
**Accepted**: 2026-09-02 — Phase 4 built and merged against this ADR unamended (issue #7, PR #8), and Phase 5 (ADR-0005) then built on §1's two stores, §2's entry shape and §4's merge table without changing them.
**Revision**: 2 — amended 2026-09-05, see [Amendment 1](#amendment-1--2026-09-05--confirmed-subtypes-travel-through-the-repo)
**Owner**: @tech-lead

## Context

Shyam resolved `docs/ux/local-editor.md` §10.1 on 2026-09-01: Phase 4 edits **persist** across plugin sessions rather than living in memory until the panel closes.

That answer creates the question the UX doc flagged as the one genuinely destructive moment in Phase 4 (§5.4, §8): the user has persisted edits, then re-runs the Phase 2/3 scan. The scan re-reads Figma and rebuilds the whole tree. Does it clobber the edits, merge with them, or refuse?

Three facts constrain the answer.

- **`clientStorage` is 5MB per plugin, per user, per device** — not per file, and not synced. It is shared with the Phase 6 PAT and anything else Tokenvault ever stores. The Folio fixture's token tree is ~700KB serialised, so a naive per-file snapshot store runs out at about six files.
- **The mechanism already exists.** `src/code.ts` persists `userSubtypes` to `clientStorage` under a per-file key (`resolveStorageKey()`), and `buildMergedImport` re-applies them on every rebuild. That is already an id-keyed overlay re-applied over a fresh scan. Phase 4 does not need a new pattern; it needs the existing one generalised.
- **Everything in the tree is re-derivable except the edits.** Creation is deferred (UX §2), so every Phase 4 token arrives from import with `figma` provenance. The Figma side of any disagreement can always be recovered by rescanning. The user's edit cannot be recovered by anything.

## Decision

### 1. Two stores with different durability, not one snapshot

| Store | Key | Contents | Durability |
|---|---|---|---|
| **Edit overlay** | `tokenvault:edits:<file-id>` | The user's edits, as intent (§2) | Durable. Never evicted, never silently dropped. |
| **Import cache** | `tokenvault:last-import:<file-id>` | The serialised result of the last scan | Evictable cache. Most recent file only. |

Both use the existing `resolveStorageKey()` file-id scheme — `figma.fileKey`, falling back to a minted id on `figma.root` plugin data. Figma variable ids are only unique within a file, so an unnamespaced key would let one file's edits retype another's variables. That reasoning is already written down in `src/code.ts`; this ADR reuses it rather than restating it.

The split is the whole decision. A full-tree snapshot is simpler and wrong: it stores *result* with no record of which bytes the user authored, so a rescan has no basis on which to merge and can only clobber or refuse. The overlay stores *intent*, which is both two to three orders of magnitude smaller and the only form a merge can act on.

The cache is a cache. If it is missing — evicted, quota-cleared, another file opened — the Tokens tab shows its existing "scan the file first" empty state and the overlay reapplies to the fresh scan. Nothing is lost by evicting it, which is what makes the 5MB ceiling survivable.

### 2. The overlay is keyed by Figma provenance id, not by token path

Each entry keys on the same identity the importer uses for re-import matching (ADR-0002 §7, ADR-0003 §2):

- Variables: `variableId` **+** `modeId`. Both, because one variable carries a value per mode — `Theme/Light` and `Theme/Dark` share a `variableId` and are different tokens.
- Styles: `styleId`.

Not the dotted path. If a designer renames a variable in Figma between scans, the path moves and the id does not. Path-keyed edits would silently orphan on rename and, worse, could land on whatever token inherited the old path. Id-keying makes an edit follow its token, which is the same guarantee ADR-0002 §7 already gives the import itself.

Each entry records:

```jsonc
{
  "target": { "variableId": "VariableID:1:4", "modeId": "1:0" },
  "path": "folio.color.border.accent.default",   // display only; refreshed on merge
  "set": "Theme/Light",
  "op": "set-value" | "set-description" | "delete",
  "value": "#c33a2e",       // absent for delete
  "base": "#c33a2eff",      // the imported value this edit was made against
  "at": "2026-09-01T…"
}
```

`base` is the load-bearing field. Without it there is no way to tell "Figma changed under me" from "Figma never changed", and every rescan degrades into an unanswerable prompt.

`path` is denormalised for rendering an overlay entry when no scan has run, and is refreshed from provenance on every merge. It is never the matching key.

**Deleting a group** records one tombstone per descendant token at the moment of deletion. A group is not a Figma entity and has no id; a group-level tombstone would silently swallow tokens added to that group later.

### 3. Subtype edits do not go in the overlay

They go where they already go: `userSubtypes`, keyed by `variableId`, fed into `BuildOptions`, producing `subtypeSource: "user"`. That mechanism already round-trips, is already persisted, and is already the thing ADR-0002 §3 makes the committed files authoritative for at Phase 6.

Routing subtype changes through the new overlay would give one concern two storage paths that could disagree. The Phase 4 editor's subtype dropdown writes the existing store; only `$value`, `$description`, and deletion are overlay operations.

> **Amended 2026-09-05.** The claim *"that mechanism already round-trips"* was true of a re-import and false of a push/pull to a second machine until issue #23 wired the read side. See [Amendment 1](#amendment-1--2026-09-05--confirmed-subtypes-travel-through-the-repo).

### 4. Rescan is a three-way merge, and stops being destructive

The overlay applies **after** `buildMergedImport`, to the built tree — not inside `build.ts` or `merge.ts`. Those stay pure and keep ADR-0002 §7's byte-identical guarantee at the build boundary; the overlay is a declared, inspectable transform layered on top of a build that is still exactly reproducible from Figma plus `userSubtypes`.

For each overlay entry, against the freshly built tree:

| Fresh scan says | Outcome |
|---|---|
| Target id absent (variable/style deleted in Figma) | Entry retired. Reported as `orphaned-edit`. |
| Value equals the entry's `base` | Figma has not moved. Apply the edit silently. **The common case.** |
| Value equals the entry's `value` | Figma caught up to the edit. Retire the entry silently — it is now a no-op. |
| Value differs from both `base` and `value` | **Genuine conflict.** Apply the edit, report `edit-conflict`. |

> **Addendum, 2026-09-03 (ADR-0007 §6).** Expression-valued entries need one extra comparison. After an apply, an entry holding `"{a} * 2"` sits against a Figma value of `8` — never string-equal, so the "Figma caught up" row cannot fire and the entry falls through to *genuine conflict*, reporting a spurious `edit-conflict` after every apply. For an entry whose `value` is a math expression (ADR-0007 §1), the third row's comparison is made against `evaluate(entry.value)`, and the outcome is **keep the entry and report nothing** rather than retire it: an expression is authored data Figma cannot store, so retiring it would silently downgrade the token to the flat number it produced. Expression entries are therefore sticky and re-apply on every rebuild. Everything else in this table is unchanged. See `docs/adr/0007-themes-aliasing-and-math.md` §6.

A `delete` tombstone whose target is still in Figma is not a conflict — re-deriving the token is precisely what the tombstone exists to suppress. A tombstone whose target is gone from Figma retires silently; it got what it wanted.

**On a genuine conflict the local edit wins, and every one is reported.** Not because local is more correct, but because it is the only side that cannot be recovered: discarding an edit is undoable by rescanning, and clobbering one is undoable by nothing. The non-destructive default keeps the irreplaceable side.

There is deliberately **no global "keep mine / take theirs"** prompt. At 1,316 tokens a file-wide choice is a coin flip made under pressure. Resolution is per token: the conflict report entry carries both values, and taking Figma's value is one action that drops that one overlay entry.

Consequence for `@ux-designer`: **UX §5.4's blocking "Rescan will discard 7 unsaved edits" dialog is deleted.** Rescan is no longer destructive and should not ask permission. It becomes a post-scan summary in the existing report surface — *"7 edits reapplied · 2 conflicts · 1 orphaned"*. Copy is UX's call; the state model is this ADR's.

### 5. Conflicts ride the existing report, not a new surface

Two additions to `ReportEntryKind`, which the browser's `⚑ flagged` chip and row badges already render (UX §4.5, §8):

- **`edit-conflict`** — a local edit and Figma both moved from the same base. Carries `path`, `set`, the local value, and Figma's value.
- **`orphaned-edit`** — the edited Variable or Style no longer exists in the file.

Both are additive, so `ImportReport.version` stays `1`, consistent with ADR-0003 §6. `ImportCounts` gains optional `editsApplied` and `editConflicts`.

This buys the whole conflict story with no new UI concept: the user already learned that flagged rows mean "import did something you should look at".

### 6. Quota is handled explicitly, never silently

- **Write policy**: the overlay is written debounced per edit (small, frequent); the import cache is written once per successful scan (large, rare). Never write 700KB on a keystroke.
- **Eviction**: the import cache is kept for the most recent file only. On opening a different file, the previous file's cache is deleted; its overlay is not.
- **Failure**: `clientStorage.setAsync` rejects when the 5MB quota is exceeded. That rejection is caught and surfaced — *"Couldn't save your edits: plugin storage is full"* — never swallowed. An edit that silently failed to persist is worse than one that refused to.
- **Order**: on a quota failure, the import cache is dropped first and the write retried once. The cache is re-derivable; the overlay is not.

Realistically the overlay is a few KB. The ceiling exists so that the failure mode is a message rather than a mystery.

## Consequences

- `@frontend-engineer` can build Phase 4 persistence against this: two keys, the entry shape, the merge table, and the two report kinds are pinned.
- Rescan becomes safe, which removes a blocking dialog and makes re-import a routine action rather than a considered one. This is the main user-visible win and the reason the overlay's extra complexity is worth it.
- The overlay is a **diff against Figma**, which is the same shape Phase 6 needs to produce a commit and Phase 5 needs to write values back. Phase 4 is therefore building the data structure those phases want, not a throwaway.
- `clientStorage` is per-device and unsynced. Edits made on a laptop are invisible on a desktop until Phase 6 commits them to git. Acceptable and worth saying out loud in the UI: persisted is not saved. The header chip should read as *local edits*, not *unsaved changes* — the word "saved" belongs to Phase 6.
- Clearing the browser cache destroys the overlay, per Figma's own docs. Until Phase 6, "Copy tree as JSON" remains the only durable exit, and the panel should keep offering it.
- Two stores instead of one means more code than a snapshot: a merge pass, two report kinds, and eviction. That is the cost of a rescan that does not destroy work.
- No infra implication. Still `clientStorage` and files in a git repo; PRD §8's zero-recurring-cost constraint is untouched.

## Alternatives considered

- **Persist the full edited tree; rescan replaces it after a warning.** Rejected. It is what UX §5.4 designed against, and it makes the most routine action in the plugin the most dangerous one. It also cannot merge even in principle: with no record of the pre-edit value, there is no basis to distinguish an edit from an import.
- **Persist the full edited tree and never rescan while dirty.** Rejected. Blocking re-import until the user manually discards their work inverts the priority — it protects the edits by disabling the feature they annotate.
- **Overlay only, no import cache.** Rejected as a lone option; folded in as the degraded path instead. It forces a full Figma scan on every plugin open, which is slow on a 1,316-token file and makes "my edits persisted" feel untrue when the panel opens empty.
- **Key the overlay by dotted token path.** Rejected. Renaming a variable in Figma is normal, and path-keying either orphans the edit or reapplies it to an unrelated token that inherited the path. ADR-0002 §7 already chose ids over paths for exactly this.
- **Key Variables edits by `variableId` alone.** Rejected. One variable holds a value per mode, so `Theme/Light` and `Theme/Dark` would share an overlay entry and an edit to one would leak into the other.
- **Figma wins on conflict.** Rejected. It clobbers the only non-re-derivable side of the disagreement, and quietly, which is the exact failure the UX doc named.
- **Prompt per conflict during the scan.** Rejected. A modal per token across 1,316 tokens is not a workflow. Apply, report, resolve at leisure.
- **A single global "keep mine / take theirs" at merge time.** Rejected. It forces one answer onto unrelated tokens; the correct answer routinely differs per token.
- **Store edits in document `setPluginData` instead of `clientStorage`.** Genuinely tempting — it is per-file by construction and travels with the file across devices and collaborators. Rejected for v1 because it writes to the Figma document, making local edits a shared mutation of a file other people are working in, and PRD §4 rules out team semantics for v1. Worth revisiting if cross-device editing becomes a real complaint before Phase 6 lands.
- **Fold the overlay into `build.ts` / `merge.ts`.** Rejected. It would make the builders' output depend on user state, breaking ADR-0002 §7's guarantee that a build is reproducible from the Figma file plus `userSubtypes`.

## Open questions (not decided here)

- **Whether the overlay survives Phase 6.** Once git sync lands, the committed `tokens/` tree becomes the authority and the overlay arguably becomes a working copy of uncommitted changes — the same demotion `src/code.ts` already anticipates for `userSubtypes`. Likely a small amendment at Phase 6, not a rewrite; the entry shape is already commit-shaped.
- **Renaming a token path** (UX §10.5) is still undecided, and it interacts here: a rename is an edit whose target is the path itself, not a value, so it would need an overlay op this ADR does not define. If rename ships in Phase 4, it needs an amendment.
- **Hand-authored tokens**, when creation returns as its own ticket, have no Figma id and so cannot key the way §2 requires. They would need an `add` op keyed by path carrying a full token payload. Flagged for whenever that ticket lands; not designed for now.
- **Conflict presentation** — how an `edit-conflict` row shows both values, and whether taking Figma's value is inline or in the overlay. `@ux-designer`'s call.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §3 subtypes and extensions, §7 re-import matching and determinism
- ADR-0003 (`docs/adr/0003-styles-token-schema.md`) — §2 style provenance and matching key, §6 report additions
- `docs/ux/local-editor.md` — §5.4 (commit/revert, the rescan warning this ADR removes), §8 error states, §10.1 (the question Shyam resolved), §10.5 (rename, still open)
- PRD §6.1, §6.4, §8, §9 Phase 4; GitHub issue #7
- Phase 2/3 implementation: `src/code.ts` (`resolveStorageKey`, `loadUserSubtypes`, `handleSetSubtypes`), `src/tokens/merge.ts`, `src/tokens/types.ts`
- Figma plugin docs — `figma.clientStorage`: 5MB per plugin, per user, per device; unsynced; clearable by the user

---

## Amendment 1 — 2026-09-05 — confirmed subtypes travel through the repo

**Status**: Accepted. Written by `@frontend-engineer` alongside issue #23 (Phase 10); records what the code now does, and corrects a sentence in §3 that had been read as a promise the implementation never kept.

### Why

§3 said subtype edits "go where they already go: `userSubtypes` … that mechanism already round-trips, is already persisted, and is already the thing ADR-0002 §3 makes the committed files authoritative for at Phase 6." Two of those three were true. The mechanism round-tripped a **re-import on the same machine**; it was never pointed at the committed files, because Phase 6 shipped `extractUserSubtypes` and `extractUserSubtypesFromFiles` without a caller. So the last clause described an intent, not a behaviour, and the consequence was a real bug: a second machine pulling the same tree rebuilt every confirmed token as `subtypeSource: "default"`, re-asked for all of them, and — since the rebuilt `$extensions` no longer matched the repo's — read an untouched tree as a file to push.

`README.md` and this ADR disagreed about it, which is how the gap survived four phases (`docs/ux/user-journeys.md` §13d gap 16 called the contradiction before anyone checked which side was right).

### What is true now

- A confirmed subtype is **build metadata that is committed**: `build.ts` writes `subtype` / `subtypeSource` into the token's `$extensions."com.tokenvault"` (ADR-0002 §3), so it has always been part of the pushed bytes. That half needed no change.
- Every repo tree that reaches the sandbox — `git-repo-baseline`, which fires on a connect that adopts the repo and after every pull — is read for `subtypeSource: "user"` tags via `extractUserSubtypesFromFiles`, and `adoptUserSubtypes` merges them into this device's `userSubtypes` before the rebuild.
- **Adoption fills gaps only.** An id this device has already answered keeps its answer, for §4's reason: the repo's version is one pull away and an overwritten local decision is gone. A genuine disagreement is therefore kept locally and shows up as a file to push, which is where the two devices settle it.
- Adoption is **not** a write in ADR-0006 §5's sense. A subtype never reaches the Figma document — its only consumers are `$extensions` and the editor's `subtypeWarning` — so there is nothing for it to mutate. Pulled *values* and *descriptions* are unchanged: they still land as pending overlay entries and still go to Figma only through the apply flow.
- `clientStorage` remains the per-device store the build reads from. It is now a working copy of an answer whose durable home is the repo, which is exactly the demotion §3 predicted.

### What is unchanged

- Subtypes still do not go in the overlay. §3's actual decision stands, and this amendment is the reason it stands: two storage paths for one concern is precisely what adoption avoids by keeping `userSubtypes` the single build input.
- The **edit overlay** and the **PAT** stay per-device (§1, ADR-0006 §1). That is deliberate and out of scope for #23: an edit is uncommitted work, and a PAT is a credential.
- The 5MB budget is untouched — the tag store is a few hundred bytes and gains nothing here.

### References

- GitHub issue #23; `docs/ux/user-journeys.md` §13d gap 16, §14 open question 1
- `src/tokens/subtype.ts` (`adoptUserSubtypes`), `src/code.ts` (`adoptRepoSubtypes`, `setRepoBaseline`)
- `test/subtypeSync.test.ts` — the push-side write and the pull-side read, including diff stability
