// The rate-limit headers, and what "unknown" has to mean — ADR-0006 §10.
//
// `api.ts` is the codebase's one impure edge, so almost everything about it is asserted by source
// inspection in `gitInvariant.test.ts` rather than exercised. The header parse is the exception:
// it is arithmetic on strings a server controls, and getting it wrong is silent. A malformed
// `x-ratelimit-remaining` used to become `NaN`, which reads as "plenty of budget left" to every
// comparison it meets — so the warning went missing at exactly the moment it was needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/git/api";

function withFetch(headers: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ name: "main" }]), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    })) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("a numeric budget header is reported as the number it is", async () => {
  await withFetch(
    { "x-ratelimit-remaining": "4321", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1780000000" },
    async () => {
      const client = createClient({ owner: "o", repo: "r", token: "t" });
      await client.getBranches();
      assert.deepEqual(client.rateLimit(), { remaining: 4321, limit: 5000, reset: 1780000000 });
    }
  );
});

test("a malformed budget header is unknown, not plenty", async () => {
  await withFetch({ "x-ratelimit-remaining": "not-a-number" }, async () => {
    const client = createClient({ owner: "o", repo: "r", token: "t" });
    await client.getBranches();
    // `null`, not `NaN`: the panel says it doesn't know rather than implying a full hour's budget.
    assert.equal(client.rateLimit()?.remaining, null);
    // The other two still fall back to their defaults rather than propagating the same problem.
    assert.equal(client.rateLimit()?.limit, 5000);
    assert.equal(client.rateLimit()?.reset, 0);
  });
});

test("no budget header at all leaves the panel with nothing to show", async () => {
  await withFetch({}, async () => {
    const client = createClient({ owner: "o", repo: "r", token: "t" });
    await client.getBranches();
    assert.equal(client.rateLimit(), null);
  });
});
