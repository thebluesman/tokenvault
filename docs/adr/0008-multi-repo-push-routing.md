# ADR-0008 — Multi-repo push routing

**Status**: Accepted
**Date**: 2026-09-04
**Accepted**: 2026-09-04 — Shyam resolved all eight open questions, three of them against this ADR's own recommendation: cross-repo references **refuse** rather than widen (§3), the PAT is **shared across repos** rather than per repo (§2), and there is **no primary repo** (§1). Two items go back to him: the drift baseline that the no-primary decision leaves undefined (§6a), and a GitHub constraint on shared fine-grained PATs that may not have been visible when he chose the shared model (§2). See [Open questions](#open-questions-not-decided-here).
**Owner**: @tech-lead

## Context

ADR-0006 connects a Figma file to exactly one GitHub repo, on one branch, with one PAT. Phase 10 (PRD §9 item 10) asks for any number of configured repos — Shyam was explicit that three is too low a cap — where **every token pushes to every repo by default**, and ordered exception rules route matching tokens to a subset instead (*"anything matching `abc` only goes to the android repo"*). The match pattern has no required relationship to the destination repo's name.

This extends ADR-0006 rather than contradicting it. Everything ADR-0006 decided about *one* repo — the module boundary (§1), SHA-based change detection (§3, §4), the Git Data commit sequence (§8), refusing a diverged file (§6), manual push and pull (§5), the failure taxonomy (§10) — is unchanged and runs per repo. What needs deciding is what becomes a list, what stays singular, and what a partial failure means. Three sentences in ADR-0006 stop being true as written, and §1, §4 and §6 below say what replaces each.

Rule matching reuses ADR-0002 Amendment 2 §A's matcher. That amendment is a prerequisite for this ADR and was accepted the same day.

Scope: GitHub only (PRD §4), PAT only (PRD §6.4), push fan-out and per-repo pull. No cross-repo merge, no organisation-level credential, no provider abstraction.

## Decision

### 1. N connections, no primary — Figma plus the local tree is the authored truth *(resolved 2026-09-04)*

A **connection** is what ADR-0006 §3 already stored, given an id and multiplied:

```jsonc
{ "id": "c_android", "owner": "…", "repo": "…", "branch": "main",
  "tokensDir": "tokens", "enabled": true }
```

Branch and `tokensDir` are per connection, not global — repos genuinely differ on both, and ADR-0006 §9's correction (`cb086ee`) already made both part of what invalidates a sync base.

**No connection is privileged.** This ADR originally proposed marking one `primary`, to keep ADR-0006 §2's sentence — *"the repo is the source of truth"* — grammatical in a world with N repos. Shyam rejected both the fixed and the changeable version of that, and the reasoning is better than the proposal: *"No primary, Figma is actually the source of truth at this stage."*

He is right about where data originates. Tokens are authored in Figma and edited in the plugin; a repo receives them. Elevating one repo to "more true" than another would be a claim about authority that nothing in the workflow actually earns — especially once routing means two repos legitimately hold different subsets, pushed at different times, neither of them the whole picture.

So ADR-0006's three-state model gains a column rather than a winner:

| | Where it lives | Role |
|---|---|---|
| **Figma** | the live file, via a scan | Where token values are authored |
| **Local tree** | `build(scan, userSubtypes, pathRules) + overlay` | **Authored truth** — what the tokens currently are |
| **Repos** | N of them, each at its own branch | Independently-tracked sync targets |

**How ADR-0006 §2 is reconciled.** Its claim was scoped to the single-repo case by the chapter it sits in, and generalises without contradiction: *the local tree is the authored truth; each repo is a sync target tracked independently against it.* In the degenerate one-repo case this behaves exactly as ADR-0006 described — one repo, one base, one answer to "does it agree?" — so nothing that shipped in Phase 6 changes meaning. **That much is editorial**, and §2 of ADR-0006 is marked with a scope note rather than rewritten.

One thing is *not* editorial: ADR-0006 §2's second act was demoting the overlay to "uncommitted work", and §7's swap of the drift baseline onto the repo depended on the repo being authoritative. The demotion survives — the overlay is uncommitted with respect to every connection, which is a stronger statement, not a weaker one. **The drift baseline does not survive**, and §6a resolves it as far as this ADR can before handing it back.

**Cap: 10 enabled connections** *(resolved 2026-09-04, as recommended)*. Not a technical limit — the constraint is that a status refresh costs one tree read per repo (§6) and the Review & push screen has to stay legible with a diff per repo. Ten keeps a refresh at ten calls against a 5,000/hr budget and a review screen at ten top-level groups.

### 2. One shared PAT across every connection *(resolved 2026-09-04)*

Shyam's call, reversing this ADR's recommendation of a token per repo. Setup simplicity wins over blast-radius isolation: connecting a fourth repo should not mean a fourth trip through GitHub's token UI, and a model that makes adding a repo expensive is a model that discourages using the feature it was built for.

Storage is therefore ADR-0006 §3's, with one key becoming a list and nothing else changing:

| Key | Scope | Size |
|---|---|---|
| `tokenvault:github` | `{ connections: [...], routingRules: [...], patLastFour }` | ~2 KB at 10 repos |
| `tokenvault:github-pat` | the PAT, alone, exactly as ADR-0006 §3 | < 1 KB |
| `tokenvault:sync:<file-id>:<connection-id>` | ADR-0006 §3's record, per repo | ~1 KB per repo per file |

Against ADR-0004 §1's 5MB, shared with a ~700KB import cache and the overlay: **~3KB of settings and ~10KB of sync state per synced Figma file at the cap.** The quota story is unchanged, and unchanged for ADR-0006's own reason — no tree is persisted, only SHAs.

**The tradeoff, recorded because it is a deliberate reversal of ADR-0006 §1's argument and should not be rediscovered as an oversight.** ADR-0006 §1 specified a fine-grained PAT scoped to a single repo *because* the blast radius of a leak is then one repository rather than an account. A shared token across ten repos is a leak that exposes ten repositories. Shyam has weighed that against setup friction and chosen friction-free. The three handling rules from ADR-0006 §1 — never rendered, never logged, held in a closure for the duration of one operation — carry over unchanged and now matter more, not less, because there is one secret rather than ten and it is worth more.

**A constraint that may complicate this, flagged rather than designed around** (open question 2): a GitHub *fine-grained* PAT is scoped to a single resource owner — one personal account or one organisation. A shared fine-grained token covers many repos only while they all sit under the same owner. Repos spanning two orgs would need either a classic PAT (broader again) or a per-connection override this ADR does not build. Treated as an API fact to confirm at implementation, per project convention, and as a question for Shyam because it may change what "shared" can mean in his actual setup.

### 3. Each repo receives a *projection*, and a routing rule is a hard wall *(resolved 2026-09-04)*

This is the substantial decision, because routing is per **token** and ADR-0006 §5's unit of commit is per **file**. The two reconcile in one direction only: repo A's copy of `theme/light.json` is a **subset** of the local file.

```
local tree ──router──> projection(A) ──stableStringify──> blob SHAs ──> compare against A's blobShas
                    └─> projection(B) ──…
```

Everything downstream is unchanged. A projection is an ordinary token tree, serialized by ADR-0002 §7's serializer, so its blob SHAs are computable without uploading anything and ADR-0006 §4's three-SHA table runs per repo verbatim.

Three mechanical consequences:

- **An empty projection writes no file.** A set whose tokens all route elsewhere does not appear in that repo as an empty JSON object.
- **`$manifest.json` is projected too.** Sets with an empty projection are dropped from `collections`, `tokenSetOrder` and every theme's `selectedTokenSets`. Otherwise Phase 8's export in that repo globs a file that is not there and fails a build for a reason no one can see.
- **`tokens/$rules.json` is pushed to every repo verbatim** (ADR-0002 Amendment 2 §F). It defines the paths, so every repo needs it to be readable on its own terms, and it is not token content to be filtered.

**And the one that needed deciding.** Token `Y` routes everywhere and references `X`, which a rule routes to android only. In the web repo, `Y`'s `{…X}` has no target — and Phase 8's export treats a dangling reference as fatal for the whole build.

This ADR proposed silently widening the projection to include `X` (transitive reference closure), making a routing rule a floor rather than a ceiling. **Shyam rejected that: a routing rule is a hard wall.** A rule that says "this goes to android only" means it, and the plugin does not quietly copy tokens into repos the user excluded them from — which would make the rules describe something other than what actually happens, and would be discovered only by noticing an unexpected token in a diff.

So the push is **blocked and named**:

> **`routing-dangling-reference`** — new report kind, reason `cross-repo`. Carries the referring token's path, the reference target, and the repo where it would dangle.

Four properties of the block, each chosen to keep it recoverable:

- **It is computed before any network call.** Reference-completeness is a property of a projection, and projections are built locally, so this is a pre-push validation surfaced in the Review & push screen — never a failure discovered after three repos have already committed.
- **It blocks the whole push to the affected repo, not one file.** Unlike a diverged file (ADR-0006 §6), there is no per-file choice to offer: the fix is a rule edit, which is global. Pushing nine of ten files while withholding the one holding the referrer produces a differently incomplete tree, not a better one.
- **Other repos still push.** A projection that is reference-complete is unaffected by one that is not — §4's per-repo independence, unchanged.
- **The same check runs in the routing-rule preview**, mirroring ADR-0002 Amendment 2 §G's preview for naming rules. The rule that would break a repo is named while it is being written, not at the next push.

**This interacts with `repos: []`** (§5): routing a token nowhere, when something references it, dangles that reference in every repo holding the referrer, and blocks each of them. That is the wall working as specified, and it is the most likely way a user meets it.

### 4. Push is per repo, sequential, and never all-or-nothing

**There is no cross-repo transaction, and simulating one would be worse than not having it.** GitHub offers no multi-repo atomicity; rolling back a repo that already succeeded means a force-push, which ADR-0006 §8's `force: false` rules out and which rewrites history other people have.

So a four-repo push is four independent runs of ADR-0006 §8's Git Data sequence, executed in order, each producing one commit in its own repo. The result is a **per-repo result list**, not a single outcome:

| Repo | Result |
|---|---|
| web | ✅ committed `a1b2c3d` — 4 files |
| android | ✅ committed `e4f5a6b` — 2 files |
| ios | ⛔ blocked — 2 references would dangle (§3) |
| docs | ❌ 401 — GitHub rejected the token |

**One repo failing does not stop the next.** Every connection is attempted, blocks from §3 and ADR-0002 Amendment 2 §F are resolved before the run rather than mid-flight, and failures are named per ADR-0006 §10's taxonomy. Retry is per repo and safe: blob-SHA comparison makes a re-push of an already-pushed repo a no-op, so "retry failed repos" needs no new state.

The commit message is authored **once** and used for every repo, with a per-repo body listing that repo's changed sets — a fan-out is one intent, and asking for four messages would get four copies of the same sentence. Editable before pushing, per ADR-0006 §8.

*Amends ADR-0006 §10's "No partial commit state".* That claim was about one repo and is still true of one repo — the Git Data sequence is still atomic per repo, and a failure before the final `PATCH` still moves nothing. Across repos, partial success is now a first-class outcome, and the UI must render it as such rather than as one green tick.

### 5. Routing rules: default-all, ordered, last match wins

```jsonc
{
  "id": "android-only",
  "enabled": true,
  "on": "path",                                    // "path" (default) | "source"
  "match": { "kind": "segment", "value": "abc" },  // ADR-0002 Amendment 2 §A
  "repos": ["c_android"]
}
```

- **Default is every enabled connection.** A token matched by no rule goes everywhere. Rules are exceptions, which is how Shyam described them and which makes the empty rule set behave exactly like ADR-0006.
- **Ordered, last matching rule wins**, its `repos` replacing the destination set outright. Same last-wins convention as ADR-0002 §1's set ordering. Composition — union, intersection — is a mini-language, and "two rules disagree" is not a question anyone should have to answer: the later one wins and the review screen shows which rule routed each token (`routedBy: ruleId`).
- **`on` chooses what the pattern matches**, and the choice is real. `"path"` matches the post-transform token path — what the user sees in the plugin and what lands in the repo. `"source"` matches the Figma variable's name before ADR-0002 Amendment 2's rules ran, which is the only way to route on a segment that a naming rule *strips* — plausibly the exact case, since a segment removed as output noise may be precisely the one carrying the destination. Rather than guess, the rule declares it; `"path"` is the default because it is the predictable one.
- **`repos: []` is legal and means the token is committed nowhere** *(resolved 2026-09-04, as recommended)*. It is the only way to keep a token local, it is shown as *not pushed anywhere* rather than as an error, and it is loud in the review screen rather than silent. If something references such a token, §3's wall blocks the repos holding the referrer — the token is kept local, but not at the cost of a broken tree elsewhere.

Routing rules live in `clientStorage` with the connection settings and are **not committed**. Naming rules commit because they change the *content* of the tree and a puller cannot reproduce it without them (ADR-0002 Amendment 2 §F); routing rules only change *where a copy goes*, and committing them would put a document naming every other repo into each of them.

### 6. Sync state, divergence and pull are per repo, and need no primary

Sync state is keyed per (file, connection) — §2's table — and holds the same record ADR-0006 §3 defined. Each repo has its own `baseCommitSha` and `blobShas`, and ADR-0006 §4's table runs against each independently.

**The mechanics never needed a primary**, which is worth stating plainly because the no-primary decision (§1) might read as though it left a hole here. Every question ADR-0006 §4 asks is of the form *"does repo R agree with the local tree, for file F?"*, answered by three SHAs that are all scoped to R. Ten repos are ten independent instances of that question. Nothing compares repos to each other, and nothing needs to.

One state is new, per (file, repo):

| local vs. base | remote vs. base | State |
|---|---|---|
| — | — | **Not routed** — this file's projection for this repo is empty |

Not-routed is not diverged and not out of sync; there is nothing to compare. The panel's single status chip is the **worst state across enabled connections**, and drilling in shows the per-repo breakdown — the chip has to stay one chip, and "in sync with 3 of 4" is not a state, it is a summary of four.

**Divergence stays exactly as ADR-0006 §6 decided it, at one more level of granularity: per (repo, file), whole file, pick a side.** A file diverged in repo C blocks that file in repo C and nothing else — not the same file in repo A, not the other files in repo C. That falls straight out of §6's "only the diverged file blocks" once the projection is the unit being compared. Rule-set mismatch is the exception that blocks a whole repo, for the reason ADR-0002 Amendment 2 §F gives.

**Pull is from one repo at a time, and the user picks which — with no default** *(follows from §1)*. Pulling from several at once and reconciling them is a multi-way merge of token JSON, which is the merge ADR-0006 §6 refused for two sides and refuses harder for four. With no primary there is no repo to preselect, so the choice is always explicit; that is a small cost and an honest one. A pull from repo A considers **only the paths that route to A**: absence of a token in A's tree is not evidence of a delete when the router never sent it there. Everything else about pull is unchanged — it materialises as overlay entries with `origin: "pulled"`, and Phase 5's apply flow does the writing.

### 6a. Drift has no repo baseline any more — recommendation, and the one thing going back to Shyam

ADR-0006 §7 swapped drift's baseline from Phase 5's import cache onto *"the last-pulled repo value"*, on the strength of §2's claim that the repo is the source of truth. §1 removes that claim's subject. With N co-equal repos, "the last-pulled repo value" has N answers — legitimately different ones, since routing means repos hold different subsets pushed at different times — so the swap no longer resolves.

**Recommendation: drift's baseline becomes the local tree — `build(scan, userSubtypes, pathRules) + overlay` — and no repo is involved in drift at all.**

Two axes, cleanly separated, which is the shape §1's model implies:

| Axis | Question | Baseline |
|---|---|---|
| **Drift** | Has Figma changed away from what the tokens say? | The local tree |
| **Divergence** | Does repo R agree with the tokens? | R's `blobShas`, per file (§6) |

This keeps ADR-0006 §7's *intent* — drift means "Figma disagrees with what the tokens are", not merely "Figma changed since I last looked" — while needing no repo to be authoritative, because pulled repo content reaches the local tree through the overlay anyway (ADR-0006 §5). And it removes a mode change nobody would track: under ADR-0006 as written, connecting a repo silently altered what the drift list meant.

**Why this goes back to Shyam rather than being settled here.** It is a change to a landed, Accepted ADR whose behaviour shipped in Phase 6 and is user-visible, and it is not editorial:

- ADR-0006 §7 explicitly framed the repo baseline as *"PRD §6.5.3's actual sense"* of drift. Retiring it needs to be an intentional read of the PRD, not a side effect of removing the primary.
- The recommended baseline is *not* exactly equivalent to ADR-0006 §7's in the single-repo case. A pulled-then-applied token retires its overlay entry, and whether the local tree and the import cache agree at that moment depends on Phase 5's post-apply rescan behaviour — which `docs/ux/apply-and-drift.md` had amended once already during Phase 9. That equivalence should be checked against the code, not asserted in an ADR.
- `docs/ux/apply-and-drift.md` §6.4's copy was rewritten in Phase 6 *because* of §7's swap. If the swap is retired, that copy needs another pass from `@ux-designer`.

Code impact is small either way — `src/tokens/drift.ts` already takes its baseline as an argument (ADR-0006 §7) — so this is a semantics decision, not an implementation cost.

### 7. The Review & push screen groups by repo first

Presentation is `@ux-designer`'s, per this project's split. What this ADR fixes is the hierarchy and what it must show, because both follow from the commit model rather than from taste:

- **Repo → file → token.** The repo is the top level because the repo is now the unit of the commit (§4). A token routed to three repos appears three times, which is truthful — it is three commits.
- A pre-push summary: how many repos, files and tokens, and how many repos are **blocked** — by a diverged file (ADR-0006 §6), a rule-set mismatch (ADR-0002 Amendment 2 §F), or a cross-repo dangling reference (§3).
- §3's blocks named per repo with the referring token, the missing target, and the rule that routed it away — a block whose cause is not on screen is a block the user cannot clear.
- Tokens routed nowhere (§5) shown as *not pushed anywhere*, not as errors.
- The per-repo result list (§4) after the push, in place, with retry per failed repo.

### 8. Deliberately deferred or decided against

- **Silent reference closure across repos** — decided against by Shyam (§3). Routing rules are a hard wall; a dangling cross-repo reference blocks the affected repo.
- **Cross-repo atomicity** — decided against (§4). No mechanism exists that does not involve force-pushing shared history.
- **Multi-repo pull, or reconciling two repos against each other** — decided against (§6). It is the merge ADR-0006 §6 refused.
- **A primary or otherwise privileged repo** — decided against by Shyam (§1). Not deferred: the model is that no repo is authoritative, and a future phase wanting one would be re-opening this.
- **A per-connection PAT override** — not built (§2). It becomes necessary only if connections span GitHub resource owners; open question 2.
- **Routing on anything other than a name pattern** — by `$type`, by set, by subtype, by theme. Not asked for; the rule shape can grow a match kind later without touching anything else.
- **Per-repo naming rules** — one file, one rule set, one set of paths. Per-repo path shapes would mean the same token has different identities in different repos, which breaks §3's projection model and pull matching at once.
- **Non-GitHub providers** — PRD §4, unchanged.
- **PR flow, branch creation, cross-repo history** — ADR-0006 §9, unchanged and now N times more tempting. Still no.

## Consequences

- ADR-0006's design survives multiplication almost intact: the module boundary, the SHA comparison, the commit sequence and the failure taxonomy all run per repo unmodified. The genuinely new code is the router, the projection (including manifest projection and reference validation), and per-repo result handling.
- **Storage cost is ~3KB of settings plus ~1KB per repo per file.** ADR-0004 §1's quota story is unchanged, and the shared PAT (§2) makes it smaller than the per-repo model would have.
- **Rate limit is unchanged in kind and linear in repos.** A status refresh at the cap is 10 calls; a 10-repo push is ~10 × (4 + changed files). Three orders of magnitude inside 5,000/hr. One shared PAT means one shared quota — which is the same 5,000/hr, since GitHub's authenticated limit is per user rather than per token.
- **One leaked secret now exposes every connected repo** (§2). Deliberate, and the reason ADR-0006 §1's three handling rules stay non-negotiable.
- Push stops having a single outcome. Anything that renders "pushed ✅" has to render a list instead, and any code that treats a push as one promise needs to treat it as N.
- **Routing rules can block a push, and that is the design working.** A user who routes a referenced token narrowly will meet §3's wall, and the fix is always a rule edit. The preview is what keeps this from being discovered at push time.
- **No repo is authoritative, so every repo has to be pulled from deliberately** (§6). A user with four repos has four separate "is this one current?" answers to hold, which is a real cognitive cost of the model Shyam chose — mitigated by the status chip aggregating to the worst case, not by pretending there is one answer.
- ADR-0006 §7's drift baseline is left undefined by the no-primary decision, and §6a's recommendation needs Shyam's sign-off before drift work starts. Nothing else in Phase 10 blocks on it.
- `@ux-designer` gains three surfaces: the connections list in settings, the routing-rules editor with its blocking preview, and the repo-grouped Review & push screen with per-repo results and per-repo blocks. Together with ADR-0002 Amendment 2's rules editor and preview, Phase 10 is a larger UX phase than its "polish" title suggests.

## Zero-recurring-cost check (PRD §8)

| Component | Choice | Cost |
|---|---|---|
| Transport | GitHub REST, from the iframe, N times | Free — 5,000 req/hr, unchanged |
| Storage | N GitHub repos | Free |
| Auth | One shared PAT in `clientStorage` | Free |
| Routing and validation | Local, pure, in the plugin | Free — no service |
| Fan-out orchestration | Sequential in the plugin | Free — no queue, no worker |

Nothing here has a cost floor above $0. Worth noting what *would*: a fan-out orchestrated by a hosted service, or a webhook-driven mirror between repos. Both are the obvious "real" way to do multi-repo distribution and both are components with an owner and a free tier that can change — the same objection ADR-0006 §12 raised against the OAuth relay. Sequential fan-out from the client is free, slower, and has no uptime story to maintain.

## Alternatives considered

- **Extend ADR-0006 by amendment instead of a new ADR.** Rejected. This changes the storage key scheme, the meaning of a push outcome, the source-of-truth model and the unit of what is committed. An amendment that large is a rewrite wearing an amendment's clothes; ADR-0006 stays readable as the single-repo design, with the sections it changes marked here.
- **Transitive reference closure — widen a projection to include tokens it references.** Rejected by Shyam (§3), over this ADR's own recommendation. It produces a correct tree in every repo, which is why it was recommended; but it makes routing rules describe something other than what happens, and the widening is invisible unless the user reads a diff closely. A named, pre-push block is louder and keeps the rules literally true.
- **Route per file rather than per token.** Rejected. Simpler — no projection, no manifest filtering, no cross-repo reference check — but it cannot express what was asked. Shyam's rules match token names, which cut across set files.
- **All-or-nothing push across repos.** Rejected (§4). It requires undoing commits on repos that succeeded, which means force-pushing shared history.
- **A PAT per connection.** Rejected by Shyam (§2), over this ADR's own recommendation. Smaller blast radius, but it makes adding a repo a trip through GitHub's token UI, and a feature that is expensive to extend is a feature that does not get extended.
- **Naming a primary repo, fixed or changeable.** Rejected by Shyam (§1), who rejected the premise rather than the options: Figma and the local tree are where tokens are authored, and no connected repo has earned the title. The mechanics turned out not to need one (§6); only the drift baseline did (§6a).
- **Commit the routing rules alongside the naming rules.** Rejected (§5). They do not affect a tree's content, and each repo would carry a document naming every other repo it fans out to.
- **First-match-wins for routing rules.** Rejected (§5). Last-wins matches ADR-0002 §1's existing set-ordering convention, and with an explicit `repos` replacement there is no case where the earlier rule's answer is the one wanted.
- **Union or intersection semantics when several rules match.** Rejected (§5). It is a mini-language, and ordered replacement answers the same questions with one rule of precedence instead of an algebra.
- **Forbid `repos: []`.** Rejected (§5). It is the only way to hold a token back from every repo, and §3's wall already prevents it from breaking anything silently.
- **Cap at 3–5 repos.** Rejected explicitly by Shyam during scoping; 10 confirmed.

## Open questions (not decided here)

All eight questions from the Proposed draft were resolved by Shyam on 2026-09-04 and are folded into the sections above: **refuse, don't widen** (§3), **shared PAT** (§2), **cap 10** (§1), **rule-set mismatch blocks** (ADR-0002 Amendment 2 §F), **exclusion in the rule engine** (ADR-0002 Amendment 2 §I), **all transform actions** (Amendment 2 §B), **no primary** (§1), and **zero-repo routing allowed** (§5).

**Two go back to him. Neither blocks starting on §1–§5, §7.**

1. **The drift baseline, left undefined by the no-primary decision — §6a.** Recommendation: drift measures Figma against the local tree, and no repo participates. This is a semantics change to a landed ADR (ADR-0006 §7), it touches copy `@ux-designer` wrote in Phase 6 (`docs/ux/apply-and-drift.md` §6.4), and its equivalence to current behaviour in the single-repo case depends on a post-apply rescan detail that should be checked in code rather than asserted. **This is the item flagged as not purely editorial**; the rest of the §1 reconciliation is.
2. **Shared PAT versus GitHub's fine-grained token scoping — §2.** A fine-grained PAT is scoped to one resource owner, so one shared fine-grained token covers many repos only while they share an owner. If Shyam's repos span two orgs, the shared model needs either a classic PAT (broader still) or a per-connection override this ADR deliberately does not build. Worth an answer before settings UI copy is written, since it changes what the plugin should tell the user to create.

**API facts to verify during implementation, not decisions**: the fine-grained-PAT resource-owner constraint above; whether ADR-0006's outstanding ETag/rate-limit-header question behaves the same across N connections; and that `x-ratelimit-remaining` is per user rather than per token, which is what makes one shared PAT cost no more budget than ten separate ones.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §1 set ordering and last-wins, §7 determinism and `stableStringify`; **Amendment 2** §A the shared matcher, §B the four actions, §F `$rules.json` committed and mismatch blocking, §G the rule preview, §I exclusion — a prerequisite for this ADR
- ADR-0004 (`docs/adr/0004-local-edit-persistence.md`) — §1 the 5MB `clientStorage` budget and `resolveStorageKey`, §2 the overlay entry shape, §6 quota policy
- ADR-0005 (`docs/adr/0005-figma-apply-and-drift.md`) — §1 the `ApplyPlan` seam pull rides, §7–§8 drift baselines and the post-apply behaviour §6a depends on
- ADR-0006 (`docs/adr/0006-git-sync.md`) — §1 the PAT handling rules and the per-repo scoping §2 here reverses, §2 the source-of-truth model §1 here generalises, §3 the storage keys §2 here re-keys, §4 the SHA table §6 here extends, §5 push/pull semantics, §6 divergence, §7 the drift baseline §6a here leaves undefined, §8 the Git Data sequence §4 here runs per repo, §10 the failure taxonomy and the partial-commit claim §4 here amends, §11 `pull-unmatched`
- PRD §4 (non-goals), §6.4 (git sync), §6.5.3 (drift), §6.6 (export), §6.7 (settings), §8 (cost), §9 Phase 10: `docs/prd.md`
- `docs/ux/git-sync.md` — the Repo tab, status chip and Review & push screen this generalises
- `docs/ux/apply-and-drift.md` — §6.4, whose copy §6a would send back for another pass
- Implementation: `src/git/state.ts`, `src/git/api.ts`, `src/git/diff.ts`, `src/git/commit.ts`, `src/git/pull.ts`, `src/tokens/build.ts`, `src/tokens/serialize.ts`, `src/tokens/references.ts`, `src/tokens/graph.ts`, `src/tokens/drift.ts`
- GitHub REST — Git Data API, fine-grained PAT resource-owner scoping, 5,000 req/hr per-user authenticated limit
