# ADR-0007 — Themes, reference authoring, and math expressions

**Status**: Accepted
**Date**: 2026-09-03
**Accepted**: 2026-09-03 — Shyam resolved the three questions that gated scope. The two still open are for whoever implements Phase 7 and Phase 8 respectively, and neither blocks starting; see [Open questions](#open-questions-not-decided-here).
**Owner**: @tech-lead

> Shyam resolved three of this ADR's five open questions on 2026-09-03, before acceptance. They are folded into the decision sections below and marked *(resolved 2026-09-03)*: **theme composition editing is out of Phase 7** — read-only theme selection and switching only, with the composition design kept here as documented-but-not-built (§7b); a reference that dangles in some themes **warns and allows the edit, never refuses** (§5 rule 4); and whether the editor steers users from an expression toward a plain reference is **`@ux-designer`'s, revisited when Phase 7 UX docs are written** (§4). Two questions remain open by design: what live theme switching targets (Phase 7 implementation) and whether Phase 8's export evaluates expressions (Phase 8).

## Context

Phase 7 (PRD §9 item 7) is the first phase whose features are all *authoring* features rather than plumbing: themes composed from sets (§6.2), tokens that point at other tokens and compute from them (§6.3), and a clear error state when those pointers close on themselves.

Five facts from what already exists constrain the design, and between them they make Phase 7 smaller than it looks.

- **References already exist in the data and already apply correctly.** ADR-0002 §2 fixed the wire format (`{dotted.path}`, mode-free), and ADR-0005 §11 pulled alias *writing* forward — apply already resolves a reference to a native Figma `VARIABLE_ALIAS` and already refuses cycles up front. What is missing is the ability for a user to *author* one: `docs/ux/local-editor.md` §5.3 renders a reference value read-only and says so in the copy, and ADR-0005 §12 names "authoring an alias in the editor" as Phase 7's.
- **Half of the reference graph is already built.** `src/tokens/references.ts` has the anchored reference pattern, `referenceTarget`, case-normalised path keys, and `buildInboundIndex` — which is precisely the reverse edge set of the graph a cycle check walks forward. Phase 7 adds the forward direction and a traversal; it does not add a data model.
- **`isReference` deliberately excludes math.** The regex is anchored (`^\{…\}$`) with a comment saying `{a} * 2` is not a reference. That decision is load-bearing and §1 keeps it: an alias and an expression have different apply semantics, so conflating them at the recogniser would be a bug that surfaces as data loss in a designer's file.
- **Resolution is already theme-scoped by construction.** ADR-0002 §2: *"a token's `$value` alone does not determine a concrete value; resolution is always theme-scoped."* So there is no way to ship reference resolution or expression evaluation without first deciding what "the active theme" is. Themes are not a parallel feature in Phase 7; they are its prerequisite.
- **ADR-0002 §6 explicitly deferred theme *composition* here**, filing a `theme-composition` / `ambiguous` report entry rather than guessing a cartesian product for a file with two or more multi-mode collections. Such a file has no themes at all today, which means the resolver would have nothing to resolve against. This ADR designs the answer (§7b) but **does not build it in Phase 7** — that deferral is Shyam's call, and its cost is stated in Consequences.

Scope: no export pipeline (Phase 8), no token creation and no path rename (still ADR-0004's open questions, §10), no team semantics (PRD §4).

## Decision

### 1. An expression is a superset of a reference, with one grammar and one parser — and `isReference` does not change

Three value shapes, distinguished at recognition time and treated differently everywhere downstream:

| Shape | Example | Apply semantics |
|---|---|---|
| **Literal** | `#c33a2e`, `8`, `true` | Written verbatim (ADR-0005 §3) |
| **Reference** | `{core.spacing.4}` | Written as a native `VARIABLE_ALIAS` (ADR-0005 §11) |
| **Expression** | `{core.spacing.4} * 2` | **Evaluated and flattened to a number** (§4) |

`isReference` stays anchored and unchanged. An expression that happens to be a bare reference is a reference — `{a}` is an alias, `{a} * 1` is not, and the difference is real rather than pedantic: the alias keeps a live link in Figma and the expression does not (§4).

The grammar is deliberately small. Recursive descent, no precedence table beyond two levels:

```
expr    := term (("+" | "-") term)*
term    := factor (("*" | "/") factor)*
factor  := "-"? primary
primary := number | reference | "(" expr ")"
```

- **Operators**: `+ - * /`, unary minus, parentheses. Nothing else. No `%`, no comparison, no string concatenation.
- **Chained and nested expressions are allowed**, because recursive descent gives them for free. Restricting to a single binary operation would be extra code enforcing a limit that costs nothing to lift — the same false economy ADR-0005 §11 rejected for alias chains.
- **Numeric only.** Every operand must resolve to `$type: "number"`. A reference to a color, boolean or string inside an expression is a parse-time-valid, resolve-time error (§5). Color math is deferred (§10).
- **Unitless.** ADR-0002 §3 keeps Figma numbers raw and moves unit synthesis to the Style Dictionary transform layer, and Phase 7 does not reopen that. `4px * 2` is a **parse error**, not a silently stripped unit — inventing a unit here would bake the guess ADR-0002 §3 refused to make into the source of truth, one layer earlier.
- **No rounding.** The result is a full-precision float; the existing float32 handling (ADR-0002 Amendment 1 §H) applies at the Figma boundary, unchanged. Division by zero is an evaluation error (§5), not `Infinity` written to a variable.
- **No depth limit.** Termination is guaranteed by the cycle check (§3), which runs *before* evaluation. An arbitrary depth cap on top of that only buys false negatives on a legitimately deep chain.

### 2. The expression string is the `$value`; the computed number is never written to a file

```json
"space.button": { "$type": "number", "$value": "{core.spacing.4} * 2" }
```

Verbatim, in `$value`, no extension key, no companion field. This keeps ADR-0002 §7's byte-identical round trip (the string is stored and re-emitted, nothing is recomputed on write), diffs as one line when the author changes the expression, and diffs as *no* line when `core.spacing.4` moves — which is the entire reason to have expressions.

Rejected: `{"$value": 8, "$extensions": {"com.tokenvault": {"expression": "{core.spacing.4} * 2"}}}`. It stores derived data in a source file, so the `8` becomes a lie the moment the target changes, every dependent token's diff grows a spurious hunk on every upstream edit, and the file now has two places that can disagree about what the token is.

`$type` stays `number`. `subtype` / `subtypeSource` are unaffected and continue to come from ADR-0002 §3's rules.

**Consequence for DTCG compatibility, stated rather than implied**: a string in a `number` token's `$value` is a divergence, the same class as the ones ADR-0002 §4 already documents. It is the same divergence Tokens Studio ships, which is what Shyam's existing files and the atlas pipeline already assume — so this buys compatibility with the thing being replaced at the cost of strict-DTCG conformance the tool never had.

### 3. One reference graph, built once, checked at three points

The graph is `path → paths it points at`, over both reference and expression edges, resolved through the active theme's set stack (§6). `references.ts`'s `collectReferences` already walks composite values and `boundVariables` to produce exactly this edge list; the new code is the forward index and a depth-first walk with three-colour marking that returns the closing cycle as a path, not a boolean.

It is checked in three places, and it is **the same function in all three** — a second cycle implementation that could disagree with the first about what a cycle is would be worse than no check:

| Point | Scope | On failure |
|---|---|---|
| **Editor, on committing a value** | The edited token's reachable set, with the candidate edge added speculatively | Refuse the edit. The overlay entry is never written. |
| **Build / merge, after every scan, pull or theme change** | Whole graph, one pass | Report `reference-cycle`; the tokens on the cycle render as an error state |
| **`plan.ts`, before apply** | Whole graph | Refuse every token on the cycle (already ADR-0005 §11's rule, widened from alias edges to alias + expression edges) |

The editor check is cheap because it is scoped to what the edited token can reach, not to 1,316 tokens.

**The error state is the cycle, not the token.** PRD §6.3 asks for "circular reference detection with a clear error state", and the clear thing to show is the loop: `space.a → space.b → space.c → space.a`. Every token on the loop is in the error state, not just the one whose edit closed it — blaming the last edge is arbitrary, since any token on the cycle can be edited to break it. There is **no partial evaluation and no fallback value**: a cycle produces an error where a value would go, never a zero, never the last good number.

A self-reference is a cycle of length one and gets identical treatment.

### 4. Evaluation happens at three points; apply is the only one that flattens

- **On authoring** — parse, resolve, type-check and cycle-check when the value field is committed. This is where PRD §6.3's error state is actually delivered to the user, because it is the moment they can fix it.
- **On display** — the browser's value preview shows the computed number alongside the expression. Theme-scoped (§6), recomputed on every rebuild, **never persisted**.
- **On apply** — `toFigma` evaluates the expression and writes a concrete number via `setValueForMode`. Figma has no representation for arithmetic, so flattening is not a choice; the choice is whether to make it visible, and it is: the apply preview (ADR-0005 §6) shows the expression and the number it resolved to, so a user cannot flatten without seeing the number that lands.

Not evaluated at import (nothing Figma exports is ever an expression) and not evaluated at push (the file carries the string, §2).

**The honest cost, and it belongs in the UI rather than only here**: an expression-valued token loses its live link in Figma. `{a}` applies as an alias and tracks `a` forever; `{a} * 2` applies as a number and goes stale the moment `a` changes in Figma, until the next apply. This is inherent to the Figma data model, not a Tokenvault limitation, but the user cannot be expected to derive it. Whether the editor nudges toward a plain reference where one would do is **`@ux-designer`'s surface, not an architecture decision** *(resolved 2026-09-03)* — explicitly left out of this ADR and revisited when Phase 7's UX docs are written. The technical fact above is what those docs have to work from; anything from silence to an inline warning is compatible with §1–§6 as decided.

### 5. Reference authoring: four rules, all checked before the overlay entry is written

Phase 7 lifts `docs/ux/local-editor.md` §5.3's read-only reference field. That doc deferred it to Phase 7 by name, so this is cashing in a deferral, not overturning a decision.

1. **The target must exist.** Resolved through the merged path index, case-normalised with the existing `normalizePathKey`, so that authoring and collision detection (ADR-0002 §5) agree on what "the same path" means. An unknown target is refused at authoring time.
   *This is stricter at authoring than at import.* A **pulled or imported** dangling reference is still reported, not refused — ADR-0002 Amendment 1 §G's `dangling-reference` kind is unchanged. The asymmetry is deliberate: refusing a value the user is typing costs them one correction, refusing a value that arrived from the repo would mean refusing to show them their own file.
2. **Types must match.** For a whole-value reference, the target's `$type` must equal the editing token's. For any operand inside an expression, the resolved type must be `number`. This is also what ADR-0005 §11 already needs for the Figma-side check (`resolvedType` must match for an alias write) — one rule, enforced at authoring so the failure lands where it can be fixed rather than as a skipped apply entry later.
3. **No cycle** — §3.
4. **Resolvable in the active theme — warn, never refuse** *(resolved 2026-09-03)*. A reference resolves through the active theme's set stack (§6), so validity is theme-scoped by ADR-0002 §2. A target that exists in the tree but not in every theme is a **warning, and the edit is allowed**: report kind `unresolved-in-theme`, naming the themes where it dangles. Shyam confirmed the proposed default. Refusing would make it impossible to author a theme-specific token, which is a normal thing to want — and it would make the theme feature and the reference feature mutually exclusive.
   **This holds for the active theme too**: a target that exists in the merged tree but does not resolve under the currently selected set stack warns and is written, it is not refused. The only authoring-time refusal for a missing target is rule 1's — a path that exists in no set at all, which is a typo rather than a theme-scoped absence.

Three new report kinds, additive, so `ImportReport.version` stays `1` (consistent with ADR-0003 §6 and ADR-0004 §5): **`reference-cycle`**, **`expression-error`** (parse failure, non-numeric operand, division by zero), **`unresolved-in-theme`**. They render through the existing `⚑ flagged` chip and row badges; no new UI concept.

### 6. Reference and expression edits are ordinary `set-value` overlay entries — with one amendment to ADR-0004 §4

No new overlay op, no new store, no change to ADR-0004 §2's entry shape. `value` is the string `"{a.b}"` or `"{a.b} * 2"`, `base` is the previous value, and the debounce, quota and eviction rules are untouched. That is the whole interaction for references, because import already renders a Figma alias as `{path}`, so ADR-0004 §4's merge compares two strings in the same rendering and works unchanged.

**Expressions break one row of that merge table, and it needs fixing rather than discovering.** After an apply, the overlay entry holds `"{a} * 2"` and Figma holds `8`. Those are never equal, so §4's *"Value equals the entry's `value` → Figma caught up, retire silently"* row never fires, and the entry falls through to *"differs from both `base` and `value`"* — reporting a spurious `edit-conflict` after every single apply.

The fix, which **ADR-0004 takes as a dated addendum pointing here** rather than being quietly re-decided:

> For an overlay entry whose `value` is an expression, the "Figma caught up" comparison is made against `evaluate(entry.value)`, and the outcome is **keep the entry, report nothing** — not retire it.

Keeping it is the point. An expression is authored data that Figma cannot store, so before Phase 6 the overlay is the only place it exists, and retiring the entry would silently downgrade the token to the flat number the expression happened to produce. Once connected to a repo (ADR-0006 §2) the committed file holds the expression and the overlay entry is uncommitted work in the ordinary way — same demotion ADR-0006 §2 already applied to everything else.

So: **an expression entry is sticky and re-applies on every rebuild.** That is the correct behaviour and it should not read as a bug in the local-edits list.

### 7. Themes: an active theme is the necessary part, and it is plugin state

Three things go by "themes" in PRD §6.2. Phase 7 needs them in this order, and only the first is unavoidable.

**(a) An active theme — lands, and everything else depends on it.** A single string, the theme's name from `$manifest.json`'s `themes[]`, stored per file at `tokenvault:active-theme:<file-id>` using ADR-0004 §1's existing `resolveStorageKey()` scheme. A few bytes; the 5MB budget is untouched. It selects the set stack that §4's resolution and §5's validation run against, in `selectedTokenSets` order, last-wins (ADR-0002 §1 — already decided, Phase 7 only implements the resolver).

Default is the first theme in the manifest, including ADR-0002 Amendment 1 §D's synthesised `Default`. If the stored name is gone after a rescan or pull, fall back to the first theme **and say so** — silently resolving against a stack the user did not choose would change every displayed value with no explanation.

**(b) Theme composition editing — designed here, NOT built in Phase 7** *(resolved 2026-09-03)*. Shyam's call, taking the smaller scope: **Phase 7 ships read-only theme selection and switching only** — pick and switch between the themes import already derives from Figma's collections and modes (ADR-0002 §6). Creating, renaming, deleting a theme, and editing its `selectedTokenSets`, are out of this phase. Nothing in §1–§6 depends on composition editing; §7(a) selects among the themes that exist and the resolver resolves against them, exactly as it would have.

The design below stands as the intended shape *if and when* composition editing is picked up. It is recorded rather than cut so that whoever builds it is not re-deriving it, but **none of it is Phase 7 work and none of it should appear in Phase 7's module layout (§8) or storage budget**:

> Storage follows the `userSubtypes` precedent (ADR-0004 §3), not the overlay: the overlay is keyed by Figma provenance id and a theme has none. A separate small store, `tokenvault:themes:<file-id>`, holds an override of the manifest's `themes[]` and is merged over the import-generated value on every build — the same "declared, inspectable transform over a reproducible build" shape ADR-0004 §4 chose for the overlay, so ADR-0002 §7's byte-identical build guarantee survives. Once connected to a repo, the committed `$manifest.json` is authoritative and the override is uncommitted work.

**What the deferral costs, stated rather than buried.** ADR-0002 §6's deferral is *not* discharged by this ADR. A file with two or more multi-mode collections still gets no themes and a `theme-composition` / `ambiguous` report entry, so for that file §7(a) has nothing to select and the resolver nothing theme-scoped to resolve against — references and expressions still work off the synthesised `Default` stack (ADR-0002 Amendment 1 §D), but themes are inert. That is an accepted, visible gap, not an oversight: it needs a decision on when it stops being acceptable, and the answer will come from whether Shyam's own files hit it. Whoever picks it up amends this ADR (§7b above is the design), rather than re-deciding it quietly.

**(c) Live canvas switching — lands, and needs no new data.** Every mode entry in the manifest already carries `$figmaCollectionId` and `$figmaModeId` back-references (ADR-0002 §6), so a theme's `selectedTokenSets` already maps to a list of (collection, mode) pairs. Switching is setting the explicit variable mode per collection on the Figma side and nothing else.

Four rules:

- **It is a view operation, not an apply.** It writes no token values, so it does **not** go through `ApplyPlan`, does not use the apply preview, and does not touch the overlay. Routing it through the apply confirmation would train users to click through a dialog that guards nothing.
- **It is still a document mutation** (explicit modes live on nodes/pages, not in plugin state), so it is a deliberate action in the Themes surface, plainly reversible with ⌘Z, and it uses ADR-0005's `commitUndo` bracketing so it is its own undo step.
- **Partial mapping is reported, never silent.** A theme may contain sets with no Figma counterpart — hand-authored themes cannot originate in the plugin now that (b) is deferred, but they arrive readily enough from a pulled `$manifest.json` (ADR-0006 §5). Switch every collection the theme *can* map and name every set it could not. Refusing the whole switch on one unmappable set would make hand-composed themes permanently unswitchable.
- **Styles-backed sets (ADR-0003) are expected-unmappable, not errors.** Figma Styles have no mode concept. They are excluded from the mapping silently, because reporting them every time would train the user to ignore the report.

What "switching" targets — the current page, the document root, or the current selection — is still open, for Phase 7's implementation to settle with Shyam (Open question 1).

**Apply stays single-mode.** ADR-0005 writes the mode a token came from, and Phase 7 does not add "apply this token across every mode". Deferred, §10.

### 8. Module layout

```
src/tokens/expr.ts        NEW — pure. tokenize / parse / evaluate → number | ExpressionError
src/tokens/graph.ts       NEW — pure. forward reference graph + cycle detection (§3), one implementation
src/tokens/resolve.ts     NEW — pure. active theme + set stack → resolver for references and expressions
src/tokens/themes.ts      NEW — pure. manifest themes → effective themes + active-theme
                          selection. Read-only; no composition override store (§7b deferred)
src/figma/modes.ts        NEW — the only module that sets explicit variable modes (§7c)
src/tokens/references.ts  reused, UNCHANGED — the anchored recogniser stays as-is (§1)
src/tokens/plan.ts        widened — cycle check covers expression edges; expressions flatten (§4)
src/tokens/overlay.ts     widened — the expression comparison in the merge (§6)
```

Same one-impure-edge boundary as ADR-0002 §Module layout, ADR-0003 §7, ADR-0005 §3 and ADR-0006 §1. `expr.ts`, `graph.ts` and `resolve.ts` are the whole of Phase 7's logic and none of them needs a Figma runtime or a network to test.

### 9. No infra implication

Everything here is arithmetic over data already in hand, plus a few bytes of `clientStorage`. PRD §8's zero-recurring-cost constraint is untouched, and there is no design choice in this phase that trades against it.

### 10. Deliberately deferred

Named so they are visibly out of scope rather than accidentally missing.

- **Color math** — `lighten()`, `darken()`, `mix()`, `alpha()`. Needs a color-space decision that ADR-0002 §4 deliberately avoided (hex strings, no `{colorSpace, components, alpha}`), and DTCG has nothing to model it with. Its own decision if it is ever wanted.
- **Functions and percentages** — `round()`, `min()`, `max()`, `clamp()`, `50%`. Not in §1's grammar. Each is cheap to add later; none is needed to satisfy PRD §6.3.
- **Units in expressions** — §1. Blocked on ADR-0002 §3's decision that units are a Phase 8 transform concern.
- **Sub-key reference authoring on composite tokens** — setting a typography token's `fontSize` to `{a}` from the editor. Composites already *carry* such references from import via `boundVariables`, and §5's rules would extend to them cleanly, but the editing surface is a separate UX design. Its own ticket.
- **Token creation and path rename** — still ADR-0004's open questions. Phase 7 does build the graph rename needs (renaming a path must rewrite every referrer, which is `buildInboundIndex` plus a rewrite pass), so rename is *unblocked* by this phase without being *decided* by it — it still needs an overlay op ADR-0004 §2 does not define.
- **Theme composition editing** — create/rename/delete a theme, edit its `selectedTokenSets`. Deferred out of Phase 7 by Shyam, 2026-09-03. Designed in §7b and left there unbuilt; it is the one deferral here that leaves a *named* prior deferral (ADR-0002 §6) outstanding.
- **Applying one token across every mode** — §7.
- **Multi-file / library themes** — a theme drawing sets from another Figma file. PRD §4 non-goals.

## Consequences

- `@frontend-engineer` can build Phase 7 against this: the grammar, the three value shapes, the storage format, the three evaluation points, the four authoring rules, the three report kinds, the one new store and the five modules are pinned.
- **References become authorable, which is the feature Phase 4 and 5 both deferred and both built toward.** ADR-0005 §11's resolver has had no producer since it shipped; Phase 7 gives it one, and does so against a write path that has already been exercised by Phase 6 pulls.
- **PRD §6.3's circular-reference requirement is met at three points rather than one**, and the earliest of them is the editor — so a cycle is normally something a user is told about while typing, not something they discover at apply time.
- **Themes become selectable but stay import-shaped.** Phase 7 gives themes an active selection and live canvas switching, both read-only over what import derived. **ADR-0002 §6's `ambiguous` entry is not discharged** (§7b): a file with several multi-mode collections still has no themes, and stays that way until composition editing is picked up. That is the price of the smaller phase, and it is a known gap rather than a surprise.
- **A new merge case in ADR-0004 §4, and a dated addendum there pointing here** (§6). It is the one place Phase 7 changes an accepted decision rather than extending it, and it is changed in the open.
- **Expressions are the one place Tokenvault flattens on the way into Figma**, which is the exact thing ADR-0002 §2, ADR-0003 §3 and ADR-0005 §11 all refused to do for aliases. The difference is that a flattened alias loses information Figma *could* have held, and a flattened expression loses information Figma *cannot* hold. Worth restating whenever someone reads §4 and objects.
- **One more `clientStorage` key** — the active theme name, a few bytes (the composition override store goes with §7b's deferral). ADR-0004 §6's quota story is unchanged; the import cache is still the only large tenant.
- Phase 8's Style Dictionary export now has to evaluate expressions, or hand them to Style Dictionary's own resolver, which understands `{a}` references but not arithmetic. That is a Phase 8 decision and this ADR does not make it — but §2's choice to store the string rather than the number is what leaves Phase 8 free to make it either way.
- No infra implication (§9).

## Alternatives considered

- **Store the computed value in `$value` with the expression in `$extensions`.** Rejected (§2). It puts derived data in the source of truth, where it goes stale on the first upstream edit and doubles the diff of every dependent token.
- **Widen `isReference` to match expressions.** Rejected (§1). An alias and an expression have opposite apply semantics — one keeps a live Figma link, one destroys it — so a recogniser that conflates them turns a UI convenience into silent data loss in a designer's file. The existing anchored regex already carries a comment saying exactly this; it was right.
- **Support a single binary operation only (`{a} * 2`), deferring chains and parentheses.** Rejected as a false economy, same shape as ADR-0005 §11's rejection of single-level-alias-only. Recursive descent gives chaining for free; restricting it means writing code to enforce a limit that costs nothing to lift.
- **Support units in expressions (`{a}px * 2`).** Rejected (§1). ADR-0002 §3 deliberately keeps Figma numbers raw and defers unit synthesis to the Phase 8 transform layer, where the target platform actually determines the unit. Parsing units here would bake that guess into the source of truth one layer earlier than the decision belongs.
- **Evaluate at apply time only, not at authoring time.** Rejected (§4). It is the difference between an error the user sees while typing and an error they see as a skipped apply entry with no obvious cause, possibly days later. Same reasoning as ADR-0005 §11's up-front non-local check.
- **Cap reference-chain depth as a defensive stop.** Rejected (§1). Cycle detection already guarantees termination, so a cap adds no safety and does add false negatives on legitimately deep chains.
- **Blame only the token whose edit closed a cycle.** Rejected (§3). Any token on the cycle can be edited to break it, so singling one out is arbitrary and misleads the user about where to look.
- **Fall back to the last good value, or zero, when a reference is unresolvable.** Rejected (§3). A number that is silently wrong is strictly worse than a visible error, and the whole point of the feature is that the number is derived rather than typed.
- **Refuse to author a reference that dangles in some theme.** Rejected (§5, confirmed by Shyam 2026-09-03). Theme-specific tokens are normal; refusing them makes the theme feature and the reference feature mutually exclusive.
- **A new overlay op for reference and expression edits.** Rejected (§6). They are value edits — ADR-0004 §2's `set-value` entry already carries a string, and adding an op would fork the merge, the local-edits list and the apply plan for no gain. Only the merge *comparison* needed a change.
- **Put theme composition in the edit overlay.** Rejected (§7b) — recorded against the deferred design, so that picking it up does not start from the overlay. The overlay keys on Figma provenance id (ADR-0004 §2) and a theme has none. The `userSubtypes` precedent is the right one, and it already exists.
- **Ship theme composition editing in Phase 7.** Rejected by Shyam 2026-09-03 (§7b), over the recommendation to include it. It is a new store, a new surface and a new merge path, and the case it unlocks — two or more multi-mode collections in one file — may not be one Shyam's own files hit. Read-only selection and switching is the smaller phase that still gives §1–§6 the theme scoping they require. The design survives in §7b for whoever needs it.
- **Route live theme switching through `ApplyPlan` and the apply confirmation.** Rejected (§7c). It writes no token values, so the confirmation would guard nothing — and a dialog that guards nothing is how users learn to click through the ones that do.
- **Refuse a theme switch when any of its sets is unmappable to a Figma mode.** Rejected (§7c). Styles-backed sets are unmappable by construction, so this would make most hand-composed themes permanently unswitchable. Partial-plus-named-report is the honest version.
- **Derive theme composition automatically from the cartesian product of multi-mode collections.** Rejected — this is exactly what ADR-0002 §6 refused to guess, and nothing has changed to make the guess safer. The answer is to let the user say, not to guess better.

## Open questions (not decided here)

Three of the original five were resolved on 2026-09-03 and are folded into the sections above: expression-vs-reference UX steering is `@ux-designer`'s (§4), a theme-dangling reference warns rather than refuses (§5 rule 4), and theme composition editing is out of Phase 7 (§7b). **Two remain open**, neither blocking a start on §1–§6.

1. **What does live theme switching target** — the current page, the document root, or the current selection? (§7c.) Different mental models, all one API call, and the right answer depends on how Shyam actually reviews a theme. **For Phase 7's implementation** to settle with Shyam before the switching surface ships; it does not gate §1–§6, and `@ux-designer` will need an answer when the Phase 7 UX doc is written.
2. **Does Phase 8's export evaluate expressions in the plugin, or hand them to Style Dictionary?** Style Dictionary understands `{a}` references but not arithmetic. **For Phase 8**, named here only so it is not rediscovered. §2's decision to store the string rather than the number is what keeps both options open.

Also parked, not open: **when ADR-0002 §6's `theme-composition` / `ambiguous` gap stops being acceptable** (§7b). Not a question to answer now — it becomes live the first time a real file has two multi-mode collections. Whoever picks it up amends this ADR.

**API facts to verify during implementation, not decisions**, in the manner of ADR-0005's:

- The exact call and receiver for setting an explicit variable mode (`setExplicitVariableModeForCollection` on a node/page, and whether a document-root equivalent exists) — check `@figma/plugin-typings` at build time, not this ADR.
- Whether `commitUndo` bracketing behaves for a mode switch the way ADR-0005's implementation found it does for value writes.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §1 set order and last-wins, §2 aliases as plain mode-free references and theme-scoped resolution, §3 `$type`/subtype and units deferred to Phase 8, §4 documented DTCG divergences, §5 collisions and path normalisation, §6 themes in the manifest and the deferral this ADR answers, §7 determinism; Amendment 1 §D (synthesised `Default`), §G (`dangling-reference`), §H (float32)
- ADR-0003 (`docs/adr/0003-styles-token-schema.md`) — §3 lossy points, §6 additive report kinds, §7 module boundary
- ADR-0004 (`docs/adr/0004-local-edit-persistence.md`) — §1 the stores and `resolveStorageKey`, §2 entry shape and id keying, §3 the `userSubtypes` precedent §7b follows, §4 the merge table §6 amends, §6 quota; open questions on creation and rename
- ADR-0005 (`docs/adr/0005-figma-apply-and-drift.md`) — §3 module boundary and `toFigma`, §6 preview and `commitUndo`, §11 alias resolution, type-match and cycle refusal, §12 the deferrals this ADR cashes in
- ADR-0006 (`docs/adr/0006-git-sync.md`) — §1 module boundary, §2 the repo as source of truth and the overlay's demotion
- PRD §6.1, §6.2, §6.3, §8, §9 Phase 7: `docs/prd.md`
- `docs/ux/local-editor.md` — §2 (feature line), §5.3 (reference values read-only — lifted by §5), §5.4 (local-edits list, which §6's sticky entries appear in)
- `docs/ux/apply-and-drift.md` — the apply preview §4 extends to show expression → number
- Implementation: `src/tokens/references.ts`, `src/tokens/overlay.ts`, `src/tokens/plan.ts`, `src/tokens/toFigma.ts`, `src/tokens/types.ts` (`ManifestTheme`), `src/code.ts` (`resolveStorageKey`)
- `@figma/plugin-typings` — explicit variable modes, `Variable.setValueForMode`, `figma.commitUndo`
