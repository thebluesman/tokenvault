# ADR-0008 — Multi-repo push routing

**Status**: Proposed
**Date**: 2026-09-04
**Owner**: @tech-lead

## Context

ADR-0006 connects a Figma file to exactly one GitHub repo, on one branch, with one PAT. Phase 10 (PRD §9 item 10) asks for any number of configured repos — Shyam was explicit that three is too low a cap — where **every token pushes to every repo by default**, and ordered exception rules route matching tokens to a subset instead (*"anything matching `abc` only goes to the android repo"*). The match pattern has no required relationship to the destination repo's name.

This extends ADR-0006 rather than contradicting it. Everything ADR-0006 decided about *one* repo — the module boundary (§1), SHA-based change detection (§3, §4), the Git Data commit sequence (§8), refusing a diverged file (§6), manual push and pull (§5), the failure taxonomy (§10) — is unchanged and runs per repo. What needs deciding is what becomes a list, what stays singular, and what a partial failure means. Three sentences in ADR-0006 stop being true as written and are amended by §2, §4 and §6 below.

Rule matching reuses ADR-0002 Amendment 2 §A's matcher. That amendment is a prerequisite for this ADR and is also still Proposed.

Scope: GitHub only (PRD §4), PAT only (PRD §6.4), push fan-out and per-repo pull. No cross-repo merge, no organisation-level credential, no provider abstraction.

## Decision

### 1. N connections, one of them primary

A **connection** is what ADR-0006 §3 already stored, given an id and multiplied:

```jsonc
{ "id": "c_android", "owner": "…", "repo": "…", "branch": "main",
  "tokensDir": "tokens", "patLastFour": "9f2a", "enabled": true, "primary": false }
```

Branch and `tokensDir` are per connection, not global — repos genuinely differ on both, and ADR-0006 §9's correction (`cb086ee`) already made both part of what invalidates a sync base.

**Exactly one connection is `primary`, and it is what ADR-0006 §2 means by "the repo is the source of truth".** That sentence has no plural form: with N repos and no primary, "does the repo agree?" has N answers and the overlay's demotion to uncommitted work becomes undefined. The primary is the default pull source and the authority; the others are push targets. Pulling from a non-primary is allowed and explicit (§6), never automatic.

**Proposed cap: 10 enabled connections.** Not a technical limit — the constraint is that a status refresh costs one tree read per repo (§4), and the Review & push screen has to stay legible with a diff per repo. Ten keeps a refresh at ten calls against a 5,000/hr budget and a review screen at ten top-level groups. Raising it costs nothing structural; the number is Shyam's (open question 2).

### 2. One PAT per connection, not one shared

ADR-0006 §1 specifies a **fine-grained PAT scoped to a single repo**, and gives the reason: the blast radius of a leak is one repository rather than an account. A fine-grained PAT covering four repos is a strictly larger blast radius, and a classic PAT covering them is larger still.

So the credential is per connection, stored under its own key so it can be revoked or replaced without disturbing anything else:

| Key | Scope | Size |
|---|---|---|
| `tokenvault:github` | `{ connections: [...], routingRules: [...] }` — no PATs | ~2 KB at 10 repos |
| `tokenvault:github-pat:<connection-id>` | one PAT | < 1 KB each |
| `tokenvault:sync:<file-id>:<connection-id>` | ADR-0006 §3's record, per repo | ~1 KB per repo per file |

Against ADR-0004 §1's 5MB, shared with a ~700KB import cache and the overlay: **~12KB of settings and ~10KB of sync state per synced Figma file at the cap.** The quota story is unchanged, and it is unchanged for the same reason it was in ADR-0006 — no tree is persisted, only SHAs.

ADR-0006 §1's three PAT rules (never rendered, never logged, held in a closure for one operation) apply per connection with no change. A fan-out push holds N tokens in iframe memory for the duration of one operation; each is scrubbed from error payloads by the same redacting helper.

The cost is real and it is friction, not risk: connecting four repos means creating four fine-grained PATs in GitHub's UI. Whether that friction is acceptable is open question 3.

### 3. Each repo receives a *projection* of the tree, and the projection is reference-complete

This is the substantial decision, because routing is per **token** and ADR-0006 §5's unit of commit is per **file**. The two reconcile in one direction only: repo A's copy of `theme/light.json` is a **subset** of the local file.

```
local tree ──router──> projection(A) ──stableStringify──> blob SHAs ──> compare against A's blobShas
                    └─> projection(B) ──…
```

Everything downstream is unchanged. A projection is an ordinary token tree, serialized by ADR-0002 §7's serializer, so its blob SHAs are computable without uploading anything and ADR-0006 §4's three-SHA table runs per repo verbatim.

Four consequences that must be stated rather than discovered:

- **An empty projection writes no file.** A set whose tokens all route elsewhere does not appear in that repo as an empty JSON object.
- **`$manifest.json` is projected too.** Sets with an empty projection are dropped from `collections`, `tokenSetOrder` and every theme's `selectedTokenSets`. Otherwise Phase 8's export in that repo globs a file that is not there and fails a build for a reason no one can see.
- **`tokens/$rules.json` is pushed to every repo verbatim** (ADR-0002 Amendment 2 §F). It defines the paths, so every repo needs it to be readable on its own terms, and it is not token content to be filtered.
- **A projection drags its references' targets in with it.** Token `Y` routes everywhere and references `X`, which a rule routes to android only. In the web repo `Y`'s `{…X}` would dangle — and Phase 8's export treats a dangling reference as fatal for the whole build. So the router computes the **transitive reference closure** of each repo's routed set, using the graph that already exists (`src/tokens/references.ts`, `src/tokens/graph.ts`), and a projection is always reference-complete.

  Closure means a routing rule is a floor, not a ceiling: a token routed "android only" still appears in the web repo if something web-routed needs it. That is correct — the alternative is a repo full of broken references — but it must be **visible**, so closure-included tokens are labelled as such in the review screen and recorded as a new report kind `routing-closure` carrying the path, the repo, and the referrer that pulled it in.

  The alternative, refusing the push and making the user fix the rule, is not obviously wrong and is open question 1. Closure is recommended because it produces a *correct* tree — a superset, never a wrong value — which puts it outside the silently-wrong class ADR-0006 §6 refuses. A refusal here blocks work on a graph the user may not be able to untangle.

### 4. Push is per repo, sequential, and never all-or-nothing

**There is no cross-repo transaction, and simulating one would be worse than not having it.** GitHub offers no multi-repo atomicity; rolling back a repo that already succeeded means a force-push, which ADR-0006 §8's `force: false` rules out and which rewrites history other people have.

So a four-repo push is four independent runs of ADR-0006 §8's Git Data sequence, executed in order, each producing one commit in its own repo. The result is a **per-repo result list**, not a single outcome:

| Repo | Result |
|---|---|
| web | ✅ committed `a1b2c3d` — 4 files |
| android | ✅ committed `e4f5a6b` — 2 files |
| ios | ❌ 401 — GitHub rejected the token |
| docs | ✅ nothing to push |

**Repo 3 failing does not stop repo 4.** Every connection is attempted, and failures are named per ADR-0006 §10's taxonomy. Retry is per repo and safe: blob-SHA comparison makes a re-push of an already-pushed repo a no-op, so "retry failed repos" needs no new state.

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
- **`repos: []` is legal and means the token is committed nowhere.** It is the only way to keep a token local, and it is loud in the review screen rather than silent.

Routing rules live in `clientStorage` with the connection settings and are **not committed**. Naming rules commit because they change the *content* of the tree and a puller cannot reproduce it without them (ADR-0002 Amendment 2 §F); routing rules only change *where a copy goes*, and committing them would put a document naming every other repo into each of them.

### 6. Sync state, divergence and pull all generalise per repo

Sync state is keyed per (file, connection) — §2's table — and holds the same record ADR-0006 §3 defined. Each repo has its own `baseCommitSha` and `blobShas`, and ADR-0006 §4's table runs against each independently.

One state is new, and it is per (file, repo):

| local vs. base | remote vs. base | State |
|---|---|---|
| — | — | **Not routed** — this file's projection for this repo is empty |

Not-routed is not diverged and not out of sync; there is nothing to compare. The panel's single status chip is the **worst state across enabled connections**, and drilling in shows the per-repo breakdown — the chip has to stay one chip, and "in sync with 3 of 4" is not a state, it is a summary of four.

**Divergence stays exactly as ADR-0006 §6 decided it, at one more level of granularity: per (repo, file), whole file, pick a side.** A file diverged in repo C blocks that file in repo C and nothing else — not the same file in repo A, not the other files in repo C. That falls straight out of §6's "only the diverged file blocks" once the projection is the unit being compared.

**Pull is from one repo at a time, and the user picks which** (default: the primary). Pulling from several at once and reconciling them is a multi-way merge of token JSON, which is the merge ADR-0006 §6 refused for two sides, and refuses more strongly for four. A pull from repo A considers **only the paths that route to A**: absence of a token in A's tree is not evidence of a delete when the router never sent it there. Everything else about pull is unchanged — it materialises as overlay entries with `origin: "pulled"`, and Phase 5's apply flow does the writing.

ADR-0006 §7's drift baseline becomes the **primary** connection's last-pulled values. An unconnected file still keeps Phase 5's import-cache baseline.

*Amends ADR-0006 §3*: `tokenvault:sync:<file-id>` becomes `tokenvault:sync:<file-id>:<connection-id>`. An existing single-repo record migrates by being read under the old key once and rewritten under the new one with a generated connection id marked `primary`.

### 7. The Review & push screen groups by repo first

Presentation is `@ux-designer`'s, per this project's split. What this ADR fixes is the hierarchy and what it must show, because both follow from the commit model rather than from taste:

- **Repo → file → token.** The repo is the top level because the repo is now the unit of the commit (§4). A token routed to three repos appears three times, which is truthful — it is three commits.
- A pre-push summary: how many repos, files and tokens, and how many repos have a diverged file blocking part of their push.
- Closure-included tokens (§3) labelled as such, with the referrer that pulled them in.
- The per-repo result list (§4) after the push, in place, with retry per failed repo.

### 8. Deliberately deferred or decided against

- **Cross-repo atomicity** — decided against (§4). No mechanism exists that does not involve force-pushing shared history.
- **Multi-repo pull, or reconciling two repos against each other** — decided against (§6). It is the merge ADR-0006 §6 refused.
- **Routing on anything other than a name pattern** — by `$type`, by set, by subtype, by theme. Not asked for; the rule shape can grow a match kind later without touching anything else.
- **A shared or organisation-level credential** — decided against (§2), on ADR-0006 §1's blast-radius reasoning.
- **Per-repo naming rules** — one file, one rule set, one set of paths. Per-repo path shapes would mean the same token has different identities in different repos, which breaks §3's projection model and pull matching at once.
- **Non-GitHub providers** — PRD §4, unchanged.
- **PR flow, branch creation, cross-repo history** — ADR-0006 §9, unchanged and now N times more tempting. Still no.

## Consequences

- ADR-0006's design survives multiplication almost intact: the module boundary, the SHA comparison, the commit sequence and the failure taxonomy all run per repo unmodified. The genuinely new code is the router, the projection (including manifest projection and reference closure), and per-repo result handling.
- **Storage cost is ~12KB of settings plus ~1KB per repo per file.** ADR-0004 §1's quota story is unchanged.
- **Rate limit is unchanged in kind and linear in repos.** A status refresh at the cap is 10 calls; a 10-repo push is ~10 × (4 + changed files). Three orders of magnitude inside 5,000/hr.
- Push stops having a single outcome. Anything that renders "pushed ✅" has to render a list instead, and any code that treats a push as one promise needs to treat it as N.
- A token can now legitimately exist in a repo that no rule routed it to (§3's closure). Without the labelling and the `routing-closure` report entry, that would be the phase's most confusing behaviour.
- ADR-0006 §2's single-authority sentence survives only because §1 names a primary. If a future phase wants two co-equal authorities, that is a merge design and a new ADR.
- The friction of N fine-grained PATs is the price of ADR-0006 §1's blast-radius argument, paid N times. It is the most likely thing about this design to be disliked in practice.
- `@ux-designer` gains three surfaces: the connections list in settings, the routing-rules editor, and the repo-grouped Review & push screen with per-repo results. Together with ADR-0002 Amendment 2's rules editor and preview, Phase 10 is a larger UX phase than its "polish" title suggests.

## Zero-recurring-cost check (PRD §8)

| Component | Choice | Cost |
|---|---|---|
| Transport | GitHub REST, from the iframe, N times | Free — 5,000 req/hr, unchanged |
| Storage | N GitHub repos | Free |
| Auth | N fine-grained PATs in `clientStorage` | Free |
| Routing | Local, pure, in the plugin | Free — no service |
| Fan-out orchestration | Sequential in the plugin | Free — no queue, no worker |

Nothing here has a cost floor above $0. Worth noting what *would*: a fan-out orchestrated by a hosted service, or a webhook-driven mirror between repos. Both are the obvious "real" way to do multi-repo distribution and both are components with an owner and a free tier that can change — the same objection ADR-0006 §12 raised against the OAuth relay. Sequential fan-out from the client is free, slower, and has no uptime story to maintain.

## Alternatives considered

- **Extend ADR-0006 by amendment instead of a new ADR.** Rejected. This changes the storage key scheme, the meaning of a push outcome, the source-of-truth sentence and the unit of what is committed. An amendment that large is a rewrite wearing an amendment's clothes; ADR-0006 stays readable as the single-repo design, with three sections marked as amended here.
- **Route per file rather than per token.** Rejected. Simpler — no projection, no closure, no manifest filtering — but it cannot express what was asked. Shyam's rule matches token names, which cut across set files.
- **All-or-nothing push across repos.** Rejected (§4). It requires undoing commits on repos that succeeded, which means force-pushing shared history.
- **A shared PAT across all repos.** Rejected (§2). It regresses ADR-0006 §1's blast-radius argument, which was the reason fine-grained was specified in the first place.
- **Report dangling cross-repo references instead of computing closure.** Rejected (§3), with the refusal variant left open as question 1. Every repo whose export then fails is a build broken by a routing rule, discovered in CI rather than in the plugin.
- **Commit the routing rules alongside the naming rules.** Rejected (§5). They do not affect a tree's content, and each repo would carry a document naming every other repo it fans out to.
- **First-match-wins for routing rules.** Rejected (§5). Last-wins matches ADR-0002 §1's existing set-ordering convention, and with an explicit `repos` replacement there is no case where the earlier rule's answer is the one wanted.
- **Union or intersection semantics when several rules match.** Rejected (§5). It is a mini-language, and ordered replacement answers the same questions with one rule of precedence instead of an algebra.
- **No primary connection — every repo co-equal.** Rejected (§1). ADR-0006 §2's "the repo is the source of truth" has no plural form, and without a primary, pull, drift and the overlay's status all become undefined rather than merely ambiguous.
- **Cap at 3–5 repos.** Rejected explicitly by Shyam during scoping.

## Open questions (not decided here)

1. **Cross-repo references: closure-widen, or refuse?** §3 recommends widening — a token routed elsewhere still lands in a repo that references it, labelled and reported, so no repo ever holds a broken reference. The alternative is refusing the push and making the user fix the routing rule, which keeps routing rules literally true at the cost of blocking on a graph problem. **This changes what a routing rule means**, so it is Shyam's, not this ADR's.
2. **The repo cap.** §1 proposes 10, on legibility and per-refresh call cost rather than any hard limit. Shyam said 3 is too low; the actual number is his.
3. **N fine-grained PATs, or one broader PAT?** §2 recommends per-repo, following ADR-0006 §1. The cost is creating and rotating one PAT per repo in GitHub's UI. If that friction is unacceptable in practice, the alternative is a single PAT with access to all the repos — a larger blast radius, stated openly rather than traded away quietly.
4. **Which connection is primary, and can it change?** §1 requires one. Whether changing it is a normal settings action (invalidating the drift baseline, cheap) or something rarer is a product call.
5. **Should a token with `repos: []` be allowed at all?** §5 permits it as the only way to keep a token out of every repo. It is also a way to lose work silently if a rule matches more than intended — the review screen showing it is the mitigation, and whether that is enough is Shyam's.

**API facts to verify during implementation, not decisions**: whether ADR-0006's outstanding ETag/rate-limit-header question behaves the same across N concurrent-ish connections, and whether `x-ratelimit-remaining` is shared across PATs for the same user account (it is per user, not per token, which would make the fan-out's budget shared — assumed, not verified).

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §1 set ordering and last-wins, §7 determinism and `stableStringify`; **Amendment 2** §A the shared matcher, §F `$rules.json` committed — a prerequisite for this ADR
- ADR-0004 (`docs/adr/0004-local-edit-persistence.md`) — §1 the 5MB `clientStorage` budget and `resolveStorageKey`, §6 quota policy
- ADR-0005 (`docs/adr/0005-figma-apply-and-drift.md`) — §1 the `ApplyPlan` seam pull rides, §7–§8 drift baselines
- ADR-0006 (`docs/adr/0006-git-sync.md`) — §1 module boundary and the three PAT rules, §2 the source-of-truth sentence §1 here qualifies, §3 the storage keys §2 here re-keys, §4 the SHA table §6 here extends, §5 push/pull semantics, §6 divergence, §7 drift, §8 the Git Data sequence §4 here runs per repo, §10 the failure taxonomy and the partial-commit claim §4 here amends, §11 `pull-unmatched`
- PRD §4 (non-goals), §6.4 (git sync), §6.6 (export), §6.7 (settings), §8 (cost), §9 Phase 10: `docs/prd.md`
- `docs/ux/git-sync.md` — the Repo tab, status chip and Review & push screen this generalises
- Implementation: `src/git/state.ts`, `src/git/api.ts`, `src/git/diff.ts`, `src/git/commit.ts`, `src/git/pull.ts`, `src/tokens/build.ts`, `src/tokens/serialize.ts`, `src/tokens/references.ts`, `src/tokens/graph.ts`
- GitHub REST — Git Data API, fine-grained PAT repository scoping, 5,000 req/hr per-user authenticated limit
