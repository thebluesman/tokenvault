# ADR-0005 — Applying tokens to Figma, and drift detection

**Status**: Proposed
**Date**: 2026-09-02
**Owner**: @tech-lead

> Shyam resolved four of this ADR's open questions on 2026-09-02, before acceptance. They are folded into the decision sections below and marked *(resolved 2026-09-02)*: confirmation is always shown (§6), conflicts block apply (§10), deletion is its own destructive confirmation (§5), and aliases are applied as native Figma variable references (§11). The status stays Proposed — the ADR as a whole has not been accepted.

## Context

Phase 5 (PRD §9 item 5) reverses the arrow that Phases 2–4 built: token values go back into Figma (§6.5.2), and Figma-side changes made outside the token workflow get flagged (§6.5.3).

Four facts from what already exists constrain the design.

- **Every token in the plugin today came from Figma.** Phase 4 deferred creation (ADR-0004 §2, UX §2), so every token carries `figma.variableId + modeId` or `figma.styleId` provenance. There is no such thing yet as a token with no Figma counterpart.
- **The only tokens that differ from Figma are the ones in the edit overlay.** The built tree is re-derived from a scan on every rebuild; the overlay is the sole divergence. ADR-0004 §Consequences already said this out loud: *"The overlay is a diff against Figma, which is the same shape Phase 5 needs to write values back."*
- **There is no token source independent of Figma until Phase 6.** Git sync has not landed. That has a sharp consequence for drift, dealt with in §5.
- **The three-way merge already detects Figma-side movement.** ADR-0004 §4's `edit-conflict` — Figma moved away from an edit's `base` — is drift, discovered for the subset of tokens that carry an edit. Phase 5 does not need a new mechanism, it needs that one widened.

Scope, per the phase brief: single file, no themes and no math (Phase 7), no git (Phase 6). The brief also scoped out aliases; Shyam pulled alias *writing* back in on 2026-09-02, for the reasons in §11.

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
src/tokens/plan.ts       NEW — pure. Built tree + overlay → ApplyPlan (ops, skips with reasons);
                               owns the path→variableId index and the cycle check (§11)
src/tokens/drift.ts      NEW — pure. Fresh tree vs. baseline tree → DriftEntry[]
src/tokens/references.ts reused — `isReference`, `referenceTarget`, `normalizePathKey` (§11)
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
| Variable alias | `variable.setValueForMode(modeId, { type: "VARIABLE_ALIAS", id })` (§11) |
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

### 5. Delete is applied, but only for a target with no inbound references, and never inside a normal apply *(resolved 2026-09-02)*

An overlay `delete` tombstone means "this token should not exist". Applying it calls `variable.remove()` or `style.remove()`, which is the one genuinely destructive thing this phase does. Shyam's call: allowed, but never bundled.

Three guards, the first of which the codebase already implements:

- **Refused when the target has inbound references.** Phase 4 already blocks deleting a token that other tokens alias (`src/tokens/references.ts`); apply reuses that check rather than re-deriving it. Removing an alias target cascades into every referrer, which is the same blast-radius argument ADR-0002 Amendment 1 §F used to pick collision winners.
- **Deletion is its own action, not a group inside the apply preview.** A normal apply — value and description edits — can never remove anything from the file, whatever is sitting in the overlay. Pending tombstones are surfaced, but reaching them takes a separate, explicitly chosen step with its own confirmation.
- **The UI treats it as destructive.** `@ux-designer` owns the surface, but not the register: this action gets destructive treatment — a distinct confirmation naming what will be removed and how many, and visual weight that does not read like the adjacent apply button. It must not be reachable by muscle memory from the apply flow. What the copy says is UX's; that it warns is this ADR's.

### 6. Apply is previewed, per-entry, not transactional, and ends in a rescan

- **Preview first, always — including a single-token apply, and with no way to turn it off** *(resolved 2026-09-02)*. The plan is rendered before anything is written, and confirmed, every time. There is no "don't ask again", no remembered preference, and no small-change fast path. The reasoning is that the cost is one click on the cheap end and an unreviewed write to a shared design file on the expensive end, and a suppression toggle is only ever exercised by the user who has stopped reading. A one-entry preview is also cheap to render, so the exception would buy nothing but the inconsistency. Same shape and, ideally, the same component as Phase 6's diff view.
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

### 10. Apply refuses to write a target that is in conflict *(resolved 2026-09-02)*

If a target carries both a local edit and Figma-side drift — ADR-0004's `edit-conflict` — apply **skips it** (`apply-conflicted`) until the conflict is resolved one way or the other.

Writing anyway would silently destroy a change a designer made in Figma, using a value the user authored before that change existed and has not looked at since. ADR-0004 §4 chose "local edit wins" for the *tree*, which is non-destructive because the tree is a local view; the same rule at the *write* boundary is destructive, because Figma is the artifact other people see. The two boundaries genuinely warrant different defaults.

Resolution is already built: ADR-0004 §4's per-token keep-mine / take-Figma's. Resolving with keep-mine leaves an ordinary entry that applies normally on the next run.

Shyam confirmed this on 2026-09-02, with the strictness understood and intended.

### 11. Aliases apply as native Figma variable references, never as flattened values *(resolved 2026-09-02)*

Shyam's call: a token whose value points at another token — `button.background` → `{color.blue.500}` — must land in Figma as a real Variable-to-Variable reference. This reverses the deferral this ADR originally proposed, and it is the right reversal. Flattening a pointer to a resolved hex destroys the semantic layer the whole tool exists to manage, which is the same objection ADR-0002 §2 and ADR-0003 §3 already sustained on the import side. Apply should not be the one direction where that rule lapses.

**The write is one line.** Figma models aliases natively: `variable.setValueForMode(modeId, { type: "VARIABLE_ALIAS", id: targetVariableId })`. There is no synthesis, no encoding, no shape to invent.

**The work is the resolver**, and it is small. `toFigma` needs `{dotted.path}` → `variableId`, which is an index built from the tokens already in hand — every token carries its path and its `figma.variableId`, so the index is a fold over the built tree. `src/tokens/references.ts` already supplies `isReference`, `referenceTarget`, and the case-normalised path matching (`normalizePathKey`) this needs; the only new code is the map and a lookup branch in the writer.

Three properties make this cheaper than it looks, and they are worth writing down because each one is a place a reader would reasonably expect a problem:

- **Multi-hop chains cost nothing.** If `a → b → c`, apply writes `a` as an alias to `b`'s id and `b` as an alias to `c`'s id, each independently. Figma resolves the chain at render time. Chain depth never enters the plugin's model, so there is no traversal to write and no depth limit to pick. **Single-level pointers and arbitrary-depth chains are the same implementation** — scoping to "single-level only" would not save any work, so it is not proposed.
- **The index is unambiguous by construction.** A path could in principle resolve to two variables, but that is precisely a `cross-set` or `token-group` collision, and ADR-0002 §5 already detects those and writes only the winner. The collision pass therefore guarantees the resolver's key uniqueness; no new disambiguation rule is needed.
- **Nothing in Phase 5 can currently author an alias.** Phase 4's editor refuses to edit a reference value at all (`isReadOnlyValue`, UX §5.3), so no overlay entry holds one. Under §1's overlay-scoped apply, an aliased token is never written, which means **pointer relationships are already preserved today — by not being touched.**

That last point is the honest scoping answer, and it is the one thing worth Shyam's attention rather than mine. Building the resolver in Phase 5 is not what makes aliases *editable*; that needs the Phase 4 editor to learn reference authoring, which is Phase 7 UI work and is **not** pulled forward here. What the resolver does buy is that the moment something can produce an aliased write — Phase 6 pulling a git tree that contains one — the flattening failure mode is closed off permanently, rather than discovered as data loss in a designer's file. It is cheap insurance bought at the point where it is cheap.

So: build the resolver and the write branch now; leave alias *authoring* to Phase 7.

Four guards, all failing loud per entry rather than at runtime mid-apply:

- **Unresolvable target** — the path names no variable in this file. Refused as `apply-skipped` / `alias-target-unknown`, reusing the report reason ADR-0002 Amendment 1 §G already defines for the import side.
- **Type mismatch** — Figma requires an alias target's `resolvedType` to match. Checked before the write.
- **Cycles** — a reference graph that closes on itself. Figma rejects a circular alias, but discovering that as a thrown error partway through a plan is the worst place to find out. The plan builder detects cycles up front and refuses the whole cycle, which is also the "circular reference detection with a clear error state" PRD §6.3 asks for, arriving early and for free.
- **Non-local targets** *(resolved 2026-09-02)* — a variable from a published team library is read-only to this file and cannot be aliased by local id. **Refused loudly, by an up-front check, never by attempting the write and catching what comes back.** A runtime error surfacing mid-plan is the failure mode this whole section exists to avoid: it lands after some entries have already been written, and it reaches the user as whatever string Figma chose rather than as a named skip reason. Reason: `apply-skipped` / `alias-target-non-local`.

  The check is cheap, because locality is already known. `scan.ts` reads only `getLocalVariablesAsync`, so **every token in the tree is local by construction** — a non-local variable can never be an apply *target*, only an alias *target*. Those arrive through `aliasTargetNames`, which `scan.ts` populates by resolving ids that were **not** in the local set (`localIds`). That set is precisely the non-local ones. The snapshot should carry the distinction forward as a flag rather than making `plan.ts` re-derive it, at which point the guard is a boolean test.

  Worth stating because it is not obvious: this is why apply never needs to ask whether its write target is writable. Import's local-only scan already guaranteed it.

### 12. Deliberately deferred

Named here so they are visibly out of scope rather than accidentally missing.

- **Bulk-apply to selected layers** (PRD §6.5.2, second bullet). Deferred to a follow-up ticket. It is a *binding* operation, not a value operation — `node.setBoundVariable(field, variable)`, `figma.variables.setBoundVariableForPaint(...)` for fills and strokes, and `node.setFillStyleIdAsync` / `setTextStyleIdAsync` / `setEffectStyleIdAsync` on the Styles side. What blocks it is not the API but the mapping: deciding that `space.4` binds to `itemSpacing` rather than `paddingLeft` needs subtype tagging that is still `subtypeSource: "default"` for most numbers (ADR-0002 §3), and a selection-scoped UI that is `@ux-designer`'s to design. Shipping it half-mapped would bind the wrong field to the right token, which is worse than not shipping it.
- **Authoring an alias in the editor.** §11 makes apply able to *write* a reference; nothing in Phase 5 lets a user *create* one. The editor still refuses to edit a reference value (UX §5.3), so the only producer of an aliased write is a Phase 6 pull. Reference authoring stays Phase 7.
- **Math expressions.** Phase 7. `{a} * 2` is not a reference (`references.ts` anchors the pattern deliberately) and has no Figma representation to write into.
- **Themes and modes as an apply target.** Apply writes the mode the token came from. Applying one token across modes, or switching a theme on the canvas (PRD §6.2), is Phase 7.
- **EASING / TIMING variables.** Still not imported (ADR-0002 Amendment 1 §A), so there is nothing to apply.
- **Creating Variables or Styles** — §4.

## Consequences

- `@frontend-engineer` can build Phase 5 against this: four modules, the plan interface, the write-API table, the three drift kinds, and the refusal rules are pinned.
- Apply is small. It touches only edited tokens, so a first real run writes a handful of values, not 1,316 — which is also what makes the preview reviewable by a human.
- Applied entries retire through ADR-0004's existing merge table. Phase 5 adds no new lifecycle state to the overlay, which is the main reason the overlay's cost in Phase 4 was worth paying.
- The apply plan and Phase 6's commit diff are the same shape, so the preview surface is built once. Phase 6 swaps the plan producer and the drift baseline; the executor and the comparator are unchanged.
- Drift in Phase 5 is scan-to-scan, and depends on an evictable cache. Users on a second device, or after clearing storage, get "unknown" rather than a false all-clear. Acceptable, and it stops being a limitation at Phase 6.
- Deletion reaches the designer's file. This is the first Tokenvault operation that can destroy something a person made, and it is why §5 puts it behind three guards and outside the apply flow entirely.
- Alias resolution (§11) lands earlier than planned, and brings PRD §6.3's circular-reference detection with it as a side effect. The alias *authoring* UI is not pulled forward with it, so Phase 5 ships a write path that only Phase 6 can exercise — deliberate, and cheap enough to be worth it.
- No infra implication. Figma APIs and files in a git repo; PRD §8's zero-recurring-cost constraint is untouched.

## Alternatives considered

- **Apply the whole tree, not the overlay.** Rejected. Every unedited token would be written back with the value just read from it — thousands of no-ops that churn version history and undo, for no observable effect. It also has no meaning until a token source independent of Figma exists, which is Phase 6.
- **Invert `build.ts` mechanically / add a reverse mode to it.** Rejected. Import is deliberately lossy at specific, documented points (ADR-0003 §3); a derived inverse must guess exactly there. A separate module that refuses where import degraded makes the lossiness explicit and testable.
- **Have apply create a Variable when none exists.** Rejected for Phase 5 — no token can currently reach that state, and creating means deciding collection, mode, type, scopes and name, which is authoring. It becomes real at Phase 6 and gets designed then.
- **A dedicated `last-applied` store as the drift baseline.** Rejected. Apply is followed by a rescan, which refreshes the import cache to include everything just written — so a separate applied-value store would always hold a copy of what the cache already says. One baseline, one store, and ADR-0004 §6's quota story stays intact.
- **Poll for drift on a timer, or on every canvas change.** Rejected. Detection costs a full scan and build; running it when the user has not asked is the plugin's most expensive operation on a loop. On-scan plus on-demand covers the actual moments the answer matters.
- **Treat drift as a third source in the merge, alongside imported and edited.** Rejected — it is the imported side moving, not a new party. Modelling it as a third source would mean a three-way merge with four inputs and, worse, a second code path that can disagree with `mergeOverlay` about what "changed" means.
- **Let apply overwrite a conflicted target (local edit wins, as in the tree).** Rejected, and confirmed rejected by Shyam on 2026-09-02. Local-wins is non-destructive when it decides a local view and destructive when it decides a write to a shared file.
- **Skip the preview for a single-entry apply, or offer a "don't ask again".** Rejected (§6). The saving is one click; the exposure is an unreviewed write to a file other people work in, taken by the user least likely to be paying attention.
- **Flatten aliases to their resolved value on apply.** Rejected (§11). It destroys the semantic layer on the one leg of the round trip where import already refuses to, and the resolved value is derived data that Figma can compute itself.
- **Scope alias apply to single-level pointers only, deferring chains.** Rejected as a false economy. Each token's write is independent and Figma resolves chains natively, so depth never enters the implementation — a single-level restriction would be extra code enforcing a limit that costs nothing to lift.
- **Roll back a partially failed apply.** Rejected. A rollback pass has the same failure modes as the apply pass, and a failed rollback leaves a state neither side modelled. A precise per-entry report plus ⌘Z is more honest.
- **Skip deletion entirely in Phase 5.** Tempting — it is the only destructive operation here. Rejected because a tombstone that can never be applied makes Phase 4's delete a permanently local fiction, and the user would find that out at Phase 6 instead. The guards in §5 are the cheaper answer.

## Open questions (not decided here)

Two remain, and both are **API facts to verify during implementation**, not decisions to make:

- **Does `documentchange` (or any event) fire for Variables/Styles mutations?** If yes, §9 gets an event-driven check and a one-line amendment. `@frontend-engineer` to verify against the current typings.
- **Do a plugin's writes coalesce into one undo entry, and does that survive an apply followed by a rescan?** §6 leans on this for the escape hatch, and UX has committed to Figma's native ⌘Z with no custom undo — so if it does *not* coalesce, that is a finding both this ADR and `docs/ux/apply-and-drift.md` need to hear about before the copy ships. Do not promise ⌘Z until confirmed.

**Resolved since drafting** — recorded so the trail is visible rather than silently edited away:

- *By Shyam, 2026-09-02*: confirmation always shown (§6), conflicts block apply (§10), deletion allowed behind its own destructive confirmation (§5), aliases applied as native Figma references (§11), non-local alias targets refused by an up-front check (§11).
- *By `@ux-designer`, 2026-09-02, in `docs/ux/apply-and-drift.md`*: drift presentation (reuses the existing `⚑ flagged` chip pattern), the apply preview surface (modal), undo (Figma's native ⌘Z, no custom undo), a new green *in sync* state, delete-confirmation copy and placement, and alias display in the preview (unchanged from the existing pointer treatment). **This ADR does not restate or re-decide any of them** — it owns the entry kinds, when they are produced, and the refusal rules; the UX doc owns everything the user sees. If the two ever disagree, the UX doc wins on presentation and this one wins on semantics.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §3 `$type`/extensions and `figma.variableId` as the drift key, §7 determinism, Amendment 1 §A (EASING/TIMING), §F (blast-radius reasoning), §H (float32)
- ADR-0003 (`docs/adr/0003-styles-token-schema.md`) — §2 `styleId`/`styleKey` and `figma.fontStyle`, §3 per-kind value mapping and the lossy points apply must refuse at, §6 report additions, §7 module boundary
- ADR-0004 (`docs/adr/0004-local-edit-persistence.md`) — §1 the two stores, §2 overlay entry shape, §4 the three-way merge and `edit-conflict`, §6 quota and eviction
- PRD §6.2, §6.3 (aliasing and circular-reference detection, partly reached by §11), §6.5.2, §6.5.3, §8, §9 Phase 5: `docs/prd.md`
- `docs/ux/local-editor.md` — §2 (creation deferred), §5.3 (reference values read-only), §5.5 (conflict resolution)
- `docs/ux/apply-and-drift.md` — `@ux-designer`, in progress. Owns the apply preview, drift presentation, the *in sync* state, and the delete confirmation. Note that its green *in sync* state is the zero-drift, zero-overlay case of §7 — this ADR produces the entries, not the state name.
- Phase 2–4 implementation: `src/figma/scan.ts`, `src/figma/scanStyles.ts`, `src/tokens/build.ts`, `src/tokens/buildStyles.ts`, `src/tokens/styleValues.ts`, `src/tokens/overlay.ts`, `src/tokens/references.ts`, `src/code.ts`
- `@figma/plugin-typings` — `Variable.setValueForMode`, `PaintStyle.paints`, `TextStyle`, `EffectStyle.effects`, `GridStyle.layoutGrids`, `figma.loadFontAsync`, `figma.variables.createVariable`, `setBoundVariable`, `documentchange`
