// Round-5 gate regressions (deepseek-v4.1-flash, report 20261126T022322Z-894999).
//
//   BF-1  A 200 carrying an error envelope from a NON-Antigravity provider parsed to `[]`
//         through the generic `data.data || data.models || []` paths and was persisted,
//         silently wiping a healthy catalog behind a success status. Emptiness is only an
//         answer when the payload actually carried a collection.
//   BF-2  An authoritative empty sync was reported as "N models, no changes": the import
//         helper keeps its previous snapshot when the discovered list is empty, so the
//         post-sync state was read from a stale value instead of the stored rows.
//   NB-4  A partial override that omitted `long_context` billed the flat rate for a model
//         that prices long-context calls separately.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hydrogen-gate5-"));
process.env.DATA_DIR = TEST_DATA_DIR;
if (!process.env.API_KEY_SECRET) {
  process.env.API_KEY_SECRET = "test-hydrogen-gate5-" + Date.now();
}

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providersRoute = await import("../../src/app/api/providers/[id]/models/route.ts");
const syncRoute = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
const { persistDiscoveredModels } = await import("../../src/lib/providerModels/modelDiscovery.ts");
const { getSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
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

async function syncedIds(connectionId: string): Promise<string[]> {
  const rows = await getSyncedAvailableModelsForConnection("antigravity", connectionId);
  return rows.map((row) => String((row as { id?: unknown }).id)).sort();
}

async function seedAntigravity(name: string): Promise<{ id: string }> {
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

function mockDiscoveryBodies(ide: unknown, cli: unknown) {
  const original = globalThis.fetch;
  let ideCalls = 0;
  let cliCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("__readiness_probe__")) return new Response(null, { status: 404 });

    // model-sync self-fetches the refresh route; delegate to the real handler so the
    // probe-vs-persist ordering under test is the production one.
    if (url.includes("/api/providers/") && url.includes("/models?")) {
      const parsed = new URL(url);
      return providersRoute.GET(new Request(`http://localhost${parsed.pathname}${parsed.search}`), {
        params: { id: parsed.pathname.split("/")[3] },
      });
    }

    if (!url.includes("fetchAvailableModels") && !url.includes(":models")) {
      return new Response("nope", { status: 503 });
    }

    const userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
    const isCli = userAgent.includes("/cli/");
    const first = isCli ? cliCalls++ === 0 : ideCalls++ === 0;
    if (!first) return new Response("gone", { status: 503 });
    return Response.json(isCli ? cli : ide);
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

// ---------------------------------------------------------------------------
// BF-1 — refusing to read a malformed 200 as an empty catalog.
// ---------------------------------------------------------------------------

test("BF-1: a 200 with no catalog collection from a generic provider never wipes the stored catalog", async () => {
  await resetStorage();
  const connection = await providersDb.createProviderConnection({
    provider: "nvidia",
    authType: "api-key",
    name: "BF1-NVIDIA",
    apiKey: "nv-key",
    isActive: true,
    testStatus: "active",
  });
  const id = String((connection as { id?: unknown }).id);
  await persistDiscoveredModels("nvidia", id, [
    { id: "meta/llama-4-70b", name: "Llama 4 70B" },
    { id: "nvidia/nemotron-4", name: "Nemotron 4" },
  ]);
  const before = await getSyncedAvailableModelsForConnection("nvidia", id);
  assert.equal(before.length, 2);

  // `{"object":"list"}` carries no collection: every value is a scalar. Providers do
  // answer 200 with this shape on a quota/auth failure that got masked upstream.
  const restore = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ object: "list" })) as typeof fetch;
  try {
    const response = await providersRoute.GET(
      new Request(`http://localhost/api/providers/${id}/models?refresh=true&excludeCustom=true`),
      { params: Promise.resolve({ id }) }
    );
    const body = (await response.json()) as Record<string, unknown>;
    // The decisive assertion: the rows survive a 200 that carried no catalog.
    const after = await getSyncedAvailableModelsForConnection("nvidia", id);
    assert.equal(after.length, 2, "a malformed 200 must not clear the stored catalog");
    assert.notEqual(body.source, "api", "a malformed 200 is not a fresh API catalog");
    assert.equal(body.importable, false, "sync must not import a fallback for this sweep");
  } finally {
    globalThis.fetch = restore;
  }
});

test("BF-1: an error envelope from a generic provider never wipes the stored catalog", async () => {
  await resetStorage();
  const connection = await providersDb.createProviderConnection({
    provider: "nvidia",
    authType: "api-key",
    name: "BF1-ENVELOPE",
    apiKey: "nv-key",
    isActive: true,
    testStatus: "active",
  });
  const id = String((connection as { id?: unknown }).id);
  await persistDiscoveredModels("nvidia", id, [{ id: "meta/llama-4-70b", name: "Llama 4 70B" }]);

  const restore = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: { code: 429, message: "quota exhausted" } })) as typeof fetch;
  try {
    await providersRoute.GET(
      new Request(`http://localhost/api/providers/${id}/models?refresh=true&excludeCustom=true`),
      { params: Promise.resolve({ id }) }
    );
    const after = await getSyncedAvailableModelsForConnection("nvidia", id);
    assert.equal(after.length, 1, "an error envelope must not clear the stored catalog");
  } finally {
    globalThis.fetch = restore;
  }
});

// A provider whose catalog lives under its own key (Cloudflare's `{ result: [...] }`)
// must still be read as a catalog: the guard may not hardcode container names.
test("BF-1: a provider-specific container key is still a catalog, not a malformed body", async () => {
  await resetStorage();
  const connection = await providersDb.createProviderConnection({
    provider: "cloudflare-ai",
    authType: "api-key",
    name: "BF1-RESULT-KEY",
    apiKey: "cf-token",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { accountId: "acc-123" },
  });
  const id = String((connection as { id?: unknown }).id);
  await persistDiscoveredModels("cloudflare-ai", id, [{ id: "stale-model", name: "stale-model" }]);

  const restore = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      result: [{ id: "uuid-1", name: "@cf/meta/llama-3.1-8b-instruct", task: {} }],
    })) as typeof fetch;
  try {
    const response = await providersRoute.GET(
      new Request(`http://localhost/api/providers/${id}/models?refresh=true&excludeCustom=true`),
      { params: Promise.resolve({ id }) }
    );
    const body = (await response.json()) as Record<string, unknown> & {
      models: Array<{ id: string }>;
    };
    assert.equal(body.source, "api", "a `result`-shaped catalog is a real catalog");
    const ids = (body.models as Array<{ id: string }>).map((model) => model.id);
    assert.ok(
      ids.includes("@cf/meta/llama-3.1-8b-instruct"),
      `expected the slug id, got ${JSON.stringify(ids)}`
    );
    assert.ok(!ids.includes("stale-model"), "the stale row must be replaced by the sweep");
  } finally {
    globalThis.fetch = restore;
  }
});

// ---------------------------------------------------------------------------
// BF-2 — the post-sync state comes from the rows, not from the import's snapshot.
// ---------------------------------------------------------------------------

test("BF-2: an authoritative empty sweep reports zero models and the rows it removed", async () => {
  await resetStorage();
  const connection = await seedAntigravity("BF2-EMPTY");
  await persistDiscoveredModels("antigravity", connection.id, [
    ...TIERS.map((id) => ({ id, name: id })),
    { id: "ide-stale", name: "ide-stale" },
  ]);
  assert.equal((await syncedIds(connection.id)).length, 5);

  // Both profiles answer — with an empty catalog. That is a real answer, not a failure.
  const restore = mockDiscoveryBodies({ models: [] }, { models: [] });
  try {
    const response = await syncRoute.POST(
      new Request(`http://localhost/api/providers/${connection.id}/sync-models`, {
        method: "POST",
        headers: scheduler.buildModelSyncInternalHeaders(),
      }),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as Record<string, unknown> & {
      modelChanges: { removed: number; added: number };
    };

    assert.equal(response.status, 200);
    assert.deepEqual(await syncedIds(connection.id), [], "the sweep cleared the rows");
    assert.equal(body.syncedModels, 0, "an empty sync must not report the old model count");
    assert.equal(
      body.modelChanges.removed,
      5,
      "the rows the sync removed must be counted, not hidden behind a stale snapshot"
    );
    assert.equal(body.logged, true, "a sync that removed rows must be logged");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// NB-4 — every rate key participates in the partial-override merge.
// ---------------------------------------------------------------------------

test("NB-4: a partial override inherits the object-valued long_context tier", async () => {
  await resetStorage();
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");
  const { computeCostFromPricing } = await import("../../src/lib/usage/costCalculator.ts");

  // The tier is an OBJECT — `{threshold, input, output, ...}` — because that is the shape
  // `applyLongContextTier` reads. An earlier version of this test seeded `long_context: 9`
  // (a number), a shape the calculator ignores entirely, so it asserted a form that never
  // occurs and could never fail.
  const TIER = {
    threshold: 100_000,
    input: 0.5,
    output: 2.5,
    cached: 0.05,
    reasoning: 2.5,
    cache_creation: 0.625,
  };
  await updatePricing({
    ag: {
      "gemini-4-hydrogen": {
        input: 0.1,
        output: 0.5,
        cached: 0.01,
        reasoning: 0.5,
        cache_creation: 0.125,
        long_context: TIER,
      },
    },
    antigravity: { "gemini-4-hydrogen": { input: 5 } },
  } as never);

  const row = await getPricingForModel("antigravity", "gemini-4-hydrogen");
  assert.ok(row);
  assert.equal(row.input, 5, "the explicit rate wins");
  assert.equal(row.output, 0.5, "omitted output inherits");
  assert.deepEqual(row.long_context, TIER, "the whole tier object inherits");

  // And the inherited tier must actually change the bill: 150k input crosses the 100k
  // threshold, so the tier's $0.50/MTok applies to the whole request ($0.075), not the
  // flat $5/MTok explicitly overridden above.
  const cost = computeCostFromPricing(row as Record<string, unknown>, { input: 150_000 });
  assert.ok(
    Math.abs(cost - 0.075) < 1e-9,
    `long-context tier must be billed, got ${cost} (flat rate would be 0.75)`
  );
});
