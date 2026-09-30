import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isQoderPatToken,
  parseQoderJobTokenResponse,
  exchangeQoderJobToken,
  resolveQoderJobToken,
  __clearQoderJobTokenCache,
} from "../../open-sse/services/qoderCli.ts";

// Helper: create a mock fetch that returns a given JSON body
function mockFetchOk(body: unknown): (input: string, init?: Record<string, unknown>) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function mockFetchFail(status: number): (input: string, init?: Record<string, unknown>) => Promise<Response> {
  return async () => new Response("error", { status });
}

function mockFetchThrow(): (input: string, init?: Record<string, unknown>) => Promise<Response> {
  return async () => {
    throw new Error("network failure");
  };
}

// --- isQoderPatToken ---

test("isQoderPatToken: returns true for pt-* tokens", () => {
  assert.equal(isQoderPatToken("pt-abc123"), true);
  assert.equal(isQoderPatToken("pt-"), true);
});

test("isQoderPatToken: returns false for non-pt tokens", () => {
  assert.equal(isQoderPatToken("jt-abc123"), false);
  assert.equal(isQoderPatToken("abc123"), false);
  assert.equal(isQoderPatToken(""), false);
  assert.equal(isQoderPatToken("  pt-abc  "), true); // trimmed
});

// --- parseQoderJobTokenResponse ---

test("parseQoderJobTokenResponse: extracts jt-* from root.job_token", () => {
  const result = parseQoderJobTokenResponse({ job_token: "jt-xyz", expires_in: 3600 });
  assert.equal(result?.jobToken, "jt-xyz");
  assert.equal(result?.expiresInMs, 3600 * 1000);
});

test("parseQoderJobTokenResponse: extracts jt-* from data.jobToken", () => {
  const result = parseQoderJobTokenResponse({ data: { jobToken: "jt-from-data", expires_in: 7200 } });
  assert.equal(result?.jobToken, "jt-from-data");
  assert.equal(result?.expiresInMs, 7200 * 1000);
});

test("parseQoderJobTokenResponse: returns null when no jt-* found", () => {
  assert.equal(parseQoderJobTokenResponse({ job_token: "not-a-jt-token" }), null);
  assert.equal(parseQoderJobTokenResponse({}), null);
  assert.equal(parseQoderJobTokenResponse(null), null);
  assert.equal(parseQoderJobTokenResponse("string"), null);
});

test("parseQoderJobTokenResponse: falls back to default TTL when expires_in missing", () => {
  const result = parseQoderJobTokenResponse({ job_token: "jt-test" });
  assert.equal(result?.jobToken, "jt-test");
  assert.ok(result && result.expiresInMs > 0);
  // Should be at least the minimum TTL
  assert.ok(result && result.expiresInMs >= 60_000);
});

// --- exchangeQoderJobToken ---

test("exchangeQoderJobToken: returns job token on success", async () => {
  const fetchImpl = mockFetchOk({ data: { job_token: "jt-exchanged", expires_in: 1800 } });
  const result = await exchangeQoderJobToken("pt-test", { fetchImpl });
  assert.equal(result?.jobToken, "jt-exchanged");
  assert.equal(result?.expiresInMs, 1800 * 1000);
});

test("exchangeQoderJobToken: returns null on HTTP error", async () => {
  const fetchImpl = mockFetchFail(403);
  const result = await exchangeQoderJobToken("pt-test", { fetchImpl });
  assert.equal(result, null);
});

test("exchangeQoderJobToken: returns null on network throw", async () => {
  const fetchImpl = mockFetchThrow();
  const result = await exchangeQoderJobToken("pt-test", { fetchImpl });
  assert.equal(result, null);
});

test("exchangeQoderJobToken: returns null on invalid JSON", async () => {
  const fetchImpl = async () =>
    new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } });
  const result = await exchangeQoderJobToken("pt-test", { fetchImpl });
  assert.equal(result, null);
});

// --- resolveQoderJobToken ---

test("resolveQoderJobToken: returns non-PAT token unchanged", async () => {
  __clearQoderJobTokenCache();
  const result = await resolveQoderJobToken("jt-already");
  assert.equal(result, "jt-already");
});

test("resolveQoderJobToken: returns non-PAT token unchanged for arbitrary string", async () => {
  __clearQoderJobTokenCache();
  const result = await resolveQoderJobToken("some-random-key");
  assert.equal(result, "some-random-key");
});

test("resolveQoderJobToken: exchanges PAT and caches result", async () => {
  __clearQoderJobTokenCache();
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return new Response(JSON.stringify({ job_token: "jt-cached", expires_in: 9999 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const now = 1000;
  const a = await resolveQoderJobToken("pt-cache", { fetchImpl, now });
  const b = await resolveQoderJobToken("pt-cache", { fetchImpl, now: now + 100 });
  assert.equal(a, "jt-cached");
  assert.equal(b, "jt-cached");
  // Second call should use cache — fetch only called once
  assert.equal(callCount, 1);
});

test("resolveQoderJobToken: falls back to PAT on exchange failure", async () => {
  __clearQoderJobTokenCache();
  const fetchImpl = mockFetchFail(500);
  const result = await resolveQoderJobToken("pt-fallback", { fetchImpl });
  assert.equal(result, "pt-fallback");
});

test("resolveQoderJobToken: falls back to PAT on network throw", async () => {
  __clearQoderJobTokenCache();
  const fetchImpl = mockFetchThrow();
  const result = await resolveQoderJobToken("pt-throw", { fetchImpl });
  assert.equal(result, "pt-throw");
});

test("resolveQoderJobToken: deduplicates concurrent exchanges", async () => {
  __clearQoderJobTokenCache();
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    // Small delay to simulate network latency
    await new Promise((r) => setTimeout(r, 10));
    return new Response(JSON.stringify({ job_token: "jt-dedup", expires_in: 9999 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  // Fire two concurrent resolves for the same PAT
  const [a, b] = await Promise.all([
    resolveQoderJobToken("pt-dedup", { fetchImpl }),
    resolveQoderJobToken("pt-dedup", { fetchImpl }),
  ]);
  assert.equal(a, "jt-dedup");
  assert.equal(b, "jt-dedup");
  // Only one fetch call should have been made
  assert.equal(callCount, 1);
});

test("resolveQoderJobToken: throws on already-aborted signal", async () => {
  __clearQoderJobTokenCache();
  const controller = new AbortController();
  const fetchImpl = async (_input: string, init?: Record<string, unknown>) => {
    return new Response(JSON.stringify({ job_token: "jt-never", expires_in: 9999 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  controller.abort();
  // With an already-aborted signal, the waiter should reject immediately
  // (per-caller abort does not poison the shared exchange, but does reject
  // the individual waiter).
  await assert.rejects(
    resolveQoderJobToken("pt-abort", { fetchImpl, signal: controller.signal }),
    /aborted/i
  );
});
