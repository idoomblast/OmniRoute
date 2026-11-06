/**
 * usage-connection-proxy.test.ts — usage readers run through the connection proxy.
 *
 * Guard: with a proxy assigned to the connection, the upstream usage request
 * runs inside the connection proxy context instead of a direct fetch;
 * failures surface as the existing message and never retry outside the proxy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectionProxyTestOverride,
  fetchWithConnectionProxy,
} from "../../open-sse/services/connectionProxyFetch.ts";
import { hasAmbientProxyContext } from "../../open-sse/utils/proxyFetch.ts";
import { __setProxyHealthTcpCheckForTesting } from "../../src/lib/proxyHealth.ts";
import { getUsageForProvider } from "../../open-sse/services/usage.ts";
import { _resetClaudeUsagePollingState } from "../../open-sse/services/usage/claude.ts";

const ASSIGNED_PROXY = { type: "socks5", host: "127.0.0.1", port: 9 };
const BALANCE_BODY = JSON.stringify({
  dailyCredits: 10,
  subscriptionCredits: 20,
  subscriptionAmount: 100,
  extraCredits: 5,
  total: 35,
});
const originalFetch = globalThis.fetch;

function balanceResponse(): Response {
  return new Response(BALANCE_BODY, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function useAssignedProxy(): void {
  connectionProxyTestOverride.resolveProxyForConnection = async () => ({
    proxy: ASSIGNED_PROXY,
  });
}

function useNoProxy(): void {
  connectionProxyTestOverride.resolveProxyForConnection = async () => ({ proxy: null });
}

// The fake proxy 127.0.0.1:9 is deliberately closed; skip the TCP fast-fail so
// the test exercises the proxy *context*, not a real egress.
test.before(() => __setProxyHealthTcpCheckForTesting(async () => true));

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  connectionProxyTestOverride.resolveProxyForConnection = null;
  _resetClaudeUsagePollingState();
});

test.after(() => __setProxyHealthTcpCheckForTesting(null));

test("claude reading with an assigned proxy runs inside the proxy context", async () => {
  useAssignedProxy();
  const observed: Array<{ url: string; proxied: boolean }> = [];
  globalThis.fetch = (async (url: unknown) => {
    observed.push({ url: String(url), proxied: hasAmbientProxyContext() });
    return new Response(
      JSON.stringify({
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
  const result = (await getUsageForProvider({
    provider: "claude",
    accessToken: "unit-token-proxy",
    id: "conn-claude-proxy",
  })) as { quotas?: Record<string, { used?: number }> };
  assert.equal(result.quotas?.["session (5h)"].used, 10);
  // Every authenticated subrequest of the reading, bootstrap included, must use
  // the connection's egress — a direct bootstrap would leak the bearer token.
  assert.ok(observed.some((call) => call.url.includes("/api/claude_cli/bootstrap")));
  assert.ok(observed.every((call) => call.proxied));
});

test("claude reading without a proxy calls the OAuth endpoint directly", async () => {
  useNoProxy();
  let observedInContext: boolean | null = null;
  let observedUrl = "";
  globalThis.fetch = (async (url: unknown) => {
    observedInContext = hasAmbientProxyContext();
    observedUrl = String(url);
    return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  await getUsageForProvider({
    provider: "claude",
    accessToken: "unit-token-direct",
    id: "conn-claude-direct",
  });
  assert.equal(observedInContext, false);
  assert.equal(observedUrl, "https://api.anthropic.com/api/oauth/usage");
});

test("a proxied claude failure surfaces the existing message without a direct retry", async () => {
  useAssignedProxy();
  const observed: Array<{ url: string; proxied: boolean }> = [];
  globalThis.fetch = (async (url: unknown) => {
    observed.push({ url: String(url), proxied: hasAmbientProxyContext() });
    throw new Error("proxy blocked the anomaly domain");
  }) as typeof globalThis.fetch;
  const result = (await getUsageForProvider({
    provider: "claude",
    accessToken: "unit-token-blocked",
    id: "conn-claude-blocked",
  })) as { message?: string };
  // The proxied read fails closed: the OAuth attempt, the legacy fallback, and
  // the bootstrap read all run inside the proxy context, never a direct retry.
  assert.ok(observed.some((call) => call.url.includes("/api/claude_cli/bootstrap")));
  assert.ok(observed.length >= 1);
  assert.ok(observed.every((call) => call.proxied));
  assert.match(String(result.message), /Usage API requires admin permissions/);
});

test("a reading without a connection identifier makes no fetch", async () => {
  useAssignedProxy();
  const { fetchWithConnectionProxy: proxiedFetch } =
    await import("../../open-sse/services/connectionProxyFetch.ts");
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return balanceResponse();
  }) as typeof globalThis.fetch;
  const response = await proxiedFetch("", "https://conol.ai/api/billing/balance", undefined, {
    resolveProxyForConnection: async () => ({ proxy: ASSIGNED_PROXY }),
    fetchFn,
  });
  assert.equal(response, null);
  assert.equal(calls, 0);
});

test("usage leaves route every proxied fetch through the connection proxy helper", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", "open-sse", "services");
  // P0 scope ports the Claude reader; the other provider leaves land with their
  // own backports, so this guard covers the file this batch actually changed.
  const leaves = [join(root, "usage", "claude.ts")];
  for (const file of leaves) {
    const source = readFileSync(file, "utf8");
    // Only the module seam initializer (`... => fetch(...)`) and qualified
    // `globalThis.fetch` / `codexUsageFetch(...)` calls may remain.
    const scrubbed = source
      .replace(/=>\s*fetch\([^)]*\)/g, "")
      .replace(/codexUsageFetch\(/g, "")
      .replace(/globalThis\.fetch\(/g, "");
    assert.ok(
      !/(^|[^a-zA-Z_.])fetch\(/.test(scrubbed),
      `${file} must not call bare fetch directly`
    );
    assert.ok(
      source.includes("fetchWithConnectionProxy("),
      `${file} must route through the connection proxy helper`
    );
  }
});

test("the helper reports a missing identifier instead of fetching directly", async () => {
  let calls = 0;
  const fetchFn = (async (): Promise<Response> => {
    calls += 1;
    return balanceResponse();
  }) as typeof globalThis.fetch;
  const response = await fetchWithConnectionProxy(
    "",
    "https://console.example/api/balance",
    undefined,
    {
      resolveProxyForConnection: async () => ({ proxy: ASSIGNED_PROXY }),
      fetchFn,
    }
  );
  assert.equal(response, null);
  assert.equal(calls, 0);
});
