// N connections, the shared PAT and its per-connection override — ADR-0008 §1, §2.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ENABLED_CONNECTIONS,
  atConnectionCap,
  connectionFromSettings,
  connectionLabel,
  connectionSyncKey,
  describeCredential,
  enabledConnections,
  orphanedPatKeys,
  parseMultiSettings,
  patKeyFor,
  settingsOfConnection,
  type Connection,
  type MultiRepoSettings,
} from "../src/git/connections";
import { PAT_KEY } from "../src/git/state";

function connection(id: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id,
    owner: "thebluesman",
    repo: id,
    branch: "main",
    tokensDir: "tokens",
    enabled: true,
    auth: { mode: "shared" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §1 — the connection list
// ---------------------------------------------------------------------------

test("a Phase 6 settings blob reads as one connection rather than as nothing", () => {
  // ADR-0008 extends ADR-0006 rather than resetting it: a user who already connected a repo should
  // not have to connect it again.
  const settings = parseMultiSettings({
    owner: "thebluesman",
    repo: "folio-tokens",
    branch: "release",
    tokensDir: "design/",
    patLastFour: "9f2a",
  });

  assert.equal(settings.connections.length, 1);
  assert.deepEqual(settings.connections[0], {
    id: "c_default",
    owner: "thebluesman",
    repo: "folio-tokens",
    branch: "release",
    tokensDir: "design",
    enabled: true,
    auth: { mode: "shared" },
  });
  assert.equal(settings.patLastFour, "9f2a");
});

test("every connection carries its own owner, repo, branch, tokensDir and enabled flag", () => {
  const settings = parseMultiSettings({
    connections: [
      { id: "c_web", owner: "o", repo: "web", branch: "main", tokensDir: "tokens" },
      { id: "c_android", owner: "o2", repo: "android", branch: "develop", tokensDir: "design/tokens/", enabled: false },
    ],
  });

  assert.deepEqual(settings.connections.map((item) => item.branch), ["main", "develop"]);
  assert.deepEqual(settings.connections.map((item) => item.tokensDir), ["tokens", "design/tokens"]);
  assert.deepEqual(settings.connections.map((item) => item.enabled), [true, false]);
  // No connection is privileged — there is no `primary` anywhere in the model (§1).
  assert.equal(JSON.stringify(settings).indexOf("primary"), -1);
});

test("an absent enabled flag means enabled — a missing key must never stop pushing to a repo", () => {
  const settings = parseMultiSettings({ connections: [{ id: "c", owner: "o", repo: "r" }] });
  assert.equal(settings.connections[0].enabled, true);
  assert.equal(settings.connections[0].branch, "main");
});

test("a duplicate id is dropped rather than allowed to shadow the first", () => {
  // Two connections sharing an id would share one sync record and one override key.
  const settings = parseMultiSettings({
    connections: [
      { id: "c", owner: "o", repo: "one" },
      { id: "c", owner: "o", repo: "two" },
    ],
  });
  assert.equal(settings.connections.length, 1);
  assert.equal(settings.connections[0].repo, "one");
});

test("the fan-out is capped at ten enabled connections", () => {
  const many: MultiRepoSettings = {
    connections: Array.from({ length: 12 }, (_, i) => connection(`c${i}`)),
    routingRules: [],
  };
  assert.equal(MAX_ENABLED_CONNECTIONS, 10);
  assert.equal(enabledConnections(many).length, 10);
  assert.equal(atConnectionCap(many), true);
  assert.equal(atConnectionCap({ connections: [connection("c1")], routingRules: [] }), false);
});

test("a disabled connection is not in the fan-out", () => {
  const settings: MultiRepoSettings = {
    connections: [connection("c1"), connection("c2", { enabled: false })],
    routingRules: [],
  };
  assert.deepEqual(enabledConnections(settings).map((item) => item.id), ["c1"]);
});

// ---------------------------------------------------------------------------
// §2 — credentials
// ---------------------------------------------------------------------------

test("a connection uses its own PAT if mode is own, and the shared one otherwise", () => {
  // One rule, no ambiguity — and a `shared` connection has no key of its own at all, because an
  // orphaned credential is a secret nobody can see to revoke.
  assert.equal(patKeyFor(connection("c_web")), PAT_KEY);
  assert.equal(patKeyFor(connection("c_org", { auth: { mode: "own", patLastFour: "1234" } })), `${PAT_KEY}:c_org`);
});

test("switching a connection back to shared, or deleting it, orphans its override key", () => {
  const before: MultiRepoSettings = {
    connections: [
      connection("c_org", { auth: { mode: "own", patLastFour: "1234" } }),
      connection("c_gone", { auth: { mode: "own" } }),
      connection("c_web"),
    ],
    routingRules: [],
  };
  const after: MultiRepoSettings = {
    connections: [connection("c_org"), connection("c_web")],
    routingRules: [],
  };

  assert.deepEqual(orphanedPatKeys(before, after), [`${PAT_KEY}:c_org`, `${PAT_KEY}:c_gone`]);
  // Rotating the shared token touches nothing: it is a different key, which is the whole point.
  assert.deepEqual(orphanedPatKeys(before, before), []);
});

test("a failure can say which token it used, because the two are told apart", () => {
  // ADR-0006 §10 requires 401 and 404 to be named rather than guessed; with two possible
  // credentials, "GitHub rejected the token" has to say *which*.
  assert.equal(describeCredential(connection("c_web"), "9f2a"), "the shared token (…9f2a)");
  assert.equal(
    describeCredential(connection("c_org", { auth: { mode: "own", patLastFour: "1234" } }), "9f2a"),
    "this repo's own token (…1234)"
  );
  // Never the token itself, and never more of it than four characters.
  assert.equal(describeCredential(connection("c_web")).indexOf("…"), -1);
});

// ---------------------------------------------------------------------------
// §6 — per-repo state
// ---------------------------------------------------------------------------

test("sync state is keyed per (file, connection), so repos never share a base", () => {
  assert.equal(connectionSyncKey("file-1", "c_web"), "tokenvault:sync:file-1:c_web");
  assert.notEqual(connectionSyncKey("file-1", "c_web"), connectionSyncKey("file-1", "c_android"));
  assert.notEqual(connectionSyncKey("file-1", "c_web"), connectionSyncKey("file-2", "c_web"));
});

test("a connection converts to and from ADR-0006's single-repo settings without losing anything", () => {
  const settings = { owner: "o", repo: "r", branch: "develop", tokensDir: "design", patLastFour: "9f2a" };
  const round = settingsOfConnection(connectionFromSettings(settings), "9f2a");
  assert.deepEqual(round, settings);
  // An `own`-mode connection reports its own last four, not the shared one.
  assert.equal(
    settingsOfConnection(connection("c", { auth: { mode: "own", patLastFour: "1234" } }), "9f2a").patLastFour,
    "1234"
  );
});

test("a repo names itself the way a per-repo block has to name it", () => {
  assert.equal(connectionLabel(connection("c_web", { repo: "web-tokens", branch: "develop" })), "thebluesman/web-tokens@develop");
});
