// Round-4 gate regressions (gpt-6.2-sol, report 20261126T010748Z-ed4dff).
//
// Rounds 1–3 were closed at the helper level, so round 4 entered at the seams that
// actually persist and bill. Every test below drives the real route handlers or the real
// cost calculator instead of asserting on a helper's return value:
//
//   F3b   POST /sync-models self-fetched the refresh route, which WROTE the merged
//         catalog before POST could reject a degraded sweep — a refused sync had already
//         mutated the synced rows. The refresh is now a pure probe for sync
//         (`persist=false`) and only the accepted result is written, by POST.
//   F3a   A valid empty catalog was not authoritative: `models: {}` was rejected as
//         malformed, and an empty union fell through to the stale cache instead of
//         clearing the rows it replaced.
//   F4b   A partial override on the exact requested alias still billed output at $0,
//         because the fallback lookup returned the same partial row.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hydrogen-gate4-"));
process.env.DATA_DIR = TEST_DATA_DIR;
if (!process.env.API_KEY_SECRET) {
  process.env.API_KEY_SECRET = "test-hydrogen-gate4-" + Date.now();
}

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providersRoute = await import("../../src/app/api/providers/[id]/models/route.ts");
const syncRoute = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
const { persistDiscoveredModels } = await import("../../src/lib/providerModels/modelDiscovery.ts");
const { getSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const { getMitmAlias, setMitmAliasAll } = await import("../../src/lib/db/models/mitmAlias.ts");
const antigravityVersion = await import("../../open-sse/services/antigravityVersion.ts");
const scheduler = await import("../../src/shared/services/modelSyncScheduler.ts");

const originalFetch = globalThis.fetch;

const TIERS = [
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
];

async function resetStorage() {
  globalThis.fetch = originalFetch;
  antigravityVersion.clearAntigravityVersionCaches();
  syncRoute.__resetLoopbackReadinessForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function seedConnection(name: string): Promise<{ id: string }> {
  const connection = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name,
    apiKey: null,
    accessToken: "ag-access",
    projectId: "project-1",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { clientProfile: "ide" },
  });
  return { id: String((connection as { id?: unknown }).id) };
}

async function seedCachedCatalog(connectionId: string) {
  await persistDiscoveredModels("antigravity", connectionId, [
    ...TIERS.map((id) => ({ id, name: id })),
    { id: "ide-stale", name: "ide-stale" },
  ]);
}

function mockDiscovery(options: {
  ide: { kind: "models"; body: unknown } | { kind: "fail" };
  cli: { kind: "models"; body: unknown } | { kind: "fail" };
}) {
  const calls: Array<{ profile: "ide" | "cli"; url: string }> = [];
  // The probe URL is what sync's self-fetch uses. Delegate it to the REAL GET handler so
  // the ordering under test (probe must not write) is the production ordering, not a
  // hand-written stub of it.
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("__readiness_probe__")) return new Response(null, { status: 404 });

    if (url.includes("/api/providers/") && url.includes("/models?")) {
      const parsed = new URL(url);
      return providersRoute.GET(new Request(`http://localhost${parsed.pathname}${parsed.search}`), {
        params: { id: parsed.pathname.split("/")[3] },
      });
    }

    // Version feeds and project bootstrap are separate concerns with their own URLs.
    if (!url.includes("fetchAvailableModels") && !url.includes(":models")) {
      return new Response("nope", { status: 503 });
    }

    const userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
    const profile: "ide" | "cli" = userAgent.includes("/cli/") ? "cli" : "ide";
    const first = calls.filter((call) => call.profile === profile).length === 0;
    calls.push({ profile, url });
    // Only the first endpoint per profile answers, mirroring the real upstream.
    if (!first) return new Response("gone", { status: 503 });

    const plan = options[profile];
    if (plan.kind === "fail") return new Response("upstream down", { status: 503 });
    return Response.json(plan.body);
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

async function callRefresh(connectionId: string, search = "") {
  return providersRoute.GET(
    new Request(
      `http://localhost/api/providers/${connectionId}/models?refresh=true&excludeCustom=true${search}`
    ),
    { params: { id: connectionId } }
  );
}

async function callSync(connectionId: string) {
  return syncRoute.POST(
    new Request(`http://localhost/api/providers/${connectionId}/sync-models`, {
      method: "POST",
      headers: scheduler.buildModelSyncInternalHeaders(),
    }),
    { params: { id: connectionId } }
  );
}

async function syncedIds(connectionId: string) {
  const rows = await getSyncedAvailableModelsForConnection("antigravity", connectionId);
  return rows.map((row) => row.id).sort();
}

// ---------------------------------------------------------------------------
// F3b — a refused sync must not have written anything.
// ---------------------------------------------------------------------------

test("F3b: a degraded sync leaves the synced rows and the MITM alias untouched", async (t) => {
  await resetStorage();
  antigravityVersion.seedAntigravityIdeVersionCache("1.22.2");
  antigravityVersion.seedAntigravityCliVersionCache("1.22.2");

  const connection = await seedConnection("F3B-DEGRADED");
  await seedCachedCatalog(connection.id);
  await setMitmAliasAll("antigravity", {
    "gemini-4-hydrogen-xhigh": "antigravity/gemini-4-hydrogen-xhigh",
  });
  const rowsBefore = await syncedIds(connection.id);
  const aliasBefore = await getMitmAlias("antigravity");

  // ide answers with rows it has never seen; the cli supplement is down.
  const mock = mockDiscovery({
    ide: {
      kind: "models",
      body: {
        models: [
          { id: "ide-a", displayName: "ide-a" },
          { id: "ide-b", displayName: "ide-b" },
        ],
      },
    },
    cli: { kind: "fail" },
  });
  t.after(() => mock.restore());

  const response = await callSync(connection.id);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 502, "a degraded sweep must be refused");
  assert.equal(body.discoveryDegraded, true);
  // The decisive assertion: the refresh that POST performed was a probe, so the ide
  // rows it saw never reached the DB. Before the fix they did, and the four tiers were
  // deleted by a request that then returned 502.
  assert.deepEqual(
    await syncedIds(connection.id),
    rowsBefore,
    "a refused sync must not change the synced rows"
  );
  assert.deepEqual(
    await getMitmAlias("antigravity"),
    aliasBefore,
    "a refused sync must not regenerate the MITM alias"
  );
});

test("F3b: the refresh route in probe mode writes nothing", async (t) => {
  await resetStorage();
  antigravityVersion.seedAntigravityIdeVersionCache("1.22.2");
  antigravityVersion.seedAntigravityCliVersionCache("1.22.2");

  const connection = await seedConnection("F3B-PROBE");
  await seedCachedCatalog(connection.id);
  const rowsBefore = await syncedIds(connection.id);

  const mock = mockDiscovery({
    ide: { kind: "models", body: { models: [{ id: "ide-a", displayName: "ide-a" }] } },
    cli: { kind: "models", body: { models: TIERS.map((id) => ({ id, displayName: id })) } },
  });
  t.after(() => mock.restore());

  const response = await callRefresh(connection.id, "&persist=false");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { models: Array<{ id: string }> };
  assert.ok(
    body.models.some((model) => model.id === "ide-a"),
    "the probe must still report what upstream said"
  );
  assert.deepEqual(
    await syncedIds(connection.id),
    rowsBefore,
    "persist=false must not write the discovered catalog"
  );
});

test("F3b control: an accepted sync still writes the freshly discovered catalog", async (t) => {
  await resetStorage();
  antigravityVersion.seedAntigravityIdeVersionCache("1.22.2");
  antigravityVersion.seedAntigravityCliVersionCache("1.22.2");

  const connection = await seedConnection("F3B-ACCEPTED");
  await seedCachedCatalog(connection.id);

  const mock = mockDiscovery({
    ide: { kind: "models", body: { models: [{ id: "ide-a", displayName: "ide-a" }] } },
    cli: { kind: "models", body: { models: TIERS.map((id) => ({ id, displayName: id })) } },
  });
  t.after(() => mock.restore());

  const response = await callSync(connection.id);
  assert.equal(response.status, 200, "a healthy sweep must still sync");

  const ids = await syncedIds(connection.id);
  assert.ok(ids.includes("ide-a"), "the accepted catalog must be persisted");
  for (const tier of TIERS) {
    assert.ok(ids.includes(tier), `the accepted catalog must persist ${tier}`);
  }
  assert.equal(ids.includes("ide-stale"), false, "an accepted sweep replaces stale rows");
});

// ---------------------------------------------------------------------------
// F3a — a valid empty catalog is authoritative, in both representations.
// ---------------------------------------------------------------------------

for (const [label, emptyBody] of [
  ["an empty array", { models: [] }],
  ["an empty id map", { models: {} }],
] as const) {
  test(`F3a: ${label} from both profiles clears the previous catalog`, async (t) => {
    await resetStorage();
    antigravityVersion.seedAntigravityIdeVersionCache("1.22.2");
    antigravityVersion.seedAntigravityCliVersionCache("1.22.2");

    const connection = await seedConnection(`F3A-${label.replace(/\s+/g, "-")}`);
    await seedCachedCatalog(connection.id);
    assert.ok((await syncedIds(connection.id)).length > 0, "precondition: rows are seeded");

    const mock = mockDiscovery({
      ide: { kind: "models", body: emptyBody },
      cli: { kind: "models", body: emptyBody },
    });
    t.after(() => mock.restore());

    const response = await callRefresh(connection.id);
    assert.equal(response.status, 200);

    const body = (await response.json()) as { discoveryDegraded?: boolean };
    assert.equal(
      body.discoveryDegraded,
      undefined,
      "an answered-but-empty catalog is not a degraded sweep"
    );
    assert.deepEqual(
      await syncedIds(connection.id),
      [],
      "an authoritative empty catalog must replace the previous rows, not fall back to them"
    );
  });
}

test("F3a: an empty primary sweep with a cli outage keeps only the last-known tiers", async (t) => {
  await resetStorage();
  antigravityVersion.seedAntigravityIdeVersionCache("1.22.2");
  antigravityVersion.seedAntigravityCliVersionCache("1.22.2");

  const connection = await seedConnection("F3A-DEGRADED-EMPTY");
  await seedCachedCatalog(connection.id);

  const mock = mockDiscovery({
    ide: { kind: "models", body: { models: [] } },
    cli: { kind: "fail" },
  });
  t.after(() => mock.restore());

  const response = await callRefresh(connection.id);
  assert.equal(response.status, 200);

  const ids = await syncedIds(connection.id);
  // The primary sweep is authoritative for non-tier models, so `ide-stale` goes; the cli
  // outage says nothing about the tiers, so those stay.
  assert.equal(ids.includes("ide-stale"), false, "the primary sweep owns the non-tier rows");
  for (const tier of TIERS) {
    assert.ok(ids.includes(tier), `a cli outage must not delete ${tier}`);
  }
});

test("F3a: a 200 without a models collection is not an empty catalog", async (t) => {
  await resetStorage();
  antigravityVersion.seedAntigravityIdeVersionCache("1.22.2");
  antigravityVersion.seedAntigravityCliVersionCache("1.22.2");

  const connection = await seedConnection("F3A-MALFORMED");
  await seedCachedCatalog(connection.id);

  const mock = mockDiscovery({
    ide: { kind: "models", body: { error: { message: "quota" } } },
    cli: { kind: "models", body: { error: { message: "quota" } } },
  });
  t.after(() => mock.restore());

  const response = await callRefresh(connection.id);
  assert.equal(response.status, 200);

  const ids = await syncedIds(connection.id);
  assert.ok(
    ids.length > 0,
    "a body with no models collection carries no catalog information and must not clear rows"
  );
});

// ---------------------------------------------------------------------------
// F4b — billing, not just the resolved row.
// ---------------------------------------------------------------------------

test("F4b: a partial override on the requested alias inherits the omitted rates", async () => {
  await resetStorage();
  const { updatePricing } = await import("../../src/lib/db/settings/pricing.ts");
  const { calculateCost } = await import("../../src/lib/usage/costCalculator.ts");

  await updatePricing({
    ag: { "gemini-4-hydrogen": { input: 42 } },
  } as never);

  // One million output tokens at the canonical $7.50/M rate. Before the fix the partial
  // row won outright and this billed $0.
  const cost = await calculateCost("antigravity", "gemini-4-hydrogen", {
    output_tokens: 1_000_000,
  });
  assert.equal(cost, 7.5, "an omitted output rate must inherit the canonical rate, not bill $0");
});

test("F4b: a provider-local partial tier override survives an alias request", async () => {
  await resetStorage();
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");

  // A provider-local input-only row for the canonical tier, asked for through `-extra`.
  await updatePricing({
    antigravity: { "gemini-4-hydrogen-xhigh": { input: 43 } },
  } as never);

  const row = await getPricingForModel("antigravity", "gemini-4-hydrogen-extra");
  assert.ok(row);
  assert.equal(row.input, 43, "the provider-local explicit rate must win over the ag default");
  assert.equal(row.output, 7.5, "the rate it omits is inherited from the complete default row");
});
