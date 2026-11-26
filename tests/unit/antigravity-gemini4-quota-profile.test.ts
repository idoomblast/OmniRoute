/**
 * Gemini 4 Hydrogen tier ids are served by the cli client identity only: with the
 * ide profile `:fetchAvailableModels` and `:retrieveUserQuota` advertise just
 * `gemini-4-hydrogen-sonar`, while the four tier ids
 * (`gemini-4-hydrogen-{low,medium,high,xhigh}`) appear only for cli. OmniRoute
 * executes those tier ids with the cli profile regardless of the connection's
 * setting, so Provider Limits must merge the cli quota buckets into the ide
 * reading instead of dropping every Hydrogen tier the account can call.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { getAntigravityUsage } = await import("../../open-sse/services/usage/antigravity.ts");

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

type Call = { url: string; userAgent: string };
type UsageWithQuotas = {
  quotas: Record<string, { quotaSource?: string; remainingPercentage?: number }>;
};

function installFetch(options: {
  cliQuotaFails?: boolean;
  quotaBuckets: (profile: "ide" | "cli") => unknown[];
}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const userAgent = headers.get("user-agent") || "";
    calls.push({ url, userAgent });

    if (url.includes(":loadCodeAssist")) {
      return Response.json({});
    }
    if (url.includes(":retrieveUserQuotaSummary")) {
      return Response.json({ buckets: [] });
    }
    if (url.includes(":retrieveUserQuota")) {
      const profile = userAgent.includes("/cli/") ? "cli" : "ide";
      if (profile === "cli" && options.cliQuotaFails) {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return Response.json({ buckets: options.quotaBuckets(profile) });
    }
    if (url.includes(":fetchAvailableModels")) {
      return Response.json({
        models: {
          "gemini-3.8-flash-high": {
            quotaInfo: {
              remainingFraction: 1,
              resetTime: "2026-11-27T01:43:41Z",
            },
          },
          "gemini-4-hydrogen-sonar": {
            quotaInfo: {
              remainingFraction: 1,
              resetTime: "2026-11-27T01:43:41Z",
            },
          },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

function bucket(modelId: string, remainingFraction: number) {
  return { modelId, remainingFraction, resetTime: "2026-11-27T01:43:41Z" };
}

test("ide connection merges the cli quota buckets so Hydrogen tiers appear", async () => {
  const calls = installFetch({
    quotaBuckets: (profile) =>
      profile === "cli"
        ? [
            bucket("gemini-3.8-flash-high", 0.75),
            bucket("gemini-4-hydrogen-low", 0.5),
            bucket("gemini-4-hydrogen-medium", 0.5),
            bucket("gemini-4-hydrogen-high", 0.25),
            bucket("gemini-4-hydrogen-xhigh", 0.25),
          ]
        : [bucket("gemini-3.8-flash-high", 0.75)],
  });

  try {
    const usage = await getAntigravityUsage(
      "antigravity",
      "token-hydrogen-merge-0001",
      { clientProfile: "ide", plan: "Pro" },
      "project-merge-1",
      "conn-merge-1",
      { forceRefresh: true }
    );

    assert.ok(usage && "quotas" in usage, "usage should carry quotas");
    const quotas = (usage as UsageWithQuotas).quotas;
    for (const tier of ["low", "medium", "high", "xhigh"]) {
      const quota = quotas[`gemini-4-hydrogen-${tier}`];
      assert.ok(quota, `missing gemini-4-hydrogen-${tier}`);
      assert.equal(quota.quotaSource, "retrieveUserQuota");
    }
    assert.equal(quotas["gemini-4-hydrogen-xhigh"].remainingPercentage, 25);
    // The base ide bucket is preserved, not overwritten by the cli reading (75 here).
    assert.equal(quotas["gemini-3.8-flash-high"].remainingPercentage, 75);

    const quotaCalls = calls.filter(
      (call) => call.url.includes(":retrieveUserQuota") && !call.url.includes("QuotaSummary")
    );
    assert.equal(
      quotaCalls.filter((call) => call.userAgent.includes("/cli/")).length,
      1,
      "cli retrieveUserQuota must be requested once"
    );
    assert.equal(
      quotaCalls.filter((call) => call.userAgent.includes("/ide/")).length,
      1,
      "primary retrieveUserQuota must still use the connection's ide profile"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cli connection does not fetch the cli quota profile twice", async () => {
  const calls = installFetch({
    quotaBuckets: () => [bucket("gemini-4-hydrogen-xhigh", 0.5)],
  });

  try {
    const usage = await getAntigravityUsage(
      "antigravity",
      "token-hydrogen-merge-0002",
      { clientProfile: "cli", plan: "Pro" },
      "project-merge-2",
      "conn-merge-2",
      { forceRefresh: true }
    );

    assert.ok(usage && "quotas" in usage, "usage should carry quotas");
    assert.ok((usage as UsageWithQuotas).quotas["gemini-4-hydrogen-xhigh"]);
    const quotaCalls = calls.filter(
      (call) => call.url.includes(":retrieveUserQuota") && !call.url.includes("QuotaSummary")
    );
    assert.equal(quotaCalls.length, 1, "cli primary must not be duplicated");
    assert.ok(quotaCalls[0].userAgent.includes("/cli/"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed cli quota fetch leaves the ide reading intact", async () => {
  installFetch({
    cliQuotaFails: true,
    quotaBuckets: () => [bucket("gemini-3.8-flash-high", 0.75)],
  });

  try {
    const usage = await getAntigravityUsage(
      "antigravity",
      "token-hydrogen-merge-0003",
      { clientProfile: "ide", plan: "Pro" },
      "project-merge-3",
      "conn-merge-3",
      { forceRefresh: true }
    );

    assert.ok(usage && "quotas" in usage, "usage should carry quotas");
    const quotas = (usage as UsageWithQuotas).quotas;
    assert.equal(quotas["gemini-3.8-flash-high"].remainingPercentage, 75);
    assert.equal(
      quotas["gemini-4-hydrogen-xhigh"],
      undefined,
      "no Hydrogen tier when the cli quota fetch fails"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
