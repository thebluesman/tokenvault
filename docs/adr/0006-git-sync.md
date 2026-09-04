# ADR-0006 — Git sync over the GitHub REST API (PAT)

**Status**: Accepted
**Date**: 2026-09-02
**Accepted**: 2026-09-02 — Shyam resolved every open question that was his to make; the one item still open is an API fact to verify during implementation, not a decision. See [Open questions](#open-questions-not-decided-here). Phase 6 built and merged against this ADR 2026-09-03 (PR #14, `8efe321`), unamended.
**Owner**: @tech-lead
**Extended by**: [ADR-0008 — Multi-repo push routing](0008-multi-repo-push-routing.md) (Accepted, 2026-09-04). This ADR remains the single-repo design and behaves exactly as written whenever one repo is connected. Four sections are generalised there:

- **§2 — scope note, editorial.** *"The repo is the source of truth"* was written for the single-repo case. With N repos there is no primary: the **local tree** (`build(scan, userSubtypes, pathRules) + overlay`) is the authored truth, and each repo is an independently-tracked sync target (ADR-0008 §1). The overlay's demotion to uncommitted work survives unchanged, and strengthens — it is uncommitted with respect to every connection.
- **§3 — `tokenvault:sync:<file-id>` gains a connection id** (ADR-0008 §2, §6). The shared PAT key is unchanged: one token for all connections by default, reversing §1's per-repo scoping, plus an optional `tokenvault:github-pat:<connection-id>` override for a repo outside that token's resource owner (ADR-0008 §2).
- **§7 — the drift baseline is retired and replaced** (ADR-0008 §6a). Drift now measures Figma against the **local tree**, with no repo involved, and each repo's own agreement status is tracked and shown **per repo**, never collapsed into one signal. See the note in §7 below.
- **§10 — "no partial commit state"** stays true per repo and is false across repos; a fan-out push has a per-repo result list (ADR-0008 §4).

§1's per-repo PAT scoping is the one decision here that ADR-0008 reverses outright; the tradeoff is recorded in ADR-0008 §2 rather than edited away here.

> Shyam resolved this ADR's six open questions on 2026-09-02, before acceptance. They are folded into the decision sections below and marked *(resolved 2026-09-02)*: divergence is per-file, whole-file pick-a-side and only the diverged file blocks (§6); first connect asks once whether to adopt the repo (§6); push and pull are manual, with no auto-pull (§5); the diff/commit view is its own surface (§8); Tokenvault is a sync client, not a git client (§9); and a bulk *Take Figma's* gets its own confirmation (§7).

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
| `tokenvault:sync:<file-id>` | `{ owner, repo, branch, tokensDir, baseCommitSha, blobShas: Record<path, sha>, at }` | ~1 KB at 12 files |

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

### 5. Push commits the whole tree; pull materializes as overlay entries — both manual *(resolved 2026-09-02)*

**Push and pull happen when the user asks, and never otherwise. Auto-pull is rejected.** Sync *status* (§4) refreshes on its own — it is one cheap call and the answer is only useful when it is current — but nothing moves in either direction without an explicit action. Automatic push would make the repo the live state and delete the "uncommitted work" concept §2 just established; auto-pull would queue overlay entries the user did not ask for, ahead of an apply flow (ADR-0005 §6) that assumes every pending change has an author. §10's no-polling reasoning is unchanged: a refresh is not a transfer.


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

**Divergence resolves per file, whole file, pick a side** *(resolved 2026-09-02)*. The unit of the choice is the unit of the commit (§5): for each diverged path the user picks *take the repo's* or *keep mine*, and that answer applies to the whole file. There is no per-token resolution, because a per-token answer is a merge with extra steps and needs the per-token base §3 does not store.

**Only the diverged file blocks.** A sync that touches ten files and finds one diverged pushes the other nine and names the one. Blocking the whole push on one file would make a single stale set unfixable without resolving it first, which is friction with no safety payoff — the nine clean files are fast-forwards by §4's own table.

**First connect asks once** *(resolved 2026-09-02)*. Pointing a file with existing tokens at a repo that already has a `tokens/` tree makes §4's table call every file diverged, which is technically right and useless as a bootstrap. So connect asks a single question — *adopt this repo's tokens as your starting point?*, preselected — and answering yes seeds `blobShas` from the fetched tree, making the repo the base and reducing everything to a normal pull. Answering no leaves every file diverged and hands the user §6's per-file choice. **If the repo has no `tokens/` tree, the question is skipped** and the first push is the bootstrap. This is one question, at one moment, and it never appears again for that file.

The wording and placement of all three are `@ux-designer`'s; what is fixed here is the granularity, the non-blocking behaviour, and that the plugin merges no content on its own.

### 7. Drift becomes repo-vs-Figma, and the Phase 5 framing is retired

ADR-0005 §8 recorded the limit and the exit: *"True drift becomes definable at Phase 6… the same comparator runs against the pulled tree instead of the cache. Only the baseline is swapped."* This is that swap.

| Situation | Drift baseline | Meaning |
|---|---|---|
| File connected to a repo, sync state present | the last-pulled repo value | **Divergence from the source of truth** — PRD §6.5.3's actual sense |
| Not connected, or no sync state | the import cache (ADR-0005 §7) | Changelog against a local watermark — Phase 5's behaviour, unchanged |

> **Superseded by ADR-0008 §6a (2026-09-04).** This table's first row assumed one repo, and there is now no privileged repo to take a baseline from (ADR-0008 §1). It is replaced by two separate measures rather than one whose baseline swaps:
>
> | Axis | Question | Baseline | Cardinality |
> |---|---|---|---|
> | **Drift** | Has Figma changed away from what the tokens say? | the local tree — `build(scan, userSubtypes, pathRules) + overlay` | **one**, project-wide |
> | **Divergence** | Does repo R agree with the tokens? | R's `blobShas`, per file (§4, §6) | **one per (repo, file)** |
>
> §7's *intent* survives — drift still means "Figma disagrees with what the tokens are", not "Figma changed since I last looked" — because pulled repo content reaches the local tree through the overlay (§5). What goes is the mode change, where connecting a repo silently altered what the drift list meant.
>
> **Per-repo status is guaranteed, not incidental** (Shyam, 2026-09-04: *"flag discrepancies for each repo"*). Every enabled connection's state stays individually inspectable, the header chip is a worst-case summary that must never stand in for the breakdown, and every block — divergence (§6), rule-set mismatch, a cross-repo dangling reference — names its repo rather than reporting "the push failed". This is a **UI** requirement as well as a data-model one; §6.4 of `docs/ux/apply-and-drift.md` carries it.

`src/tokens/drift.ts` takes a baseline tree as an argument today; it needs no new logic, only a different argument. The three entry kinds (`drift-value`, `drift-added`, `drift-removed`) are unchanged.

Consequence for `@ux-designer`, flagged rather than designed here: **`docs/ux/apply-and-drift.md` §6.4's temporary copy comes down.** That section says so itself — *"Phase 6 takes it back… `Re-apply token` becomes the honest label, and `Take Figma's` really does produce a local edit that needs committing."* Once the repo holds a value independent of Figma, `At your last scan` / `Now in Figma` is no longer what the two rows contain; `Your token` / `Now in Figma` is. Writing that is UX's, and it should be written against the connected case with the disconnected case still falling back to Phase 5's wording.

**A bulk *Take Figma's* gets its own confirmation step** *(resolved 2026-09-02)*. Resolving one drifted token in place needs no ceremony, but accepting Figma's values across a whole set stages many overlay entries at once, and the commit modal downstream is not a substitute — by the time the user reaches it the edits already exist, and unpicking them is N undos. Shyam's call, over the cheaper recommendation of relying on the commit step: a bulk action that stages many changes is confirmed explicitly, with a count. Same reasoning as ADR-0005 §6's always-confirm rule, applied to the one action here that fans out.

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

**The diff/commit view is its own surface, not a grown Changes panel** *(resolved 2026-09-02)*. Shyam's call, over the recommendation to extend Phase 5's Changes list: a commit is meaningfully different from an apply. It groups by file rather than by token, it carries a message field and a push button, and it is a review of what leaves the machine rather than a list of what is pending on it. Bending one panel to serve both would make the cheaper surface worse. The Changes panel keeps its sync status pill and links across; the commit view is where a push is reviewed and sent. Component reuse below the surface — the same row and value-pair rendering ADR-0005 §6 built — is expected and is `@ux-designer`'s to decide, but the two are separate screens.

### 9. Branch selection reads; it does not write — Tokenvault is a sync client, not a git client *(resolved 2026-09-02)*

Shyam's call, and it settles §9 permanently rather than for Phase 6 only: **one branch, push and pull, and a link out to GitHub for anything deeper.** No in-plugin branch creation, no PR flow, no merge, no history browser. Where a user needs one of those, the plugin opens the repo, the branch, or the commit in GitHub and lets GitHub be the git client. That keeps the surface honest about what it is, and keeps review state — which sits next to the team semantics PRD §4 excludes for v1 — out of the plugin entirely.


The settings panel offers a branch picker populated from `GET /repos/{owner}/{repo}/branches`, and every sync operation targets the configured branch. Changing branch invalidates `tokenvault:sync:<file-id>` — a different branch is a different base — and the next status check re-establishes it. **Correction, post-merge (2026-09-03, `cb086ee`):** the same is true of `tokensDir` — every `blobShas` entry is a repo path built from it, so a folder change invalidates the base for exactly the reason a branch change does, and `tokensDir` was added to the equality check accordingly. The first build shipped without it, which made a folder rename misread every file as diverged; caught by post-merge review, not by design.

**No branch creation, no PR flow, no merge.** PRD §6.4 asks for "sync against a specific branch, not just `main`", which this satisfies exactly. Growing a PR flow means modelling review state, and review state is uncomfortably close to the team semantics PRD §4 rules out for v1.

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
- **Automatic or scheduled push, and auto-pull.** Decided against, not deferred — §5. Push and pull are manual; only status refreshes on its own.
- **Branch creation, PR flow, merge, history browsing.** Decided against — §9. GitHub is the git client; Tokenvault links out.
- **Committing the import report, or any per-scan state.** §5.

## Consequences

- `@frontend-engineer` can build Phase 6 against this: five modules, three storage keys, the SHA state table, the Git Data call sequence and the failure taxonomy are pinned.
- Sync state costs ~1KB per file. ADR-0004 §6's quota story is unchanged, and the tree that would have blown it is never persisted.
- Pull introduces **no new store and no new write path** — it produces overlay entries and hands them to Phase 5's apply flow. This is the single biggest saving in the phase, and it is a direct return on ADR-0004 §1 and ADR-0005 §1.
- The overlay is formally demoted to "uncommitted changes", answering ADR-0004's first open question. The header chip's Phase 4 wording (*local edits*, not *unsaved*) becomes literally correct: Phase 6 is where "saved" starts meaning something.
- Drift stops being a local changelog and becomes divergence from a source of truth — which retires the reconciled copy in `docs/ux/apply-and-drift.md` §6.4 and hands `@ux-designer` a rewrite that doc already predicted.
- A diverged file blocks rather than merges, and blocks *alone* — the rest of the push goes through. That is friction, deliberately, and it will be felt first by whoever edits tokens on two machines. §6 names the escape hatches; if the friction turns out to be routine rather than rare, that is evidence for a real merge, not a reason to have guessed one now.
- `@ux-designer` now has three surfaces to design for Phase 6, not one: the commit view (§8, its own screen), the per-file divergence chooser (§6), and the one-time connect question (§6). Plus the bulk-confirm on *Take Figma's* (§7) and the retired §6.4 copy in `docs/ux/apply-and-drift.md`. Phase 6 is a bigger UX phase than Phase 5 was.
- Nothing in the plugin ever moves data without being asked (§5). Sync status is the only thing that refreshes on its own, and it transfers nothing.
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
- **Ship branch creation and a PR flow.** Rejected (§9), by Shyam, not just for Phase 6. PRD §6.4 asks for branch *selection*; a PR flow means modelling review, which sits next to the team semantics PRD §4 excludes. Tokenvault is a sync client and links out to GitHub for the rest.
- **Grow the diff/commit view out of Phase 5's Changes panel.** Rejected (§8) by Shyam, over this ADR's own recommendation. Cheaper and more consistent, but a commit groups by file, carries a message and a push button, and reviews what leaves the machine — enough difference that one panel serving both would degrade the simpler one. Components are shared; the screens are not.
- **Let the commit modal stand in for confirming a bulk *Take Figma's*.** Rejected (§7) by Shyam, over this ADR's own recommendation. By the time the commit modal appears the edits are already staged, and backing them out is N undos. A fan-out action confirms itself.
- **Auto-pull on panel open.** Rejected (§5). Milder than auto-push, but it still queues overlay entries nobody authored into an apply flow that assumes an author. Status refreshes automatically; content does not move.
- **Treat every file as diverged on first connect.** Rejected (§6). Correct by §4's table and useless as a bootstrap — it turns connecting a repo into a twelve-file conflict resolution. One preselected question at connect time collapses it to a normal pull.

## Open questions (not decided here)

**One remains, and it is an API fact to verify during implementation, not a decision.**

**To verify during implementation:** whether Figma's iframe `fetch` sends and receives the headers this design reads (`x-ratelimit-remaining`, and the ETag a conditional status check would want). `networkAccess.allowedDomains` is already set for `api.github.com`, so the request itself is known to be permitted; header visibility under the plugin's CORS posture is not asserted here. If ETags are unavailable, §4 still works — the status check is simply never free, only cheap.

**Resolved since drafting** — recorded so the trail is visible rather than silently edited away.

*By Shyam, 2026-09-02:*

1. **Divergence UX** → per-file, whole-file pick-a-side; clean files still push, only the diverged file blocks (§6).
2. **Push/pull cadence** → manual push and manual pull only, status refreshes automatically, auto-pull rejected (§5).
3. **Diff/commit view surface** → its own surface, not a grown Changes panel — overriding this ADR's recommendation to reuse it, on the grounds that a commit is meaningfully different from an apply (§8).
4. **How much git to expose** → sync client, not git client: one branch, push/pull, link out to GitHub for anything deeper (§9).
5. **First connect** → ask once whether to adopt the repo's existing content as the starting point, preselected; skip the question when the repo is empty (§6).
6. **Bulk *Take Figma's*** → its own confirmation step, overriding this ADR's recommendation of none, because a bulk action staging many changes deserves an explicit yes even with a commit modal downstream (§7).

What the user *sees* for all six — wording, placement, the shape of the per-file chooser and the connect question — remains `@ux-designer`'s and is not restated here. This ADR owns granularity, blocking behaviour and semantics; the UX doc owns presentation, and wins on it if the two ever disagree.

## References

- ADR-0002 (`docs/adr/0002-variables-token-schema.md`) — §7 determinism and byte-identical serialization, which §4's blob SHAs depend on entirely
- ADR-0003 (`docs/adr/0003-styles-token-schema.md`) — §1 style sets in the manifest, §7 module boundary
- ADR-0004 (`docs/adr/0004-local-edit-persistence.md`) — §1 the two stores and the 5MB budget, §2 the overlay entry shape §5 extends, §4 the merge table pulled entries ride, §6 quota policy, and the open question this ADR answers
- ADR-0005 (`docs/adr/0005-figma-apply-and-drift.md`) — §1 the `ApplyPlan` seam Phase 6 is the second producer for, §4 creation deferred (and §11 here), §7–§8 drift and the baseline swap §7 here performs, §9 no polling
- PRD §4 (non-goals), §6.4 (git sync), §6.6 (export, Phase 8), §6.7 (settings and sync status), §7 (architecture), §8 (cost), §9 Phase 6, §11 (PAT vs. OAuth): `docs/prd.md`
- `docs/ux/apply-and-drift.md` — §6.3 the Changes list, §6.4 the temporary drift copy §7 here retires
- Phase 2–5 implementation: `src/tokens/build.ts` (`TOKENS_DIR`, `TokenFileOutput`), `src/tokens/serialize.ts` (`stableStringify`), `src/tokens/overlay.ts`, `src/tokens/plan.ts`, `src/tokens/drift.ts`, `src/figma/apply.ts`, `src/code.ts` (`resolveStorageKey`), `manifest.json` (`networkAccess`)
- GitHub REST API — Git Data (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`), `/git/trees/{ref}?recursive=1`, `/repos/{owner}/{repo}/branches`, fine-grained PAT permissions, 5,000 req/hr authenticated limit
