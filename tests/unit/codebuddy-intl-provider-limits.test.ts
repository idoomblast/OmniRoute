import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codebuddy-intl-limits-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-codebuddy-intl-limits-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const originalFetch = globalThis.fetch;
const USAGE_URL = "https://www.codebuddy.ai/v2/billing/meter/get-user-resource";
const resetAt = "2026-11-01T00:00:00.000Z";
const expectedQuotas = {
  Monthly: { used: 25, total: 100, resetAt, unlimited: false },
};

function usageResponse() {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageName: "International allowance",
                CycleStartTime: "2026-10-01T00:00:00.000Z",
                CycleEndTime: resetAt,
                DeductionEndTime: "2027-01-01T00:00:00.000Z",
                CycleCapacitySize: 100,
                CycleCapacityUsed: 25,
              },
            ],
          },
        },
      },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

async function createConnection(authType: "oauth" | "apikey" | "api_key") {
  const created = await providersDb.createProviderConnection({
    provider: "codebuddy-intl",
    authType,
    name: `CodeBuddy International ${authType}`,
    ...(authType === "oauth"
      ? {
          accessToken: "test-intl-access",
          refreshToken: "test-intl-refresh",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }
      : { apiKey: "test-intl-api-key" }),
  });
  return (created as { id: string }).id;
}

test.beforeEach(() => {
  globalThis.fetch = originalFetch;
  quotaCache.__clearForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  quotaCache.__clearForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

for (const authType of ["oauth", "apikey", "api_key"] as const) {
  test(`International ${authType} usage passes the limits gate and persists its quota cache`, async () => {
    const connectionId = await createConnection(authType);
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), USAGE_URL);
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        authType === "oauth" ? "Bearer test-intl-access" : "Bearer test-intl-api-key"
      );
      return usageResponse();
    };

    const result = await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    assert.equal(calls, 1);
    assert.equal(result.connection.id, connectionId);
    assert.deepEqual(result.usage.quotas, expectedQuotas);
    assert.equal(result.cache.plan, "International allowance");
    assert.equal(result.cache.source, "manual");
    assert.deepEqual(providerLimitsDb.getProviderLimitsCache(connectionId)?.quotas, expectedQuotas);
  });

  test(`International ${authType} usage preserves the last good cache on a quota API failure`, async () => {
    const connectionId = await createConnection(authType);
    globalThis.fetch = async () => usageResponse();
    const first = await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    globalThis.fetch = async () => new Response("unavailable", { status: 500 });
    const failed = await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    assert.equal(failed.usage._stale, true);
    assert.equal(failed.usage._staleSince, first.cache.fetchedAt);
    assert.deepEqual(failed.usage.quotas, expectedQuotas);
    assert.equal(failed.usage.plan, "International allowance");
    assert.deepEqual(failed.cache.quotas, first.cache.quotas);
    assert.equal(
      providerLimitsDb.getProviderLimitsCache(connectionId)?.fetchedAt,
      first.cache.fetchedAt
    );
  });

  test(`International ${authType} usage does not egress directly when its account proxy is unreachable`, async () => {
    const connectionId = await createConnection(authType);
    await settingsDb.setProxyForLevel("key", connectionId, {
      type: "http",
      host: "127.0.0.1",
      port: 1,
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return usageResponse();
    };
    await assert.rejects(
      () => providerLimits.fetchAndPersistProviderLimits(connectionId, "manual"),
      (error: Error & { code?: string }) => error.code === "PROXY_UNREACHABLE"
    );
    assert.equal(calls, 0);
    assert.equal(providerLimitsDb.getProviderLimitsCache(connectionId), null);
  });
}
