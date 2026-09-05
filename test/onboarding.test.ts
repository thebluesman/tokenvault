// Phase 10's onboarding polish — UX `docs/ux/onboarding-polish.md`, issue #22.
//
// Four gaps, four groups of tests. Everything here is over the pure modules the render layer reads
// from, which is the whole reason the grouping, the threshold, the token analysis and the copy were
// pulled out of the DOM in the first place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXPIRY_WARNING_DAYS,
  analyzeToken,
  expiryDetail,
  expiryHeadline,
  expiryStatus,
  formatExpiry,
  parseTokenExpiry,
  patChecklist,
  patChecklistText,
  statusLine,
  tokenVerdict,
} from "../src/git/patSetup";
import {
  BULK_CONFIRM_THRESHOLD,
  NO_GUESS,
  bulkUndoMessage,
  defaultOpenGroup,
  groupCandidates,
  needsConfirmStrip,
  previousSelections,
} from "../src/tokens/subtypeGroups";
import { countBands } from "../src/tokens/importCounts";
import { isFirstPush } from "../src/git/diff";
import { HOW_IT_WORKS, NEVER_DOES, PLACEMENTS, VERBS } from "../src/ui/threePlace";
import type { SubtypeCandidate, SubtypeSelection } from "../src/tokens/types";
import type { FileStatus, RepoSettings } from "../src/git/types";

// ---------------------------------------------------------------------------
// Gap 11 — the token check (§4.3) and expiry (§4.4)
// ---------------------------------------------------------------------------

test("a token GitHub says can push reads as a verdict, not a hedge", () => {
  const check = analyzeToken({ permissions: { admin: false, push: true, pull: true } });
  assert.equal(check.write, "yes");
  const verdict = tokenVerdict(check, "thebluesman/folio-tokens");
  assert.equal(verdict.tone, "ok");
  assert.equal(verdict.headline, "This token can read and write thebluesman/folio-tokens.");
  assert.equal(verdict.offerGitHub, false);
});

test("Contents: Read only is caught here, and points at the step that fixes it", () => {
  // The whole reason §4.3 exists. This used to pass `[ Test connection ]`, connect, and fail hours
  // later on the first push, after 132 subtypes and a written commit message.
  const check = analyzeToken({ permissions: { admin: false, push: false, pull: true } });
  assert.equal(check.write, "no");
  const verdict = tokenVerdict(check, "thebluesman/folio-tokens");
  assert.equal(verdict.tone, "warn");
  assert.equal(verdict.headline, "This token can read thebluesman/folio-tokens, but not write to it.");
  // Naming the step number is what turns a diagnosis into an instruction — the checklist is three
  // lines above and still on screen.
  assert.equal(verdict.detail[0].indexOf("Step 2") !== -1, true);
  assert.equal(verdict.offerGitHub, true);
});

test("admin or maintain implies push, so an owner's token isn't misreported as read-only", () => {
  assert.equal(analyzeToken({ permissions: { admin: true } }).write, "yes");
  assert.equal(analyzeToken({ permissions: { maintain: true, push: false } }).write, "yes");
});

test("no permissions block downgrades the copy to a warning rather than guessing", () => {
  // §4.3's own fallback, taken: where GitHub doesn't answer, the panel says it doesn't know. Still
  // better than first push, and it must never claim a verdict it can't support.
  for (const probe of [{}, { permissions: null }, { permissions: {} }]) {
    const check = analyzeToken(probe);
    assert.equal(check.write, "unknown");
    const verdict = tokenVerdict(check, "acme/tokens");
    assert.equal(verdict.tone, "warn");
    assert.equal(verdict.headline, "We couldn't confirm this token can push to acme/tokens.");
    // A warning, not a verdict: it must not assert the token *cannot* push.
    assert.equal(/can read .* but not write/.test(verdict.headline), false);
    assert.equal(verdict.detail[0].indexOf("first push") !== -1, true);
  }
});

test("GitHub's expiration header parses, in both shapes it arrives in", () => {
  assert.equal(parseTokenExpiry("2026-12-03 21:44:31 UTC"), "2026-12-03T21:44:31.000Z");
  assert.equal(parseTokenExpiry("2026-12-03T21:44:31Z"), "2026-12-03T21:44:31.000Z");
  assert.equal(parseTokenExpiry("2026-12-03 21:44:31 +02:00"), "2026-12-03T19:44:31.000Z");
});

test("an absent, empty or unparseable expiration header is null, never a wrong date", () => {
  for (const raw of [null, "", "   ", "never", "2026-13-45 99:99:99 UTC"]) {
    assert.equal(parseTokenExpiry(raw), null);
  }
});

test("the expiry warning window is 7 days, and the boundary is inside it", () => {
  assert.equal(EXPIRY_WARNING_DAYS, 7);
  const now = Date.parse("2026-09-05T12:00:00Z");
  const at = (days: number): string => new Date(now + days * 86400000).toISOString();

  assert.equal(expiryStatus(at(30), now).state, "none");
  assert.equal(expiryStatus(at(8), now).state, "none");
  // Just inside seven days is the first moment the gear lights.
  assert.equal(expiryStatus(at(6.9), now).state, "soon");
  assert.equal(expiryStatus(at(5), now).days, 5);
  assert.equal(expiryStatus(at(-1), now).state, "expired");
});

test("no expiry at all is not a warning — a non-expiring token is a fine token", () => {
  const now = Date.now();
  assert.equal(expiryStatus(null, now).state, "none");
  assert.equal(expiryStatus(undefined, now).state, "none");
  assert.equal(expiryHeadline(expiryStatus(null, now)), null);
});

test("the expiry notice counts days and says what to do about it", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  const at = (days: number): string => new Date(now + days * 86400000).toISOString();

  assert.equal(expiryHeadline(expiryStatus(at(5), now)), "Your GitHub token expires in 5 days.");
  assert.equal(expiryHeadline(expiryStatus(at(1.5), now)), "Your GitHub token expires in 1 day.");
  assert.equal(expiryHeadline(expiryStatus(at(0.5), now)), "Your GitHub token expires today.");
  assert.equal(expiryHeadline(expiryStatus(at(-2), now)), "Your GitHub token has expired.");
  assert.equal(expiryDetail(expiryStatus(at(-2), now)).indexOf("Make a new one") !== -1, true);
});

test("the expiry date renders read-once, not as an ISO string", () => {
  assert.equal(formatExpiry("2026-12-03T21:44:31.000Z"), formatExpiry("2026-12-03T21:44:31.000Z"));
  assert.equal(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(formatExpiry("2026-12-03T12:00:00.000Z")), true);
});

test("a known expiry rides along on the healthy verdict, where it costs nothing", () => {
  const check = analyzeToken({
    permissions: { push: true },
    expirationHeader: "2026-12-03 21:44:31 UTC",
  });
  const verdict = tokenVerdict(check, "acme/tokens");
  assert.equal(verdict.detail.length, 1);
  assert.equal(verdict.detail[0].indexOf("Expires") === 0, true);
});

test("an x-oauth-scopes header marks the token as a classic one", () => {
  assert.equal(analyzeToken({ scopesHeader: "repo, workflow" }).classic, true);
  assert.equal(analyzeToken({ scopesHeader: "" }).classic, false);
  assert.equal(analyzeToken({}).classic, false);
});

test("the checklist names GitHub's own controls, and interpolates the repo into step 1", () => {
  const steps = patChecklist("thebluesman/folio-tokens");
  assert.equal(steps.length, 3);
  assert.equal(steps[0].indexOf("thebluesman/folio-tokens") !== -1, true);
  assert.equal(steps[0].indexOf("Only select repositories") !== -1, true);
  // Step 2 is the one the read-only verdict points back at, so its wording has to match.
  assert.equal(steps[1].indexOf("Read and write") !== -1, true);
});

test("[ Copy these 3 ] copies all three steps plus the page to do them on", () => {
  const text = patChecklistText("acme/tokens");
  for (const step of patChecklist("acme/tokens")) {
    assert.equal(text.indexOf(step) !== -1, true);
  }
  assert.equal(text.indexOf("https://github.com/settings/personal-access-tokens/new") !== -1, true);
  assert.equal(text.indexOf("1. ") !== -1 && text.indexOf("3. ") !== -1, true);
});

const SETTINGS: RepoSettings = {
  owner: "thebluesman",
  repo: "folio-tokens",
  branch: "main",
  tokensDir: "tokens",
};

test("the status line names what's missing rather than reporting a disabled button", () => {
  const base = {
    settings: null,
    hasToken: false,
    connectedForFile: false,
    draftRepo: false,
    failure: false,
    checked: false,
  };
  assert.equal(statusLine(base), "● Needs a repo and a token");
  assert.equal(statusLine({ ...base, draftRepo: true }), "● Needs a token");
  assert.equal(statusLine({ ...base, hasToken: true }), "● Needs a repo");
  // A repo typed but not yet saved is a form mid-fill, not a connection state.
  assert.equal(statusLine({ ...base, draftRepo: true, hasToken: true }), "● Not saved yet");
});

test("a saved, credentialled, unchecked connection says so — not `Not connected`", () => {
  const saved = {
    settings: SETTINGS,
    hasToken: true,
    connectedForFile: false,
    draftRepo: true,
    failure: false,
    checked: false,
  };
  assert.equal(statusLine(saved), "● Not checked yet");
  assert.equal(statusLine({ ...saved, checked: true }), "● Not connected for this file");
  assert.equal(statusLine({ ...saved, connectedForFile: true, checked: true }), "● Connected · main");
  assert.equal(statusLine({ ...saved, failure: true }), "⚑ Connection problem");
});

// ---------------------------------------------------------------------------
// Gap 12 — the subtype queue (§5)
// ---------------------------------------------------------------------------

function candidate(
  id: string,
  subtype: string | undefined,
  source: "user" | "scope" | "default" = "default"
): SubtypeCandidate {
  return {
    variableId: id,
    variableName: `var/${id}`,
    collectionName: "Primitives",
    tokenType: "number",
    subtype: subtype as SubtypeCandidate["subtype"],
    subtypeSource: source as SubtypeCandidate["subtypeSource"],
    scopes: [],
    needsConfirmation: source === "default",
    sampleValue: 8,
  };
}

function many(count: number, subtype: string | undefined, prefix: string): SubtypeCandidate[] {
  const out: SubtypeCandidate[] = [];
  for (let i = 0; i < count; i += 1) out.push(candidate(`${prefix}-${i}`, subtype));
  return out;
}

test("the queue groups by the guess — the axis the decision is actually made on", () => {
  const groups = groupCandidates(
    many(90, "spacing", "s").concat(many(24, "sizing", "z"), many(12, "radius", "r"))
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ["spacing · 90", "sizing · 24", "radius · 12"]
  );
  assert.equal(groups[0].candidates.length, 90);
  assert.equal(groups[0].subtype, "spacing");
});

test("largest first, ties broken alphabetically so the order is stable across renders", () => {
  const groups = groupCandidates(
    many(5, "radius", "r").concat(many(5, "opacity", "o"), many(9, "spacing", "s"))
  );
  assert.deepEqual(groups.map((group) => group.key), ["spacing", "opacity", "radius"]);
});

test("`no guess` is its own group, is always last, and is never confirmable", () => {
  const groups = groupCandidates(many(40, undefined, "n").concat(many(3, "spacing", "s")));
  assert.equal(groups[groups.length - 1].key, NO_GUESS);
  assert.equal(groups[groups.length - 1].label, "no guess · 40");
  // Nothing to confirm: it gets the set-all control only, and it sorts last because it is the group
  // that genuinely needs reading — even though it is by far the biggest here.
  assert.equal(groups[groups.length - 1].confirmable, false);
  assert.equal(groups[0].confirmable, true);
});

test("the largest guessed group opens by default, never the `no guess` one", () => {
  const groups = groupCandidates(many(40, undefined, "n").concat(many(3, "spacing", "s")));
  assert.equal(defaultOpenGroup(groups), "spacing");
  // With nothing but unguessed rows there is only one thing it can open.
  assert.equal(defaultOpenGroup(groupCandidates(many(4, undefined, "n"))), NO_GUESS);
  assert.equal(defaultOpenGroup([]), null);
});

test("the confirm strip threshold is 20, and 20 itself goes straight through", () => {
  assert.equal(BULK_CONFIRM_THRESHOLD, 20);
  assert.equal(needsConfirmStrip(1), false);
  assert.equal(needsConfirmStrip(20), false);
  assert.equal(needsConfirmStrip(21), true);
  assert.equal(needsConfirmStrip(132), true);
});

test("bulk undo is the inverse map for exactly the ids written, not a wholesale snapshot", () => {
  const candidates = [
    candidate("a", "spacing", "user"),
    candidate("b", "sizing", "default"),
    candidate("c", undefined, "scope"),
    candidate("d", "radius", "user"),
  ];
  const inverse = previousSelections(candidates, ["a", "b", "c"]);
  // A user choice restores to itself; a guess or an auto-detection restores to *no stored choice*,
  // which is what `null` means to the sandbox's handler.
  assert.deepEqual(inverse, { a: "spacing", b: null, c: null });
  // `d` was never written, so it is never touched by the undo.
  assert.equal("d" in inverse, false);
});

test("a user tag with no subtype inverts to `untagged`, which is itself a choice", () => {
  const deliberate = candidate("x", undefined, "user");
  assert.deepEqual(previousSelections([deliberate], ["x"]), { x: "untagged" });
});

test("an id the panel no longer knows about is dropped from the inverse, not guessed at", () => {
  assert.deepEqual(previousSelections([candidate("a", "spacing")], ["a", "gone"]), { a: null });
});

test("the undo toast says what happened, in the user's units", () => {
  assert.equal(bulkUndoMessage(90, "spacing" as SubtypeSelection), "90 set to spacing.");
  assert.equal(bulkUndoMessage(1, "radius" as SubtypeSelection), "1 set to radius.");
  assert.equal(bulkUndoMessage(132, null), "132 types confirmed.");
  assert.equal(bulkUndoMessage(1, null), "1 type confirmed.");
});

// ---------------------------------------------------------------------------
// Gap 13 — the first-run counts (§6)
// ---------------------------------------------------------------------------

const COUNTS = {
  collections: 4,
  modes: 9,
  variables: 612,
  styles: 704,
  tokens: 1316,
  styleTokens: 704,
  flagged: 13,
  partialTokens: 3,
  unconfirmedSubtypes: 132,
};

test("the summary grid bands into what was read and what needs a look", () => {
  const bands = countBands(COUNTS);
  assert.deepEqual(bands.map((band) => band.heading), ["Read from this file", "Needs a look"]);
  assert.deepEqual(
    bands[1].boxes.map((box) => box.label),
    ["Flagged", "Partial", "to confirm"]
  );
});

test("`Unconfirmed` is renamed to `to confirm` — a job of the user's, not a defect state", () => {
  const labels = countBands(COUNTS).flatMap((band) => band.boxes.map((box) => box.label));
  assert.equal(labels.indexOf("Unconfirmed"), -1);
  assert.equal(labels.indexOf("to confirm") !== -1, true);
});

test("§6.4's hard boundary: not one number changes, and none goes missing", () => {
  const boxes = countBands(COUNTS).flatMap((band) => band.boxes);
  const byLabel = new Map(boxes.map((box) => [box.label, box.value]));
  assert.equal(byLabel.get("to confirm"), 132);
  assert.equal(byLabel.get("Flagged"), 13);
  assert.equal(byLabel.get("Partial"), 3);
  assert.equal(byLabel.get("Tokens"), 1316);
  assert.equal(byLabel.get("Variables"), 612);
  // Nine boxes before, nine boxes after. Banding reorders and re-labels; it never suppresses.
  assert.equal(boxes.length, 9);
});

test("absent optional counts render as 0 rather than vanishing from their band", () => {
  const bands = countBands({ collections: 1, modes: 1, variables: 3, tokens: 3, flagged: 0, unconfirmedSubtypes: 0 });
  const byLabel = new Map(bands.flatMap((band) => band.boxes).map((box) => [box.label, box.value]));
  assert.equal(byLabel.get("Styles"), 0);
  assert.equal(byLabel.get("Partial"), 0);
  assert.equal(byLabel.get("from styles"), 0);
});

test("a first push into an empty folder is recognised, so `12 changes` can become `12 files`", () => {
  const absent = (path: string): FileStatus => ({ path, state: "to-push", localSha: "a" });
  assert.equal(
    isFirstPush({
      files: [absent("tokens/a.json"), absent("tokens/b.json")],
      toPush: [absent("tokens/a.json"), absent("tokens/b.json")],
      toPull: [],
      diverged: [],
      clean: false,
    }),
    true
  );
});

test("a push over files that already exist is an ordinary push, whatever else is going on", () => {
  const existing: FileStatus = { path: "tokens/a.json", state: "to-push", localSha: "a", remoteSha: "b" };
  const fresh: FileStatus = { path: "tokens/b.json", state: "to-push", localSha: "c" };
  const status = (toPush: FileStatus[], toPull: FileStatus[] = []): Parameters<typeof isFirstPush>[0] => ({
    files: toPush.concat(toPull),
    toPush,
    toPull,
    diverged: [],
    clean: false,
  });

  // One file that already exists is enough — this is no longer the push that creates the folder.
  assert.equal(isFirstPush(status([fresh, existing])), false);
  // Nothing to push at all is not a first push either.
  assert.equal(isFirstPush(status([])), false);
  // Something to pull means the folder is not empty, whatever the push side looks like.
  assert.equal(isFirstPush(status([fresh], [{ path: "tokens/c.json", state: "to-pull", remoteSha: "d" }])), false);
});

// ---------------------------------------------------------------------------
// Gap 14 — the three-place model (§7)
// ---------------------------------------------------------------------------

test("there are exactly three placements, each highlighting a different place", () => {
  const keys = Object.keys(PLACEMENTS);
  assert.deepEqual(keys, ["import", "tokens", "repo"]);
  const places = keys.map((key) => PLACEMENTS[key as keyof typeof PLACEMENTS].place);
  assert.deepEqual(places, ["figma", "tokenvault", "repo"]);
  // §11: one function with an enum. Three drawings would mean the design was misread — asserted by
  // the strip having one copy table rather than three.
  assert.equal(new Set(places).size, 3);
});

test("each placement names the verb that screen owns", () => {
  assert.equal(PLACEMENTS.import.body.indexOf("Nothing in Figma changes") !== -1, true);
  assert.equal(PLACEMENTS.tokens.body.indexOf("Apply") !== -1, true);
  assert.equal(PLACEMENTS.tokens.body.indexOf("Push") !== -1, true);
  assert.equal(PLACEMENTS.repo.body.indexOf("Push") !== -1, true);
  assert.equal(PLACEMENTS.repo.body.indexOf("Pull") !== -1, true);
});

test("the permanent page says the two things a stranger installs this worrying about", () => {
  assert.equal(NEVER_DOES.length, 2);
  assert.equal(NEVER_DOES[0].indexOf("outside your tokens folder") !== -1, true);
  assert.equal(NEVER_DOES[1].indexOf("without an explicit Apply") !== -1, true);
});

test("the page states the on-device truth, which is the part never said in the panel", () => {
  const text = HOW_IT_WORKS.flatMap((block) => block.lines).join(" ");
  assert.equal(text.indexOf("this device only") !== -1, true);
  assert.equal(text.indexOf("survive a new machine") !== -1, true);
  assert.deepEqual(HOW_IT_WORKS.map((block) => block.heading), [
    "Your Figma file",
    "Tokenvault",
    "Your GitHub repo",
  ]);
});

test("the four verbs are four, and Pull writes neither side", () => {
  assert.deepEqual(VERBS.map(([verb]) => verb), ["Scan", "Apply", "Push", "Pull"]);
  assert.deepEqual(VERBS[3], ["Pull", "writes neither"]);
});

test("§7.3's banned words appear in no user-facing copy this phase added", () => {
  // *overlay*, *baseline* and *DTCG* are internal vocabulary, and *drift* is already banned
  // panel-wide by `apply-and-drift.md` §3. None of them has leaked into user-facing copy yet, and
  // none gets to start on the four surfaces written for a stranger.
  const strings: string[] = [
    ...Object.values(PLACEMENTS).flatMap((copy) => [copy.lead, copy.body]),
    ...HOW_IT_WORKS.flatMap((block) => [block.heading, ...block.lines]),
    ...VERBS.flatMap(([verb, meaning]) => [verb, meaning]),
    ...NEVER_DOES,
    ...patChecklist("acme/tokens"),
    patChecklistText("acme/tokens"),
    tokenVerdict(analyzeToken({ permissions: { push: false } }), "acme/tokens").headline,
    ...tokenVerdict(analyzeToken({ permissions: { push: false } }), "acme/tokens").detail,
    ...tokenVerdict(analyzeToken({}), "acme/tokens").detail,
  ];
  for (const line of strings) {
    for (const banned of ["overlay", "baseline", "DTCG", "drift"]) {
      assert.equal(
        line.toLowerCase().indexOf(banned.toLowerCase()),
        -1,
        `"${line}" uses the banned word "${banned}"`
      );
    }
  }
});

test("the strip is one component, rendered into three empty states", () => {
  // §11 again, this time asserted structurally: only `threePlace.ts` may define the drawing, and
  // the three screens that show it must all import it rather than growing their own.
  const strip = readFileSync(join(process.cwd(), "src/ui/threePlace.ts"), "utf8");
  assert.equal((strip.match(/function diagram\s*\(/g) ?? []).length, 1);
  for (const name of ["importView.ts", "tokens.ts", "repo.ts"]) {
    const text = readFileSync(join(process.cwd(), "src/ui", name), "utf8");
    assert.equal(/threePlaceStrip\(/.test(text), true, `${name} must use the shared strip`);
  }
});

test("nothing dismisses the strip — it is outgrown, not skipped", () => {
  // §7.1: no dismissal flag in storage, no `Skip`, no `Don't show this again`. The strip lives
  // inside an empty state, so it is gone the moment that screen has content and comes back
  // correctly for a fresh Figma file six months later.
  // Comment-stripped, so the design argument *for* the rule isn't mistaken for a breach of it.
  const strip = readFileSync(join(process.cwd(), "src/ui/threePlace.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/dismiss|Skip|show this again|clientStorage|localStorage/i.test(strip), false);
});
