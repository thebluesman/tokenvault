# ADR-0006 — Git sync over the GitHub REST API (PAT)

**Status**: Proposed
**Date**: 2026-09-02
**Owner**: @tech-lead

## Context

Phase 6 (PRD §9 item 6, detailed in §6.4 and §7) gives the token tree a home outside Figma: push and pull `tokens/**` against a GitHub repo, a diff before committing, a branch to sync against, and a settings panel (§6.7) for repo, branch and PAT.

Five facts from what exists constrain the design.

- **The build already emits repo-shaped files.** `build.ts` produces `TokenFileOutput[]` with repo-relative paths (`tokens/theme/light.json`, `tokens/$manifest.json`, `tokens/$import-report.json`) and `stableStringify` gives them a byte-identical form (ADR-0002 §7). Push does not need a serializer; it needs a transport. That determinism is also the only reason "nothing to push" is a computable state rather than a guess.
- **`clientStorage` is 5MB per plugin, per user, per device** (ADR-0004 §1), already holding the edit overlay and the ~700KB import cache. ADR-0004 flagged the PAT and any sync state as a Phase 6 charge against the same budget. §3 spends a few KB, not another tree.
- **The overlay is already a diff against Figma with a recorded `base`** (ADR-0004 §2). That is the shape a pull produces too, which is why §5 adds no store.
- **Apply already runs off a general `ApplyPlan`** (ADR-0005 §1), built with a second plan producer explicitly in mind: *"Phase 6 will produce a plan by diffing a pulled git tree against the current scan."* Phase 6 is the phase that cashes that in.
- **`manifest.json` already declares `networkAccess.allowedDomains: ["https://api.github.com"]`.** The transport target is fixed by the scaffold; anything else is a manifest change and a new decision.

Scope, per the phase brief: one GitHub repo, one branch at a time, PAT auth, no OAuth relay, no themes or math (Phase 7), no export pipeline (Phase 8).

## Decision

### 1. `fetch` lives in the UI iframe; the sandbox owns storage and orchestration

The Figma plugin sandbox has no network stack. The iframe does. `clientStorage` is the mirror image — sandbox only. So the two halves of "read the PAT and call GitHub" sit on opposite sides of the `postMessage` boundary, and there is no arrangement that avoids that.

```
src/git/api.ts        NEW — impure, runs in the UI iframe. The ONLY module that calls fetch.
src/git/blob.ts       NEW — pure. Git blob SHA-1 over serialized file content (§4).
src/git/diff.ts       NEW — pure. Local tree vs. remote tree → SyncPlan.
src/git/commit.ts     NEW — pure. SyncPlan → the ordered Git Data API call sequence.
src/git/state.ts      NEW — sync state + settings, in the sandbox, over clientStorage.
src/tokens/plan.ts    reused — the ApplyPlan producer gains a pulled-tree input (ADR-0005 §1).
```

Same one-impure-edge boundary as ADR-0002 §Module layout, ADR-0003 §7 and ADR-0005 §3. Everything that decides anything is pure and testable without a network or a Figma runtime.

**The PAT crosses the message channel, and this ADR says so rather than implying otherwise.** The sandbox reads it from `clientStorage` and hands it to the iframe for the duration of a sync operation. Both halves are the same plugin in the same Figma process, so this is not a trust boundary being crossed — but it does mean the token is in iframe memory, and three rules follow, all enforced in code rather than by care:

- The PAT is **never rendered**, never placed in the DOM, and never round-tripped through a `value` attribute. The settings field is write-only: it shows `••••••••` plus the last four characters, and editing means replacing.
- The PAT is **never logged and never included in an error payload.** `api.ts` scrubs `Authorization` from anything it reports, and error surfacing goes through one redacting helper.
- The iframe holds it in a closure for one operation and drops it. No module-level cache, no `window` property, no `localStorage`.

**Fine-grained PAT, single repo, Contents: read and write.** That is the whole scope needed, it is what the settings copy should tell the user to create, and it is what makes the blast radius of a leaked token one repository rather than an account.

### 2. The repo is the source of truth; the plugin holds a working copy

The one sentence the rest of this ADR hangs off. Once a file is connected to a repo, `tokens/**` on the configured branch is what the tokens *are*; Figma is a rendering of them that can be edited out of band, and the overlay is uncommitted work.

That demotion is the one ADR-0004 already anticipated in its open questions (*"the committed `tokens/` tree becomes the authority and the overlay arguably becomes a working copy of uncommitted changes"*). It is confirmed here, and it is what makes §7's drift definition honest.

**There is no fourth state.** The three that exist are:

| State | Where it lives | Authority |
|---|---|---|
| **Repo** | GitHub, at `branch` | The source of truth, when connected |
| **Figma** | the live file, via a scan | What the canvas currently shows |
| **Overlay** | `clientStorage`, ADR-0004 | Uncommitted local intent |

The "local tree" the panel displays is still `build(scan) + overlay`, unchanged from Phase 4. Git sync does not introduce a new tree to render; it introduces a fourth question about the same one — *does the repo agree?*

### 3. Sync state is SHAs, not content — which is what keeps it inside the quota

Persisting a pulled tree would put a second ~700KB blob into a 5MB store that already holds one. It is also unnecessary, because git is content-addressed and the plugin can compute the same addresses.

One new key, unrelated to any file, holding the connection:

| Key | Contents | Size |
|---|---|---|
| `tokenvault:github` | `{ owner, repo, branch, tokensDir, patLastFour }` — the settings panel's contents, minus the PAT | < 1 KB |
| `tokenvault:github-pat` | the PAT, alone, so it can be cleared without disturbing settings | < 1 KB |
| `tokenvault:sync:<file-id>` | `{ owner, repo, branch, baseCommitSha, blobShas: Record<path, sha>, at }` | ~1 KB at 12 files |

`tokenvault:github` and the PAT are **not** file-scoped: a credential and a repo are the user's, not the Figma file's. Sync state **is** file-scoped, on ADR-0004 §1's existing `resolveStorageKey()` scheme, because two Figma files can legitimately sync to two repos.

`blobShas` is the merge base. It records, per path, the git blob SHA of the content at the last successful sync — which is exactly "what both sides agreed on last time", in 40 bytes per file instead of 60KB.

**The pulled tree itself is never persisted.** It is fetched, used to produce a diff or an apply plan, and dropped. If the user closes the panel mid-review, the answer is to pull again — one cheap API call, and a fresher answer than a stale cache would have given.

### 4. Change detection is a blob-SHA comparison, and costs one API call

A git blob SHA is `sha1("blob " + byteLength + "\0" + content)`. `stableStringify` gives a byte-identical serialization for a given tree (ADR-0002 §7), so the plugin can compute the SHA GitHub *would* assign to any file it is about to write, without uploading anything.

That makes the whole sync status question cheap:

```
GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1   →  path → blob SHA, for the whole repo, one call
```

Three SHAs per path, and every state falls out of comparing them:

| local vs. base | remote vs. base | State |
|---|---|---|
| same | same | **In sync** |
| differs | same | **Local changes** — push is a fast-forward |
| same | differs | **Remote changes** — pull is a fast-forward |
| differs | differs | **Diverged** — §6 |

No content is downloaded to answer *whether* something changed. Content is fetched only for the files that actually differ, and only when the user opens the diff. On a 12-file tree, "are we in sync?" is one request and no measurable transfer, which is what makes it affordable to answer on demand at every panel open.

This is also PRD §6.7's sync status indicator, computed rather than remembered.

### 5. Push commits the whole tree; pull materializes as overlay entries

The two directions are deliberately asymmetric, because the two artifacts are.

**Push.** The unit of a commit is a *file*, because that is the unit git has. Push serializes `build(scan) + overlay` through `stableStringify`, compares each file's blob SHA against `blobShas`, and commits the files that differ. Not the overlay diff — a repo holding a diff instead of a tree would not be a token repo, and could not be read by Style Dictionary in Phase 8 or by a human in a PR.

The token-level diff (§8) is a *view* over that file-level commit, not a different commit.

**`$import-report.json` is not committed.** It is machine state about a scan — timestamps, counts, flags — so committing it turns every rescan into a repo diff and buries the token change that mattered. Push writes the set files and `$manifest.json`. The report stays local.

**Pull.** A pulled value that differs from Figma is *a value the plugin holds that Figma does not* — which is precisely ADR-0004's overlay entry: a target, a new value, and the `base` it was derived against. So pull writes overlay entries and introduces no store:

```jsonc
{
  "target": { "variableId": "VariableID:1:4", "modeId": "1:0" },
  "op": "set-value",
  "value": "#c33a2e",          // from the repo
  "base": "#c33a2eff",         // Figma's current value, i.e. what this diverges from
  "origin": "pulled",          // NEW — the only field Phase 6 adds to the entry shape
  "at": "…"
}
```

`origin: "local" | "pulled"` (defaulting to `"local"` for entries written before Phase 6) exists so the panel can say *where* a pending change came from, and so a conflict message can name the repo rather than the user. Nothing in ADR-0004 §4's merge table changes; a pulled entry merges, conflicts and retires exactly like an authored one.

**Pull never writes to Figma.** It leaves pending entries, and getting them onto the canvas is Phase 5's existing apply flow — the same preview modal, the same executor, the same per-entry report. This is the second plan producer ADR-0005 §1 built the seam for, and it arrives without a second write path.

**Pull matches remote tokens to local ones by `set` + dotted path.** ADR-0004 §2 chose ids over paths for the overlay, and that was right when both sides of the comparison were Figma. Here one side is a JSON file whose *only* notion of identity is its key path — a repo-side rename genuinely is a rename of that token. Provenance in the remote file (`$extensions.com.tokenvault.figma`) is carried and used to disambiguate a path that matches two targets; it is not the match key.

### 6. A diverged file is refused, not merged

When a path's content differs from the base on both sides, Phase 6 **refuses the sync for that file and names it**. No automatic content merge, in either direction, at any granularity.

Two reasons, and the second is the real one:

- A three-way merge of token JSON is not a small feature. It needs per-token base values, which §3 deliberately does not store, and it produces exactly the class of silent wrong answer this project has refused everywhere else (ADR-0002 §5's collisions, ADR-0004 §4's conflicts, ADR-0005 §10's blocked applies).
- **A refusal is recoverable and a bad merge is not.** The user can always pull into a clean state, or push from one. A merge that quietly picked wrong writes into both a shared repo and a shared design file.

The escape hatches are ordinary git ones, offered explicitly: pull the remote file and discard local changes for it, or push local over remote as a normal commit whose parent is the current head. Both are per-file, for the same reason ADR-0004 §4 refused a global keep-mine/take-theirs — a file-wide answer to a token-level question is a coin flip.

**What the divergence UX actually looks like is Shyam's call, not this ADR's** — see [Open questions](#open-questions-not-decided-here). This section fixes only that the plugin does not merge content on its own.

### 7. Drift becomes repo-vs-Figma, and the Phase 5 framing is retired

ADR-0005 §8 recorded the limit and the exit: *"True drift becomes definable at Phase 6… the same comparator runs against the pulled tree instead of the cache. Only the baseline is swapped."* This is that swap.

| Situation | Drift baseline | Meaning |
|---|---|---|
| File connected to a repo, sync state present | the last-pulled repo value | **Divergence from the source of truth** — PRD §6.5.3's actual sense |
| Not connected, or no sync state | the import cache (ADR-0005 §7) | Changelog against a local watermark — Phase 5's behaviour, unchanged |

`src/tokens/drift.ts` takes a baseline tree as an argument today; it needs no new logic, only a different argument. The three entry kinds (`drift-value`, `drift-added`, `drift-removed`) are unchanged.

Consequence for `@ux-designer`, flagged rather than designed here: **`docs/ux/apply-and-drift.md` §6.4's temporary copy comes down.** That section says so itself — *"Phase 6 takes it back… `Re-apply token` becomes the honest label, and `Take Figma's` really does produce a local edit that needs committing."* Once the repo holds a value independent of Figma, `At your last scan` / `Now in Figma` is no longer what the two rows contain; `Your token` / `Now in Figma` is. Writing that is UX's, and it should be written against the connected case with the disconnected case still falling back to Phase 5's wording.

One thing the ADR does pin, because it is semantics rather than copy: **an unconnected file keeps Phase 5's drift exactly.** Connecting a repo is what upgrades drift, and it should be visible that it did.

### 8. Commits go through the Git Data API, one commit per push

Not the Contents API (`PUT /repos/{owner}/{repo}/contents/{path}`), which commits one file per call — a twelve-set change would land as twelve commits, and a reader of that history would learn nothing from any of them. The Git Data sequence is four calls plus one per changed file, and produces one commit:

```
POST /git/blobs        × N changed files   → blob SHAs
POST /git/trees        base_tree = current head's tree, with the N entries replaced
POST /git/commits      parent = baseCommitSha
PATCH /git/refs/heads/{branch}    force: false
```

Three properties are load-bearing and worth pinning:

- **`base_tree` means untouched files are untouched.** Files outside `tokensDir` — source, CI config, exported CSS from Phase 8 — are carried through by SHA and never rewritten. Push touches `tokens/**` and nothing else.
- **`force: false` makes a concurrent push fail instead of clobber.** If the branch moved between the status check and the `PATCH`, GitHub rejects the non-fast-forward and the plugin re-runs §4's comparison against the new head. This is the only guard against a lost commit, and it costs one flag.
- **Blob size.** The Contents API caps at 1MB; the blob API does not, which is the other reason for this route. The Folio tree's largest set file is well under either, but the ceiling should not be one the design sits near by accident.

Commit message: a generated one-liner plus a body listing the changed sets and counts, editable in the diff view before committing. Shape is UX's; that the user can edit it is this ADR's, because a repo whose history is 200 identical `Update tokens` commits is a history nobody reads.

### 9. Branch selection reads; it does not write

The settings panel offers a branch picker populated from `GET /repos/{owner}/{repo}/branches`, and every sync operation targets the configured branch. Changing branch invalidates `tokenvault:sync:<file-id>` — a different branch is a different base — and the next status check re-establishes it.

**No branch creation, no PR flow, no merge.** PRD §6.4 asks for "sync against a specific branch, not just `main`", which this satisfies exactly. Growing a PR flow means modelling review state, and review state is uncomfortably close to the team semantics PRD §4 rules out for v1. Whether it should grow one anyway is Shyam's call, in [Open questions](#open-questions-not-decided-here).

### 10. Rate limits and failure are handled explicitly, never silently

- **Authenticated REST is 5,000 requests/hour.** A status check is 1 call, a pull is 1 + N-changed, a push is 4 + N-changed. Even a pathological session is three orders of magnitude inside the limit, so no caching layer is built for it — but `x-ratelimit-remaining` is read and surfaced if it ever drops below a floor, rather than the plugin discovering a 403 as an unexplained failure.
- **Every failure is named.** 401 (bad or expired PAT) → *"GitHub rejected the token"*, and it points at settings. 403 with a rate-limit header → the reset time. 404 → repo or branch missing, or the PAT lacks access to it — these are indistinguishable in GitHub's response, and the message should say so instead of guessing. 409 / non-fast-forward → §8's re-check.
- **No partial commit state.** The Git Data sequence only becomes visible at the final `PATCH`; a failure before that leaves orphaned blobs GitHub garbage-collects and no branch movement. This is a real advantage over the Contents API and worth stating: a failed push leaves the repo exactly as it was.
- **Offline is a state, not an error.** Figma plugins run offline; the panel keeps working, sync status reads *"Can't reach GitHub"*, and nothing about the local tree depends on the network.

### 11. Deliberately deferred

Named so they are visibly out of scope rather than accidentally missing.

- **Creating a Variable or Style for a pulled token with no Figma counterpart.** ADR-0005 §4 said this becomes necessary "when a pulled tree holds tokens this file lacks", and it does — but it needs a collection-resolution rule, a mode, a resolved type, a scope set and a name, which is the authoring decision Phase 4 and Phase 5 both declined. Phase 6 **reports** these as a new report kind, `pull-unmatched`, carrying the path and the set, and applies nothing. It is its own ticket and probably its own ADR. The honest consequence: a repo authored outside Tokenvault pulls in read-only until that lands.
- **OAuth.** PRD §6.4 and §11 put it in v2, and it is the only part of this design that would need a hosted component. §12 says why that matters.
- **Other providers.** GitHub only (PRD §4). `api.ts` is small enough to grow a second implementation later; nothing in this ADR designs toward it.
- **Style Dictionary and the Actions workflow.** Phase 8. What Phase 6 owes it is a committed `tokens/` tree with a stable shape, which §5 delivers.
- **Automatic or scheduled push.** Open question below; Phase 6 builds manual push and pull only.
- **Committing the import report, or any per-scan state.** §5.

## Consequences

- `@frontend-engineer` can build Phase 6 against this: five modules, three storage keys, the SHA state table, the Git Data call sequence and the failure taxonomy are pinned.
- Sync state costs ~1KB per file. ADR-0004 §6's quota story is unchanged, and the tree that would have blown it is never persisted.
- Pull introduces **no new store and no new write path** — it produces overlay entries and hands them to Phase 5's apply flow. This is the single biggest saving in the phase, and it is a direct return on ADR-0004 §1 and ADR-0005 §1.
- The overlay is formally demoted to "uncommitted changes", answering ADR-0004's first open question. The header chip's Phase 4 wording (*local edits*, not *unsaved*) becomes literally correct: Phase 6 is where "saved" starts meaning something.
- Drift stops being a local changelog and becomes divergence from a source of truth — which retires the reconciled copy in `docs/ux/apply-and-drift.md` §6.4 and hands `@ux-designer` a rewrite that doc already predicted.
- A diverged file blocks rather than merges. That is friction, deliberately, and it will be felt first by whoever edits tokens on two machines. §6 names the escape hatches; if the friction turns out to be routine rather than rare, that is evidence for a real merge, not a reason to have guessed one now.
- Push writes to a shared repo, so Tokenvault now has two destinations that other people can see. Figma got confirmation, ordering and a per-entry report (ADR-0005 §6); git gets a reviewable diff, an editable message, and `force: false`.
- The PAT is now the most sensitive thing the plugin holds. §1's three rules are the whole mitigation, and they are code-level, not process-level.
- **No infra implication, and this is the phase where that was in question.** GitHub REST, a PAT, and files in a repo. No relay, no server, no scheduled worker — see §12.

## Zero-recurring-cost check (PRD §8)

Worth doing explicitly here, because Phase 6 is the first phase whose obvious alternative has a cost floor.

| Component | Choice | Cost |
|---|---|---|
| Transport | GitHub REST API, from the plugin iframe | Free, 5,000 req/hr |
| Storage | GitHub repo | Free |
| Auth | Fine-grained PAT in `clientStorage` | Free |
| Change detection | Locally computed blob SHAs | Free — no service |
| Conflict handling | Refuse and report (§6) | Free — no merge service |

Nothing here has a floor above $0. The one design that would is **OAuth**, which needs a token-exchange endpoint the plugin cannot host — PRD §7 and §8 both name a free-tier serverless function, and at this scale it genuinely is free, but it is a component with an owner, an uptime story, and a provider that can change its free tier. That is a different risk from "no component at all", which is why PAT is v1 and OAuth is a v2 stretch. This ADR does not build toward it, and if it ever lands it should be its own ADR with that tradeoff in the open.

## Alternatives considered

- **Persist the pulled tree as a third store.** Rejected. A second ~700KB blob in a 5MB store shared with the overlay and the import cache, to cache something one cheap request re-derives. §3's SHAs answer every question the cache would have, at 1/600th the size.
- **Use the Contents API for commits.** Rejected. One commit per file turns a normal token change into a dozen commits with no reviewable unit, and its 1MB file cap is a ceiling this design would then sit under. Four extra calls buys one atomic commit.
- **Push the overlay diff rather than the tree.** Rejected. The repo has to hold token JSON that Style Dictionary (Phase 8), a PR reviewer, and any other tool can read. A diff is not that. The token-level diff is a view over a file-level commit, which is what §8 builds.
- **Attempt a three-way merge of diverged files.** Rejected for v1 (§6). It needs per-token base content this design deliberately does not store, and the failure mode is a silently wrong token in a shared repo. A refusal is always recoverable; a bad merge is not.
- **Let one side win on divergence — repo always, or local always.** Rejected. Both are data loss with a policy attached, and which side is right routinely differs per file. The same objection ADR-0004 §4 raised against a global keep-mine/take-theirs.
- **Match pulled tokens by Figma provenance id rather than path.** Rejected. The repo file's identity for a token *is* its path — that is what a JSON key means — so id-matching would read a repo-side rename as a delete plus an add and destroy the rename. Provenance is still carried and used to disambiguate.
- **Make pull write to Figma directly.** Rejected. It would be a second write path alongside apply, with its own confirmation, ordering and failure reporting — all of which ADR-0005 already built once. Routing pulls through overlay entries reuses every one of them.
- **Give pulled changes their own store instead of the overlay.** Rejected. A pulled change and a local edit are the same thing structurally (a value the plugin holds and Figma does not, with a recorded base), and two stores holding the same shape would eventually disagree about what "pending" means. One `origin` field is the whole difference.
- **Poll GitHub for remote changes.** Rejected, on the same reasoning as ADR-0005 §9. A status check is cheap but not free, the answer is only interesting when the user is about to act, and a background timer inside a Figma plugin is a battery and rate-limit cost paid for a question nobody asked. Check on panel open and on demand.
- **Commit `$import-report.json` along with the tokens.** Rejected. Every rescan would produce a repo diff dominated by timestamps and counts, which is how a token history becomes unreadable.
- **Store the PAT in the iframe's `localStorage` to avoid passing it over `postMessage`.** Rejected. PRD §6.4 and §7 both specify `clientStorage`, iframe storage in Figma has been unreliable across versions, and the token would then be invisible to the sandbox that orchestrates every operation. The message-channel exposure is real and is mitigated in §1 rather than traded for a worse store.
- **Build the OAuth relay now and skip PAT friction.** Rejected — PRD §11 defers it, and §12 above says why the zero-cost constraint makes "no component" categorically different from "a free component".
- **Ship branch creation and a PR flow.** Rejected for Phase 6 (§9). PRD §6.4 asks for branch *selection*; a PR flow means modelling review, which sits next to the team semantics PRD §4 excludes. Left open for Shyam rather than silently foreclosed.

## Open questions (not decided here)

Four are genuinely Shyam's, and one is an API fact to verify during implementation.

1. **What happens when both sides moved.** §6 fixes that the plugin does not merge content on its own. It does *not* fix what the user sees: a blocking banner that names the diverged files and offers per-file *take repo* / *keep mine*, or a diff view that lets the two versions be compared before choosing, or something narrower. This is the moment Phase 6 is most likely to be judged on, and it is a product call as much as a technical one.
2. **Manual push only, or scheduled/automatic.** Phase 6 as designed pushes when asked. Automatic push on every edit would make the repo the live state and remove the "uncommitted work" concept entirely — a coherent design, and a much bigger behavioural change than it sounds. Auto-*pull* on panel open is a separate and milder question. Both are yours.
3. **Is the diff view a new surface, or does it grow out of Phase 5's Changes panel?** `docs/ux/apply-and-drift.md` §6.3 already calls the Changes list *"the one place the whole state of the world is legible"* and expects Phase 6's sync pill to land in the same slot, and ADR-0005 §6 built the apply preview intending Phase 6 to inherit its list component. Reusing it is the cheaper and more consistent answer, but a commit diff has a message field, a file grouping and a push button that the Changes list does not — enough that it may want its own screen. `@ux-designer`'s to design, yours to scope.
4. **How much git should Tokenvault expose?** §9 ships push/pull against one selected branch. The next rungs are creating a branch from the panel, and opening a PR instead of committing to the branch directly. Both are technically small on top of §8; the question is whether Tokenvault is a sync client or a git client, and that is a product decision.
5. **Does the initial connect adopt the repo or overwrite it?** When a file with existing tokens is first pointed at a repo that already has a `tokens/` tree, §4's state table calls every file diverged, which is technically correct and practically unhelpful for what is a one-time bootstrap. A first-connect step probably needs its own answer — *adopt the repo*, *publish Figma over it*, or *review file by file*. Flagged rather than assumed, because whichever is right depends on how the first real repo comes into existence.

**To verify during implementation, not a decision:** whether Figma's iframe `fetch` sends and receives the headers this design reads (`x-ratelimit-remaining`, and the ETag a conditional status check would want). `networkAccess.allowedDomains` is already set for `api.github.com`, so the request itself is known to be permitted; header visibility under the plugin's CORS posture is not asserted here. If ETags are unavailable, §4 still works — the status check is simply never free, only cheap.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §7 determinism and byte-identical serialization, which §4's blob SHAs depend on entirely
- ADR-0003 (`docs/adr/0003-styles-token-schema.md`) — §1 style sets in the manifest, §7 module boundary
- ADR-0004 (`docs/adr/0004-local-edit-persistence.md`) — §1 the two stores and the 5MB budget, §2 the overlay entry shape §5 extends, §4 the merge table pulled entries ride, §6 quota policy, and the open question this ADR answers
- ADR-0005 (`docs/adr/0005-figma-apply-and-drift.md`) — §1 the `ApplyPlan` seam Phase 6 is the second producer for, §4 creation deferred (and §11 here), §7–§8 drift and the baseline swap §7 here performs, §9 no polling
- PRD §4 (non-goals), §6.4 (git sync), §6.6 (export, Phase 8), §6.7 (settings and sync status), §7 (architecture), §8 (cost), §9 Phase 6, §11 (PAT vs. OAuth): `docs/prd.md`
- `docs/ux/apply-and-drift.md` — §6.3 the Changes list, §6.4 the temporary drift copy §7 here retires
- Phase 2–5 implementation: `src/tokens/build.ts` (`TOKENS_DIR`, `TokenFileOutput`), `src/tokens/serialize.ts` (`stableStringify`), `src/tokens/overlay.ts`, `src/tokens/plan.ts`, `src/tokens/drift.ts`, `src/figma/apply.ts`, `src/code.ts` (`resolveStorageKey`), `manifest.json` (`networkAccess`)
- GitHub REST API — Git Data (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`), `/git/trees/{ref}?recursive=1`, `/repos/{owner}/{repo}/branches`, fine-grained PAT permissions, 5,000 req/hr authenticated limit
