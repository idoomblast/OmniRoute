import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchKenariQuotaDetailed,
  normalizeKenariCookie,
  parseKenariSubscription,
  registerKenariQuotaFetcher,
  resolveKenariSessionCookie,
} from "../../open-sse/services/kenariQuotaFetcher.ts";
import { getQuotaFetcher, getQuotaWindows } from "../../open-sse/services/quotaPreflight.ts";
import { getKenariUsage } from "../../open-sse/services/usage/kenari.ts";

// Real shape captured 2026-11-26 (plan Kreator): used_frac is 0..1, money is
// micro-IDR, window_5h is null, free_tier.daily_limit is 0 (not applicable).
const KREATOR_RESPONSE = {
  plan_id: "plan-kreator-v3",
  plan_name: "Kreator",
  plan_status: "active",
  plan_live: true,
  window_week: { used_frac: 0.1824, resets_in_secs: 463578 },
  window_month: { used_frac: 0.0456, resets_in_secs: 2450778 },
  window_5h: null,
  free_tier: { daily_used: 69, daily_limit: 0, reset_in_secs: 70039 },
  weekly_reset: {
    available: true,
    week_left_micro_idr: 122_639_813_000_000,
    month_left_micro_idr: 572_639_813_000_000,
  },
  web_search: { allowance: 100, used_today: 0 },
  near_limit: false,
  auto_renew: true,
};

function connectionWithCookie(cookie = "session-value") {
  return { providerSpecificData: { kenariSessionCookie: cookie } };
}

function mockFetch(response: { status?: number; body?: unknown; reject?: boolean }) {
  return async () => {
    if (response.reject) throw new Error("network down");
    return {
      status: response.status ?? 200,
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      json: async () => response.body,
    } as Response;
  };
}

test("parses the Kreator payload: percent windows, null 5h, micro-IDR money", () => {
  const now = Date.parse("2026-11-26T00:00:00.000Z");
  const quota = parseKenariSubscription(KREATOR_RESPONSE, now);
  assert.ok(quota);

  assert.equal(quota.planName, "Kreator");
  assert.equal(quota.planStatus, "active");
  assert.equal(quota.percentUsed, 0.1824);
  assert.equal(quota.used, 18);
  assert.equal(quota.resetAt, new Date(now + 463578 * 1000).toISOString());

  assert.deepEqual(Object.keys(quota.windowsDetail), ["weekly", "monthly"]);
  assert.equal(quota.windowsDetail.weekly?.remainingPercentage, 82);
  assert.equal(quota.windowsDetail.monthly?.remainingPercentage, 95);
  assert.equal(quota.windows?.["5h"], undefined);

  // daily_limit 0 must not produce a 0% free-tier window (no divide by zero).
  assert.equal(quota.freeTier, null);
  assert.equal(quota.webSearch?.allowance, 100);

  // micro-IDR → IDR, converted exactly once.
  assert.equal(quota.weekLeftIdr, 122_639_813);
  assert.equal(quota.monthLeftIdr, 572_639_813);
});

test("includes the 5h window when the upstream reports one", () => {
  const quota = parseKenariSubscription({
    ...KREATOR_RESPONSE,
    window_5h: { used_frac: 0.5, resets_in_secs: 60 },
  });
  assert.ok(quota);
  assert.equal(quota.windowsDetail["5h"]?.remainingPercentage, 50);
  assert.equal(quota.percentUsed, 0.5);
});

test("getKenariUsage shapes plan windows into the standard quotas map", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ body: KREATOR_RESPONSE }) as typeof fetch;
  try {
    const usage = await getKenariUsage("test-kenari-shape", "", {
      kenariSessionCookie: "abc",
    });
    assert.ok("quotas" in usage);
    const quotas = (usage as { quotas: Record<string, Record<string, unknown>> }).quotas;

    assert.deepEqual(Object.keys(quotas), ["weekly", "monthly", "web_search"]);
    assert.equal(quotas.weekly.remainingPercentage, 82);
    assert.equal(quotas.weekly.displayName, "Weekly");
    assert.equal(quotas.monthly.remainingPercentage, 95);
    assert.equal(quotas.monthly.displayName, "Monthly");
    assert.equal(quotas.web_search.total, 100);
    assert.equal((usage as { plan?: string }).plan, "Kreator");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing cookie is reported as missing_cookie, never as 0% quota", async () => {
  const previousEnv = process.env.KENARI_SESSION_COOKIE;
  const previousFile = process.env.KENARI_SESSION_COOKIE_FILE;
  delete process.env.KENARI_SESSION_COOKIE;
  delete process.env.KENARI_SESSION_COOKIE_FILE;

  try {
    const result = await fetchKenariQuotaDetailed("test-kenari-no-cookie", {});
    assert.equal(result.quota, null);
    assert.equal(result.reason, "missing_cookie");

    const usage = await getKenariUsage("test-kenari-no-cookie-usage", "", {});
    assert.match((usage as { message: string }).message, /session cookie/i);
  } finally {
    if (previousEnv === undefined) delete process.env.KENARI_SESSION_COOKIE;
    else process.env.KENARI_SESSION_COOKIE = previousEnv;
    if (previousFile === undefined) delete process.env.KENARI_SESSION_COOKIE_FILE;
    else process.env.KENARI_SESSION_COOKIE_FILE = previousFile;
  }
});

test("401/403 from kenari.id is reported as an expired session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ status: 401 }) as typeof fetch;
  try {
    const result = await fetchKenariQuotaDetailed("test-kenari-expired", connectionWithCookie());
    assert.equal(result.quota, null);
    assert.equal(result.reason, "expired");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a successful fetch is cached for 60s", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return {
      status: 200,
      ok: true,
      json: async () => KREATOR_RESPONSE,
    } as Response;
  }) as typeof fetch;
  try {
    const conn = connectionWithCookie();
    const first = await fetchKenariQuotaDetailed("test-kenari-cache", conn);
    const second = await fetchKenariQuotaDetailed("test-kenari-cache", conn);
    assert.equal(first.reason, null);
    assert.equal(second.reason, null);
    assert.equal(calls, 1, "second call must be served from the cache");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cookie normalization accepts a raw value, a pair, or a full header", () => {
  assert.equal(normalizeKenariCookie("abc123"), "__Host-kn_session=abc123");
  assert.equal(normalizeKenariCookie("__Host-kn_session=abc123"), "__Host-kn_session=abc123");
  assert.equal(normalizeKenariCookie("a=1; b=2"), "a=1; b=2");
});

test("resolveKenariSessionCookie prefers providerSpecificData over env", () => {
  const previous = process.env.KENARI_SESSION_COOKIE;
  process.env.KENARI_SESSION_COOKIE = "from-env";
  try {
    assert.equal(
      resolveKenariSessionCookie(connectionWithCookie("from-db")),
      "__Host-kn_session=from-db"
    );
    assert.equal(resolveKenariSessionCookie({}), "__Host-kn_session=from-env");
  } finally {
    if (previous === undefined) delete process.env.KENARI_SESSION_COOKIE;
    else process.env.KENARI_SESSION_COOKIE = previous;
  }
});

test("registers with quota preflight and exposes the plan windows", () => {
  registerKenariQuotaFetcher();
  assert.equal(typeof getQuotaFetcher("kenari"), "function");
  assert.deepEqual(getQuotaWindows("kenari"), ["weekly", "monthly", "5h"]);
});
