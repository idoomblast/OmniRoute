// Round-7 gate regressions (deepseek-v4.1-flash, report 20260726T075928Z-9e6b0f).
//
//   BF-1  Six `buildApiDiscoveryResponse` call sites were left without a catalog guard, so a
//         provider answering 200 with an error envelope (routine for auth-gated providers when
//         quota is exhausted) wiped its healthy catalog and reported `200 {ok:true, removed:N}`.
//         The guard now lives INSIDE the helper, so a site cannot forget it.
//   BF-2  `hasCatalogCollection` accepted any top-level array-or-object, so `{"errors":[...]}`,
//         `{"fault":{...}}` and `{"message":…,"code":…}` all read as catalogs and wiped a healthy
//         one on a 200. The test is now positive: a known catalog container must be present, and
//         `hasErrorEnvelope` recognises the REST/GCP/FastAPI error spellings.
//   BF-4  A partial override on a provider whose alias owns the price table dropped every base
//         rate, because the alias was only added to `candidateNamespaces` when the provider had
//         no table of its own.
import "./_dataDirIsolation.ts";
import test from "node:test";
import assert from "node:assert/strict";

if (!process.env.API_KEY_SECRET) {
  process.env.API_KEY_SECRET = "test-hydrogen-gate6-" + Date.now();
}

const providersDb = await import("../../src/lib/db/providers.ts");
const providersRoute = await import("../../src/app/api/providers/[id]/models/route.ts");
const syncRoute = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
const { persistDiscoveredModels } = await import("../../src/lib/providerModels/modelDiscovery.ts");
const { getSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const core = await import("../../src/lib/db/core.ts");
const antigravityVersion = await import("../../open-sse/services/antigravityVersion.ts");
const { hasCatalogCollection, hasErrorEnvelope } =
  await import("../../src/app/api/providers/[id]/models/discovery/normalizers.ts");

const originalFetch = globalThis.fetch;

// The providers BF-1 proved vulnerable: each answered 200 with an error envelope and lost its
// whole catalog. They matter because they are auth-gated, so a quota error behind 200 is normal.
const WIPE_PROVIDERS = ["datarobot", "azure-openai", "watsonx", "oci", "sap"] as const;

async function resetStorage() {
  globalThis.fetch = originalFetch;
  antigravityVersion.clearAntigravityVersionCaches();
  syncRoute.__resetLoopbackReadinessForTests();
  core.resetDbInstance();
}

async function seedConnection(provider: string, connectionId: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${connectionId}`,
    apiKey: "test-key-" + connectionId,
    isActive: true,
    providerSpecificData: {},
  } as never);
  const connections = await providersDb.getProviderConnections({ provider });
  const created = connections.find(
    (c: Record<string, unknown>) => c.name === `${provider}-${connectionId}`
  );
  assert.ok(created, `seed connection for ${provider}`);
  return String((created as Record<string, unknown>).id);
}

async function seedCatalog(provider: string, connectionId: string) {
  await persistDiscoveredModels(provider, connectionId, [
    { id: "seeded-model-a", name: "seeded-model-a" },
    { id: "seeded-model-b", name: "seeded-model-b" },
  ]);
  const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
  assert.equal(rows.length, 2, "seeded catalog");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// BF-1 — every persisting call site must refuse an error envelope.
// ---------------------------------------------------------------------------

for (const provider of WIPE_PROVIDERS) {
  test(`BF-1: ${provider} answering 200 with an error envelope does not wipe its catalog`, async () => {
    await resetStorage();
    const connectionId = await seedConnection(provider, `bf1-${provider}`);
    await seedCatalog(provider, connectionId);

    // Quota exhausted: a REAL shape these providers return behind HTTP 200.
    globalThis.fetch = (async () =>
      jsonResponse({ error: { code: 429, message: "quota exceeded" } })) as typeof fetch;

    // The route is addressed by CONNECTION id and derives the provider from the stored row.
    const route = await import("../../src/app/api/providers/[id]/models/route.ts");
    const res = await route.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: Promise.resolve({ id: connectionId }) }
    );
    const body = (await res.json()) as Record<string, unknown>;

    const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
    assert.equal(rows.length, 2, `${provider} catalog must survive an error envelope`);
    assert.equal(
      rows
        .map((r: { id: string }) => r.id)
        .sort()
        .join(","),
      "seeded-model-a,seeded-model-b"
    );
    // And the response must not claim an empty catalog was discovered.
    assert.notEqual(
      (body.models as unknown[] | undefined)?.length,
      0,
      `${provider} must not report an authoritative empty catalog`
    );
  });
}

test("BF-1: POST /sync-models refuses an error envelope and keeps the rows", async () => {
  await resetStorage();
  const provider = "watsonx";
  const connectionId = await seedConnection(provider, "bf1-sync");
  await seedCatalog(provider, connectionId);

  // model-sync self-fetches the refresh route over HTTP. That request must reach the REAL
  // handler (so the production probe/persist ordering is under test), and only the UPSTREAM
  // provider call may be mocked — a blanket mock would answer the self-fetch itself and the
  // test would pass or fail for reasons that never happen in production.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/providers/") && url.includes("/models?")) {
      const parsed = new URL(url);
      return providersRoute.GET(new Request(`http://localhost${parsed.pathname}${parsed.search}`), {
        params: Promise.resolve({ id: parsed.pathname.split("/")[3] }),
      });
    }
    if (url.includes("__readiness")) return new Response(null, { status: 404 });
    return jsonResponse({ error: { code: 429, message: "quota exceeded" } });
  }) as typeof fetch;

  const res = await syncRoute.POST(
    new Request(`http://localhost/api/providers/${connectionId}/sync-models`, { method: "POST" }),
    { params: Promise.resolve({ id: connectionId }) }
  );
  assert.notEqual(res.status, 200, "a sync built on an error envelope must not report success");
  const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
  assert.equal(rows.length, 2, "the stored catalog must survive a refused sync");
});

// ---------------------------------------------------------------------------
// BF-2 — the emptiness test is positive, and error envelopes are recognised.
// ---------------------------------------------------------------------------

test("BF-2: error envelopes in every dialect are recognised and are not catalogs", () => {
  const envelopes = [
    { error: { code: 429, message: "rate limited" } }, // REST
    { errors: [{ status: "429", detail: "quota" }] }, // REST plural
    { fault: { faultstring: "Invalid ApiKey", detail: { errorcode: "keyInvalid" } } }, // GCP
    { detail: "Not authenticated" }, // FastAPI
    { detail: [{ loc: ["body"], msg: "invalid" }] }, // FastAPI validation
    { message: "quota exceeded", code: 429 }, // message+code
  ];
  for (const body of envelopes) {
    assert.equal(hasCatalogCollection(body), false, `not a catalog: ${JSON.stringify(body)}`);
  }
  assert.equal(hasErrorEnvelope({ errors: [{ status: "429" }] }), true);
  assert.equal(hasErrorEnvelope({ fault: { faultstring: "nope" } }), true);
  assert.equal(hasErrorEnvelope({ detail: "nope" }), true);
});

test("BF-2: real catalog shapes are still accepted, including empty ones", () => {
  const catalogs = [
    [{ id: "a" }], // bare array (AI/ML API)
    { data: [{ id: "a" }] }, // OpenAI-ish
    { models: { a: { name: "a" } } }, // id → model map
    { result: [{ id: "a" }] }, // Cloudflare
    { results: [{ id: "a" }] }, // search-style
    { availableModels: [{ id: "a" }] }, // Google
    { items: [{ id: "a" }] }, // paged
    { data: [] }, // authoritative empty
    { models: {} }, // authoritative empty map
  ];
  for (const body of catalogs) {
    assert.equal(hasCatalogCollection(body), true, `is a catalog: ${JSON.stringify(body)}`);
  }
  // A body of scalars only proves nothing.
  assert.equal(hasCatalogCollection({ object: "list" }), false);
});

// ---------------------------------------------------------------------------
// BF-4 — the alias table always participates in the per-model lookup.
// ---------------------------------------------------------------------------

test("BF-4: a partial override on a provider whose alias owns the prices keeps every base rate", async () => {
  await resetStorage();
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");

  const FULL = {
    input: 0.1,
    output: 0.5,
    cached: 0.01,
    reasoning: 0.5,
    cache_creation: 0.125,
    long_context: { threshold: 100_000, input: 0.5, output: 2.5 },
  };
  // `claude` has its own table here (holding ONLY the model's full row is not the point —
  // the point is the provider has a table at all) while the alias `cc` carries the base rates.
  await updatePricing({
    claude: { "claude-haiku-5-5": { output: 0.9 } },
    cc: { "claude-haiku-5-5": FULL },
  } as never);

  const row = await getPricingForModel("claude", "claude-haiku-5-5");
  assert.ok(row);
  assert.equal(row.output, 0.9, "the override wins");
  assert.equal(row.input, 0.1, "input inherited through the alias table");
  assert.equal(row.cached, 0.01, "cached inherited");
  assert.equal(row.reasoning, 0.5, "reasoning inherited");
  assert.equal(row.cache_creation, 0.125, "cache_creation inherited");
  assert.deepEqual(row.long_context, FULL.long_context, "long_context tier inherited");
});

// ---------------------------------------------------------------------------
// BF-1/BF-2/BF-3 (round 9) — the guard must be CONTENT-aware and BEHAVIOURALLY tested.
//
// Round 9 found the guard still bypassable:
//   - `{"data":{"error":{"code":429}}}` passed, because `hasCatalogCollection` accepted any
//     object under a container key. An error envelope wrapped one level down is still an error.
//   - `{"data":"Service temporarily unavailable"}` passed, because a STRING has a truthy
//     `.length`, so `models.length === 0` was false while `normalizeDiscoveredModels` coerced
//     it to `[]` downstream and deleted the rows.
//   - the "structural" test that was supposed to prevent all this only matched the NAME of the
//     last argument, so it certified unprotected sites. A test that checks a token cannot
//     evidence a property.
//
// These assert BEHAVIOUR: what the classifier decides, and what the real route does to the
// database, for every shape that has ever wiped a catalog.
// ---------------------------------------------------------------------------

test("BF-1: a nested error envelope is not a catalog, at any container depth", () => {
  const notCatalogs = [
    { data: { error: { code: 429, message: "quota exceeded" } } },
    { data: { errors: [{ status: "429", detail: "quota" }] } },
    { data: { fault: { faultstring: "Invalid ApiKey" } } },
    { data: { detail: "Not authenticated" } },
    { data: "Service temporarily unavailable" },
    { data: 503 },
    { data: {} },
    { data: null },
    { models: { error: { code: 500 } } },
    { result: { fault: { faultstring: "nope" } } },
    { data: [], error: { code: 429, message: "quota" } },
  ];
  for (const body of notCatalogs) {
    assert.equal(
      hasCatalogCollection(body),
      false,
      `must not read as a catalog: ${JSON.stringify(body)}`
    );
  }
});

test("BF-1: real catalog shapes are still catalogs, including empty ones and nested envelopes", () => {
  const catalogs = [
    [{ id: "a" }],
    { data: [{ id: "a" }] },
    { data: [] },
    { models: {} },
    { models: { a: { id: "a", name: "A" } } },
    { result: [{ id: "a" }] },
    { results: [{ id: "a" }] },
    { availableModels: [{ id: "a" }] },
    { items: [{ id: "a" }] },
    // Real providers wrap the catalog one envelope deeper and that is still a catalog:
    // zai-web answers `{data:{data:[...]}}` and qwen-web `{data:{models:[...]}}`. A guard that
    // only looks at the top container rejects both and serves local_catalog instead.
    { data: { data: [{ id: "a" }] } },
    { data: { models: [{ id: "a" }] } },
    { data: { models: {} } },
    { result: { items: [{ id: "a" }] } },
  ];
  for (const body of catalogs) {
    assert.equal(
      hasCatalogCollection(body),
      true,
      `must read as a catalog: ${JSON.stringify(body)}`
    );
  }
});

for (const provider of WIPE_PROVIDERS) {
  test(`BF-1: ${provider} survives a nested error envelope on GET`, async () => {
    await resetStorage();
    const connectionId = await seedConnection(provider, `bf1n-${provider}`);
    await seedCatalog(provider, connectionId);

    globalThis.fetch = (async () =>
      jsonResponse({
        data: { error: { code: 429, message: "quota exceeded" } },
      })) as typeof fetch;

    const route = await import("../../src/app/api/providers/[id]/models/route.ts");
    await route.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: Promise.resolve({ id: connectionId }) }
    );

    const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
    assert.equal(rows.length, 2, `${provider} catalog must survive a nested error envelope`);
  });
}

// The scalar-container defect lives in the GENERIC parser branches (`data.data || data.models`),
// which `glm*` and the anthropic-compatible families use. Testing it against a provider that
// goes through its own dedicated parser proves nothing — the first version of this test did
// exactly that and stayed green with the fix reverted.
const GENERIC_PARSE_PROVIDERS = ["glm", "anthropic-compatible-fireworks"] as const;

for (const provider of GENERIC_PARSE_PROVIDERS) {
  test(`BF-2: ${provider} survives a scalar under the container key on GET`, async () => {
    await resetStorage();
    const connectionId = await seedConnection(provider, `bf2-${provider}`);
    await seedCatalog(provider, connectionId);

    // A very common degraded-upstream shape. `"text".length` is truthy, so a length-based
    // guard sails past it and the non-array is coerced to [] downstream.
    globalThis.fetch = (async () =>
      jsonResponse({ data: "Service temporarily unavailable" })) as typeof fetch;

    const route = await import("../../src/app/api/providers/[id]/models/route.ts");
    await route.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: Promise.resolve({ id: connectionId }) }
    );

    const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
    assert.equal(rows.length, 2, `${provider} catalog must survive a scalar container`);
  });
}

test("BF-2: a non-array never counts as a model list at the classifier level", () => {
  // The guard must not rely on `.length`: a string, a number and an object all have lengths or
  // are truthy, and all get coerced to [] downstream.
  for (const body of [
    { data: "Service temporarily unavailable" },
    { data: 503 },
    { models: { error: { code: 429 } } },
  ]) {
    assert.equal(hasCatalogCollection(body), false, JSON.stringify(body));
  }
});

test("BF-1/BF-2: POST /sync-models refuses both shapes and keeps the rows", async () => {
  for (const body of [
    { data: { error: { code: 429, message: "quota" } } },
    { data: "Service temporarily unavailable" },
  ]) {
    await resetStorage();
    const provider = "glm";
    const connectionId = await seedConnection(provider, `bf12-sync-${Math.random()}`);
    await seedCatalog(provider, connectionId);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/providers/") && url.includes("/models?")) {
        const parsed = new URL(url);
        return providersRoute.GET(
          new Request(`http://localhost${parsed.pathname}${parsed.search}`),
          { params: Promise.resolve({ id: parsed.pathname.split("/")[3] }) }
        );
      }
      if (url.includes("__readiness")) return new Response(null, { status: 404 });
      return jsonResponse(body);
    }) as typeof fetch;

    const res = await syncRoute.POST(
      new Request(`http://localhost/api/providers/${connectionId}/sync-models`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: connectionId }) }
    );
    const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
    assert.equal(rows.length, 2, `catalog must survive ${JSON.stringify(body)}`);
    assert.notEqual(res.status, 200, "a sync built on a non-catalog must not report success");
  }
});

test("BF-2: a genuinely empty catalog still persists (the guard is not simply refusing everything)", async () => {
  await resetStorage();
  const provider = "glm";
  const connectionId = await seedConnection(provider, "bf2-empty-legit");
  await seedCatalog(provider, connectionId);

  // A real, authoritative empty answer: an array under the container, zero entries.
  globalThis.fetch = (async () => jsonResponse({ data: [] })) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/models/route.ts");
  await route.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
  assert.equal(rows.length, 0, "an authoritative empty catalog must still clear the rows");
});
