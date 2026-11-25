// Reviewer gate round 1, blocking finding 2 (F2): the Google One AI credits retry
// reapplied the CONNECTION profile instead of the effective (tier-forced) one, so a
// tier request that failed with a quota 429 was retried over the ide identity and
// returned 404 to the caller. This pins the profile on BOTH requests.
import test from "node:test";
import assert from "node:assert/strict";

import { tryCreditsRetry } from "../../open-sse/executors/antigravity/executeAttempt.ts";

const TIER_MODEL = "gemini-4-hydrogen-xhigh";

function makeBody(model: string): Record<string, unknown> {
  return {
    project: "project-1",
    model,
    request: {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    },
    userAgent: "antigravity",
  };
}

test("F2: the credits retry keeps the cli fingerprint for a Gemini 4 tier id", async () => {
  const sentUserAgents: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sentUserAgents.push(headers.get("User-Agent") ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const body = makeBody(TIER_MODEL);
    // An ide-defaulted connection: without the fix the retry reverts to ide.
    const credentials = { accessToken: "tok", providerSpecificData: { clientProfile: "ide" } };

    const result = await tryCreditsRetry(
      "antigravity",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      { "Content-Type": "application/json" },
      body,
      credentials,
      true,
      null,
      { debug() {}, info() {}, warn() {}, error() {} },
      "conn-1",
      () => {}
    );

    assert.ok(result, "credits retry must produce a result on a 200");
    assert.equal(sentUserAgents.length, 1, "exactly one credits request");
    assert.match(
      sentUserAgents[0],
      /^antigravity\/cli\/1\.2\.8 /,
      `credits retry must send the cli identity, got: ${sentUserAgents[0]}`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("F2 control: a non-tier model keeps the connection identity on the credits retry", async () => {
  const sentUserAgents: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentUserAgents.push(new Headers(init?.headers).get("User-Agent") ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const credentials = { accessToken: "tok", providerSpecificData: { clientProfile: "ide" } };
    await tryCreditsRetry(
      "antigravity",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      { "Content-Type": "application/json" },
      makeBody("gemini-3.8-flash-high"),
      credentials,
      true,
      null,
      { debug() {}, info() {}, warn() {}, error() {} },
      "conn-1",
      () => {}
    );

    assert.equal(sentUserAgents.length, 1);
    assert.doesNotMatch(
      sentUserAgents[0],
      /antigravity\/cli\//,
      `non-tier model must keep the ide identity, got: ${sentUserAgents[0]}`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
