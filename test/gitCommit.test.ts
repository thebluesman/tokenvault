// The commit call sequence and the generated message — ADR-0006 §8, UX §7.3.
//
// `commit.ts` decides *what* the four-call sequence contains and `api.ts` performs it. Splitting
// them is what makes "does a push of these three files send the right tree?" a unit test rather
// than a thing you find out by pushing.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { FileStatus } from "../src/git/types";
import {
  buildCommit,
  composeMessage,
  generateCommitMessage,
  treeEntries,
} from "../src/git/commit";

function file(path: string, state: FileStatus["state"] = "to-push"): FileStatus {
  return { path, state };
}

const local = new Map([
  ["tokens/theme/light.json", '{"a":1}'],
  ["tokens/theme/dark.json", '{"b":2}'],
  ["tokens/$manifest.json", '{"m":1}'],
]);

test("a commit uploads a blob per changed file, in path order", () => {
  const request = buildCommit({
    selected: [file("tokens/theme/light.json"), file("tokens/$manifest.json")],
    local,
    message: "m",
    parent: "p",
    baseTree: "t",
  });
  assert.deepEqual(request.blobs.map((blob) => blob.path), [
    "tokens/$manifest.json",
    "tokens/theme/light.json",
  ]);
  assert.equal(request.parent, "p");
  assert.equal(request.baseTree, "t");
});

test("a file the local tree no longer has becomes a deletion, not an empty blob", () => {
  const request = buildCommit({
    selected: [file("tokens/theme/gone.json")],
    local,
    message: "m",
    parent: "p",
    baseTree: "t",
  });
  assert.deepEqual(request.blobs, []);
  assert.deepEqual(request.deletions, ["tokens/theme/gone.json"]);
  assert.deepEqual(treeEntries(request, {}), [
    { path: "tokens/theme/gone.json", mode: "100644", type: "blob", sha: null },
  ]);
});

test("a diverged file is refused one layer below the screen that unchecked it", () => {
  // §6 refuses it and the Review & push screen renders it blocked — but "the UI wouldn't do that"
  // is not a guarantee, and a diverged file pushed by accident is a silent overwrite of somebody
  // else's commit.
  assert.throws(
    () =>
      buildCommit({
        selected: [file("tokens/theme/light.json", "diverged")],
        local,
        message: "m",
        parent: "p",
        baseTree: "t",
      }),
    /diverged/
  );
});

test("the tree payload refuses to be built with a blob SHA missing", () => {
  const request = buildCommit({
    selected: [file("tokens/theme/light.json")],
    local,
    message: "m",
    parent: "p",
    baseTree: "t",
  });
  assert.throws(() => treeEntries(request, {}), /No blob SHA/);
  assert.deepEqual(treeEntries(request, { "tokens/theme/light.json": "abc" }), [
    { path: "tokens/theme/light.json", mode: "100644", type: "blob", sha: "abc" },
  ]);
});

// ---------------------------------------------------------------------------
// The message — UX §7.3
// ---------------------------------------------------------------------------

test("the summary names the sets touched, not the file count", () => {
  const message = generateCommitMessage([
    { path: "tokens/theme/light.json", set: "Theme / Light", changed: 6, added: 0, removed: 0 },
    { path: "tokens/theme/dark.json", set: "Theme / Dark", changed: 1, added: 0, removed: 0 },
  ]);
  // Collection names, not mode names: Light and Dark in one commit is a change to *Theme*.
  assert.equal(message.summary, "Update Theme tokens");
  assert.equal(message.body, "6 values in Theme / Light; 1 value in Theme / Dark.");
});

test("two collections are named, three or more collapse to a count", () => {
  const two = generateCommitMessage([
    { path: "a", set: "Theme / Light", changed: 1, added: 0, removed: 0 },
    { path: "b", set: "Spacing / Default", changed: 1, added: 0, removed: 0 },
  ]);
  assert.equal(two.summary, "Update Theme and Spacing tokens");

  const many = generateCommitMessage([
    { path: "a", set: "Theme / Light", changed: 1, added: 0, removed: 0 },
    { path: "b", set: "Spacing / Default", changed: 1, added: 0, removed: 0 },
    { path: "c", set: "Type / Default", changed: 1, added: 0, removed: 0 },
  ]);
  // A 50-character summary is the budget: a seven-set commit should say how many, not recite them —
  // and the collapsed form already carries the noun, so it must not gain a second one.
  assert.equal(many.summary, "Update 3 token sets");
});

test("a commit that only adds is worded as an addition", () => {
  const message = generateCommitMessage([
    { path: "a", set: "Theme / Dark", changed: 0, added: 12, removed: 0 },
  ]);
  assert.equal(message.summary, "Add Theme");
  assert.equal(message.body, "12 added in Theme / Dark.");
});

test("a manifest-only commit still says something", () => {
  const message = generateCommitMessage([
    { path: "tokens/$manifest.json", changed: 0, added: 0, removed: 0, manifest: true },
  ]);
  assert.equal(message.summary, "Update token sets");
  assert.equal(message.body, "manifest updated.");
});

test("no byline, no emoji, no trailer", () => {
  const message = generateCommitMessage([
    { path: "a", set: "Theme / Light", changed: 2, added: 0, removed: 0 },
  ]);
  const text = composeMessage(message, message);
  assert.equal(/Tokenvault|Co-Authored|🤖|Generated with/.test(text), false);
});

test("an emptied summary restores the generated one rather than blocking the button", () => {
  const generated = { summary: "Update Theme tokens", body: "6 values in Theme / Light." };
  assert.equal(
    composeMessage({ summary: "   ", body: "" }, generated),
    "Update Theme tokens"
  );
  assert.equal(
    composeMessage({ summary: "Retone the reds", body: "Warmer accent." }, generated),
    "Retone the reds\n\nWarmer accent."
  );
});
