// Push fan-out across N repos — ADR-0008 §4, §6, §7.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fanoutPush, summarizeFanout, type FanoutInput } from "../src/git/fanout";
import type { PushBlock } from "../src/git/pushGate";
import type { GitFailure } from "../src/git/types";

const BLOCK: PushBlock = {
  kind: "routing-dangling-reference",
  reason: "cross-repo",
  message: "semantic.text references abc.black, which a routing rule keeps out of this repo.",
  connectionId: "c_web",
};

function input(overrides: Partial<FanoutInput> = {}): FanoutInput {
  return {
    connectionIds: ["c_web", "c_android", "c_ios"],
    blocks: new Map(),
    push: async (id) => ({ commitSha: `sha-${id}`, url: `https://github.com/${id}`, files: 2 }),
    describe: (error): GitFailure => ({ kind: "unauthorized", message: String(error) }),
    ...overrides,
  };
}

test("each repo gets its own commit — a fan-out is N commits, not one", () => {
  return fanoutPush(input()).then((result) => {
    assert.deepEqual(result.results.map((item) => item.commitSha), [
      "sha-c_web",
      "sha-c_android",
      "sha-c_ios",
    ]);
    assert.equal(result.committed, 3);
  });
});

test("one repo failing does not stop the next", async () => {
  const attempted: string[] = [];
  const result = await fanoutPush(
    input({
      push: async (id) => {
        attempted.push(id);
        if (id === "c_android") throw new Error("401");
        return { commitSha: `sha-${id}`, url: "u", files: 1 };
      },
    })
  );

  assert.deepEqual(attempted, ["c_web", "c_android", "c_ios"]);
  assert.deepEqual(result.results.map((item) => item.outcome), ["committed", "failed", "committed"]);
  assert.equal(result.results[1].failure?.kind, "unauthorized");
});

test("a blocked repo is not attempted, and the others still push", async () => {
  const attempted: string[] = [];
  const result = await fanoutPush(
    input({
      blocks: new Map([["c_web", [BLOCK]]]),
      push: async (id) => {
        attempted.push(id);
        return { commitSha: `sha-${id}`, url: "u", files: 1 };
      },
    })
  );

  assert.deepEqual(attempted, ["c_android", "c_ios"]);
  assert.equal(result.results[0].outcome, "blocked");
  assert.deepEqual(result.results[0].blocks, [BLOCK]);
});

test("an unresolvable local tree blocks every repo, and nothing is attempted", async () => {
  // Amendment 3 §A: the breakage is in the tree itself and is identical in every projection.
  let attempts = 0;
  const result = await fanoutPush(
    input({
      globalBlocks: [{ kind: "unresolved-reference", reason: "unresolved-reference", message: "…" }],
      push: async () => {
        attempts += 1;
        return { commitSha: "x", url: "u", files: 1 };
      },
    })
  );

  assert.equal(attempts, 0);
  assert.equal(result.committed, 0);
  assert.deepEqual(result.results.map((item) => item.outcome), ["blocked", "blocked", "blocked"]);
});

test("retry is offered for a failure and withheld for a block", async () => {
  // Retrying a blocked repo changes nothing until the rules or the tree do, and a retry button
  // that cannot work teaches the user to distrust it.
  const result = await fanoutPush(
    input({
      blocks: new Map([["c_web", [BLOCK]]]),
      push: async (id) => {
        if (id === "c_android") throw new Error("500");
        return { commitSha: "x", url: "u", files: 1 };
      },
    })
  );

  assert.deepEqual(result.retryable, ["c_android"]);
});

test("the summary is a list, never a single green tick", async () => {
  const result = await fanoutPush(
    input({
      blocks: new Map([["c_web", [BLOCK]]]),
      push: async (id) => {
        if (id === "c_android") throw new Error("500");
        return { commitSha: "x", url: "u", files: 1 };
      },
    })
  );

  assert.equal(summarizeFanout(result), "Pushed to 1 of 3 repos · 1 blocked · 1 failed");
});

test("the degenerate one-repo case reads exactly as ADR-0006's push did", async () => {
  const result = await fanoutPush(input({ connectionIds: ["c_default"] }));
  assert.equal(summarizeFanout(result), "Pushed to 1 of 1 repo");
  assert.equal(result.results.length, 1);
});
