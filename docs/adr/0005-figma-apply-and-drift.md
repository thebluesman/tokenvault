# ADR-0005 — Applying tokens to Figma, and drift detection

**Status**: Proposed
**Date**: 2026-09-02
**Owner**: @tech-lead

## Context

Phase 5 (PRD §9 item 5) reverses the arrow that Phases 2–4 built: token values go back into Figma (§6.5.2), and Figma-side changes made outside the token workflow get flagged (§6.5.3).

Four facts from what already exists constrain the design.

- **Every token in the plugin today came from Figma.** Phase 4 deferred creation (ADR-0004 §2, UX §2), so every token carries `figma.variableId + modeId` or `figma.styleId` provenance. There is no such thing yet as a token with no Figma counterpart.
- **The only tokens that differ from Figma are the ones in the edit overlay.** The built tree is re-derived from a scan on every rebuild; the overlay is the sole divergence. ADR-0004 §Consequences already said this out loud: *"The overlay is a diff against Figma, which is the same shape Phase 5 needs to write values back."*
- **There is no token source independent of Figma until Phase 6.** Git sync has not landed. That has a sharp consequence for drift, dealt with in §5.
- **The three-way merge already detects Figma-side movement.** ADR-0004 §4's `edit-conflict` — Figma moved away from an edit's `base` — is drift, discovered for the subset of tokens that carry an edit. Phase 5 does not need a new mechanism, it needs that one widened.

Scope, per the phase brief: single file, non-aliased values, no themes and no math (Phase 7), no git (Phase 6).

## Decision

### 1. Apply writes the overlay, not the tree

**The unit of apply is an overlay entry, not a token.** Apply flushes the local edit overlay into Figma and nothing else.

A whole-tree apply in Phase 5 would write Figma's own values back over themselves for every token but the edited handful — thousands of no-op writes whose only reliable effect is churning the file's version history and burning the user's undo stack. The overlay is already the exact set of tokens where the plugin and Figma disagree, and it is already the set the user authored deliberately.

The executor is nonetheless written against a general **apply plan** — an ordered list of `{ target, op, value }` with skip reasons — and not against `EditOverlay` directly. Phase 6 will produce a plan by diffing a pulled git tree against the current scan; that is a different *plan producer* over the same executor. Getting the seam right now costs one interface and saves rewriting the writer.

```
overlay ──┐
          ├──> ApplyPlan ──> apply executor ──> Figma
git (P6) ─┘
```

### 2. Provenance decides the target system; there is no Variables-vs-Styles choice to make

PRD §6.5.2 frames Variables as the primary path and Styles as a fallback for older files. In Phase 5 that framing does not produce a decision: a token imported from a Variable applies to that Variable, a token imported from a Style applies to that Style. The target is read off `$extensions["com.tokenvault"].figma`, the same key the overlay is already keyed by (ADR-0004 §2).

Choosing between the two systems is a *creation* question, and creation is deferred (§4). It resurfaces at Phase 6, when a pulled token may have no counterpart in this file.

### 3. Inverse conversion is a new hand-written layer, not an inverted `scan.ts`

`src/figma/scan.ts` and `scanStyles.ts` are I/O only — they flatten live API objects into plain-data snapshots. The schema decisions live in `build.ts`, `values.ts` and `styleValues.ts`. So the thing to invert is the conversion layer, and it gets its own module rather than a reverse mode inside the existing one:

```
src/tokens/toFigma.ts    NEW — pure. Token ($type, $value, $extensions) → FigmaWriteOp | Refusal
src/tokens/plan.ts       NEW — pure. Built tree + overlay → ApplyPlan (ops, skips with reasons)
src/tokens/drift.ts      NEW — pure. Fresh tree vs. baseline tree → DriftEntry[]
src/figma/apply.ts       NEW — the only module that calls a Figma write API
```

Same boundary precedent as ADR-0002 §Module layout and ADR-0003 §7: one impure edge, everything else pure and unit-testable without a Figma runtime.

**The inverse is hand-written and deliberately partial, because import is deliberately lossy.** ADR-0003 §3 omits a sub-key rather than invent one (`AUTO` line height), keeps an unmapped `fontName.style` as a string, and refuses gradients outright. A mechanically derived inverse would have to guess at exactly those points. So `toFigma` returns a refusal, not a value, wherever import degraded — and the round-trip property the tests should assert is *`toFigma(build(figma))` reproduces `figma` for every token import did not flag*, with flagged tokens asserted to refuse.

Two rules fall out and are worth pinning:

- **Apply writes only the sub-keys the token carries.** A typography token whose `lineHeight` was omitted as `AUTO` leaves the style's line height untouched. It never fills a gap with a default. Filling gaps is how a lossy import becomes a lossy *write*, which is unrecoverable.
- **`figma.fontStyle` is authoritative for text styles.** ADR-0003 §2 carries the raw style string precisely so apply hands it back verbatim; `fontWeight: 700` is never converted back into a style name.

Write APIs, per kind (to be confirmed against `@figma/plugin-typings` at build time, not taken from this ADR):

| Target | Call |
|---|---|
| Variable value | `variable.setValueForMode(modeId, value)` |
| Variable description | `variable.description = …` |
| Paint style | `style.paints = [ … ]` |
| Text style | `figma.loadFontAsync({ family, style })` **first**, then `style.fontName` / `fontSize` / `lineHeight` / `letterSpacing` / … |
| Effect style | `style.effects = [ … ]` |
| Grid style | `style.layoutGrids = [ … ]` |
| Deletion | `variable.remove()` / `style.remove()` |

`loadFontAsync` is the one call that fails for reasons outside the data — the font may not be installed on this machine. That failure is per-entry and reported, never swallowed, and never partially applied: load the font before touching any property of that style.

### 4. Apply never creates a Variable or a Style in Phase 5

Update and delete only. There is currently no token that could need creating: creation is deferred in Phase 4, so every token has a counterpart, and the only "no counterpart" case is an overlay entry whose target was deleted in Figma — already handled as `orphaned` (ADR-0004 §4) and skipped by apply as `apply-orphaned`.

Creating would also mean deciding a collection, a mode, a resolved type, a scope set, and a name — that is authoring, not applying, and it is a UI surface Phase 4 explicitly chose not to build.

Landing zone, recorded so it is not re-derived: creation becomes genuinely necessary at Phase 6, when a pulled tree holds tokens this file lacks. It needs a collection-resolution rule (the manifest's `$figmaCollectionId` back-reference is the obvious candidate) and `figma.variables.createVariable(name, collection, resolvedType)`. It is its own decision and probably its own ADR.

### 5. Delete is applied, but only for a target with no inbound references, and never in bulk

An overlay `delete` tombstone means "this token should not exist". Applying it calls `variable.remove()`, which is the one genuinely destructive thing this phase does.

Two guards, the first of which the codebase already implements:

- **Refused when the target has inbound references.** Phase 4 already blocks deleting a token that other tokens alias (`src/tokens/references.ts`); apply reuses that check rather than re-deriving it. Removing an alias target cascades into every referrer, which is the same blast-radius argument ADR-0002 Amendment 1 §F used to pick collision winners.
- **Deletes are a separately confirmed group in the apply preview.** They are never carried along by an "apply all" over value edits. Whether that is a second button, a checkbox, or a second screen is `@ux-designer`'s call; that it is a distinct confirmation is this ADR's.

### 6. Apply is previewed, per-entry, not transactional, and ends in a rescan

- **Preview first, always.** The plan is rendered before anything is written — the same shape and, ideally, the same component as Phase 6's diff view. Nothing writes to a designer's file without the write being shown first.
- **No rollback.** Figma plugin writes are not transactional. A rollback pass can itself fail halfway and leave the file in a state neither side predicted. Instead: entries are applied in a defined order, each succeeds or fails independently, and the result is an apply report naming every failure. Figma coalesces a plugin run's edits into a single undo entry, so ⌘Z remains the user's escape hatch — **verify this against the current plugin API before relying on it in the UI copy.**
- **A successful apply is followed by a rescan.** This is not housekeeping; it is what retires the overlay. ADR-0004 §4's merge table already says *"Value equals the entry's `value` → Figma caught up to the edit. Retire the entry silently."* An applied edit is exactly that case, so applied entries retire through existing code with no new retirement logic and no new state. An entry that fails to apply does not match, stays in the overlay, and stays visible.

### 7. Drift is the existing three-way merge, widened from edited tokens to all tokens

Drift needs a baseline. **The baseline is the import cache** (`tokenvault:last-import:<file-id>`, ADR-0004 §1) — the serialised result of the last scan. No third store is introduced.

| Case | Baseline | Mechanism |
|---|---|---|
| Token has an overlay entry | the entry's `base` | ADR-0004 §4's merge — drift surfaces as `edit-conflict` |
| Token has no overlay entry | the import cache | new: `drift.ts` compares fresh scan to cached scan |

So drift is **not a third source alongside "imported" and "locally edited"**. It is a property of the imported side — the observation that Figma moved since the plugin last looked. The overlay stays a two-sided merge; drift is what makes the second side's movement visible for the ~99% of tokens that carry no edit.

Three entry kinds, added to the existing `ImportReport` (additive, so `version` stays `1`, consistent with ADR-0003 §6):

- **`drift-value`** — the target exists in both, values differ. Carries `path`, `set`, baseline value, current value.
- **`drift-added`** — a Variable or Style present now, absent from the baseline.
- **`drift-removed`** — present in the baseline, gone now.

`ImportCounts` gains optional `drifted`.

### 8. Phase 5 drift is "changed since your last scan", and the ADR says so rather than implying more

This is the honest limit and it should not be discovered later.

With no git sync, the token JSON *is* re-derived from Figma on every scan, so "the token file disagrees with Figma" is not a state that can exist for an unedited token. What §7 detects is the delta between two scans. That is genuinely useful — it answers *"what did someone change in this file since I last looked?"* — but it is a **changelog against a local watermark, not divergence from a source of truth.**

True drift, in PRD §6.5.3's sense, becomes definable at Phase 6, when the committed `tokens/` tree is an authority independent of the file. The mechanism does not change when it arrives: the same comparator runs against the pulled tree instead of the cache. Only the baseline is swapped.

Corollary: **if the import cache is missing** (evicted, quota-cleared, a different file opened — ADR-0004 §6 makes it evictable by design), drift is *unknown*, not *none*. It reports as such and a scan re-establishes the baseline. A "no drift detected" that actually meant "no baseline" would be the worst possible lie for this feature to tell.

### 9. Detection runs on scan and on demand — no polling

Drift is computed as a by-product of every scan, plus a dedicated *check for drift* action that runs the same scan and reports without replacing the tree.

No background polling and no timer. Detecting drift requires a full `getLocalVariablesAsync` plus a build — on the Folio fixture that is the plugin's most expensive operation, and running it on a loop to catch a change the user is not currently asking about is a bad trade.

There is no reliable push signal to use instead: Figma's `documentchange` event reports node-level changes, and whether it fires for Variables and Styles mutations is **not something this ADR asserts** — `@frontend-engineer` should verify against the current typings, and if a reliable event does exist, an event-driven check is a strictly better §9 and worth a one-line amendment.

### 10. Apply refuses to write a target that is in conflict

If a target carries both a local edit and Figma-side drift — ADR-0004's `edit-conflict` — apply **skips it** (`apply-conflicted`) until the conflict is resolved one way or the other.

Writing anyway would silently destroy a change a designer made in Figma, using a value the user authored before that change existed and has not looked at since. ADR-0004 §4 chose "local edit wins" for the *tree*, which is non-destructive because the tree is a local view; the same rule at the *write* boundary is destructive, because Figma is the artifact other people see. The two boundaries genuinely warrant different defaults.

Resolution is already built: ADR-0004 §4's per-token keep-mine / take-Figma's. Resolving with keep-mine leaves an ordinary entry that applies normally on the next run.

**This is the main thing to push back on if it feels too strict** — see Open questions.

### 11. Deliberately deferred

Named here so they are visibly out of scope rather than accidentally missing.

- **Bulk-apply to selected layers** (PRD §6.5.2, second bullet). Deferred to a follow-up ticket. It is a *binding* operation, not a value operation — `node.setBoundVariable(field, variable)`, `figma.variables.setBoundVariableForPaint(...)` for fills and strokes, and `node.setFillStyleIdAsync` / `setTextStyleIdAsync` / `setEffectStyleIdAsync` on the Styles side. What blocks it is not the API but the mapping: deciding that `space.4` binds to `itemSpacing` rather than `paddingLeft` needs subtype tagging that is still `subtypeSource: "default"` for most numbers (ADR-0002 §3), and a selection-scoped UI that is `@ux-designer`'s to design. Shipping it half-mapped would bind the wrong field to the right token, which is worse than not shipping it.
- **Aliased values.** A token whose `$value` is `{a.b.c}` is refused (`apply-skipped` / `alias-value`). Writing one means resolving a dotted path to a `variableId` and calling `setValueForMode` with a `VARIABLE_ALIAS`, which is Phase 7's resolution semantics. Phase 4's editor cannot currently author an alias, so this is a defensive guard, not a common path.
- **Math expressions.** Phase 7.
- **Themes and modes as an apply target.** Apply writes the mode the token came from. Applying one token across modes, or switching a theme on the canvas (PRD §6.2), is Phase 7.
- **EASING / TIMING variables.** Still not imported (ADR-0002 Amendment 1 §A), so there is nothing to apply.
- **Creating Variables or Styles** — §4.

## Consequences

- `@frontend-engineer` can build Phase 5 against this: four modules, the plan interface, the write-API table, the three drift kinds, and the refusal rules are pinned.
- Apply is small. It touches only edited tokens, so a first real run writes a handful of values, not 1,316 — which is also what makes the preview reviewable by a human.
- Applied entries retire through ADR-0004's existing merge table. Phase 5 adds no new lifecycle state to the overlay, which is the main reason the overlay's cost in Phase 4 was worth paying.
- The apply plan and Phase 6's commit diff are the same shape, so the preview surface is built once. Phase 6 swaps the plan producer and the drift baseline; the executor and the comparator are unchanged.
- Drift in Phase 5 is scan-to-scan, and depends on an evictable cache. Users on a second device, or after clearing storage, get "unknown" rather than a false all-clear. Acceptable, and it stops being a limitation at Phase 6.
- Deletion reaches the designer's file. This is the first Tokenvault operation that can destroy something a person made, and it is why §5 has two guards and its own confirmation.
- No infra implication. Figma APIs and files in a git repo; PRD §8's zero-recurring-cost constraint is untouched.

## Alternatives considered

- **Apply the whole tree, not the overlay.** Rejected. Every unedited token would be written back with the value just read from it — thousands of no-ops that churn version history and undo, for no observable effect. It also has no meaning until a token source independent of Figma exists, which is Phase 6.
- **Invert `build.ts` mechanically / add a reverse mode to it.** Rejected. Import is deliberately lossy at specific, documented points (ADR-0003 §3); a derived inverse must guess exactly there. A separate module that refuses where import degraded makes the lossiness explicit and testable.
- **Have apply create a Variable when none exists.** Rejected for Phase 5 — no token can currently reach that state, and creating means deciding collection, mode, type, scopes and name, which is authoring. It becomes real at Phase 6 and gets designed then.
- **A dedicated `last-applied` store as the drift baseline.** Rejected. Apply is followed by a rescan, which refreshes the import cache to include everything just written — so a separate applied-value store would always hold a copy of what the cache already says. One baseline, one store, and ADR-0004 §6's quota story stays intact.
- **Poll for drift on a timer, or on every canvas change.** Rejected. Detection costs a full scan and build; running it when the user has not asked is the plugin's most expensive operation on a loop. On-scan plus on-demand covers the actual moments the answer matters.
- **Treat drift as a third source in the merge, alongside imported and edited.** Rejected — it is the imported side moving, not a new party. Modelling it as a third source would mean a three-way merge with four inputs and, worse, a second code path that can disagree with `mergeOverlay` about what "changed" means.
- **Let apply overwrite a conflicted target (local edit wins, as in the tree).** Rejected as the default, kept as the open question. Local-wins is non-destructive when it decides a local view and destructive when it decides a write to a shared file.
- **Roll back a partially failed apply.** Rejected. A rollback pass has the same failure modes as the apply pass, and a failed rollback leaves a state neither side modelled. A precise per-entry report plus ⌘Z is more honest.
- **Skip deletion entirely in Phase 5.** Tempting — it is the only destructive operation here. Rejected because a tombstone that can never be applied makes Phase 4's delete a permanently local fiction, and the user would find that out at Phase 6 instead. The guards in §5 are the cheaper answer.

## Open questions (not decided here)

- **Is §10 too strict?** Refusing to apply a conflicted target means a designer's Figma tweak blocks the user's edit until they look at it. The looser option is local-wins-with-a-warning, matching the tree. Shyam's call — it is a judgement about whose change is more likely to be right in this file, and I do not have that evidence.
- **Should applying a delete be possible at all from the plugin?** §5 says yes with guards. If the answer is "never remove a Variable from a designer's file", the tombstone becomes a Phase-6-only concept (delete the token in git, let a human delete the Variable) and §5 shrinks to nothing. Also Shyam's call, and worth deciding before it is built rather than after.
- **Does `documentchange` (or any event) fire for Variables/Styles mutations?** An API fact, not a decision. If yes, §9 gets an event-driven check and a one-line amendment. `@frontend-engineer` to verify.
- **Does a plugin's writes coalesce into one undo entry, and does that survive an apply followed by a rescan?** §6 leans on this for the escape hatch. Same verification, and it affects UI copy — do not promise ⌘Z until it is confirmed.
- **Drift presentation.** Whether drift rides the existing `⚑ flagged` chip, gets its own filter, or gets its own tab — and how a `drift-value` row shows both sides. `@ux-designer`'s call; this ADR fixes only the entry kinds and when they are produced.
- **The apply preview's surface.** Whether it is a modal, a tab, or the Phase 6 diff view arriving early. Product/UX.
- **Non-local Variables.** A file can reference variables from a published team library, which are read-only. Import already resolves their names for aliases (`scan.ts`); apply must refuse to write them, and it is worth confirming what the API does on the attempt — refuse loudly, do not discover it as a runtime error in front of a designer.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §3 `$type`/extensions and `figma.variableId` as the drift key, §7 determinism, Amendment 1 §A (EASING/TIMING), §F (blast-radius reasoning), §H (float32)
- ADR-0003 (`docs/adr/0003-styles-token-schema.md`) — §2 `styleId`/`styleKey` and `figma.fontStyle`, §3 per-kind value mapping and the lossy points apply must refuse at, §6 report additions, §7 module boundary
- ADR-0004 (`docs/adr/0004-local-edit-persistence.md`) — §1 the two stores, §2 overlay entry shape, §4 the three-way merge and `edit-conflict`, §6 quota and eviction
- PRD §6.2, §6.5.2, §6.5.3, §8, §9 Phase 5: `docs/prd.md`
- `docs/ux/local-editor.md` — §2 (creation deferred), §5.5 (conflict resolution)
- Phase 2–4 implementation: `src/figma/scan.ts`, `src/figma/scanStyles.ts`, `src/tokens/build.ts`, `src/tokens/buildStyles.ts`, `src/tokens/styleValues.ts`, `src/tokens/overlay.ts`, `src/tokens/references.ts`, `src/code.ts`
- `@figma/plugin-typings` — `Variable.setValueForMode`, `PaintStyle.paints`, `TextStyle`, `EffectStyle.effects`, `GridStyle.layoutGrids`, `figma.loadFontAsync`, `figma.variables.createVariable`, `setBoundVariable`, `documentchange`
