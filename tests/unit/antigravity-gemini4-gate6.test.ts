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
const { hasCatalogCollection, hasErrorEnvelope, catalogParseDiverges } =
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

async function seedConnection(
  provider: string,
  connectionId: string,
  providerSpecificData: Record<string, unknown> = {}
) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${connectionId}`,
    apiKey: "test-key-" + connectionId,
    isActive: true,
    providerSpecificData,
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
    // Non-empty ARRAYS of non-model values. Each has length 1, so a length-based emptiness
    // test never fires, yet every one persists zero models — this is the shape that wiped
    // watsonx/oci/sap after round 10.
    { data: [{ error: { code: 429, message: "quota exceeded" } }] },
    { data: [{ message: "quota exceeded", code: 429 }] },
    { data: ["Service temporarily unavailable"] },
    { data: [null] },
    { data: [{}] },
    { data: [42] },
    [{ error: { code: 429 } }],
    [{ message: "rate limited" }],
    ["Service temporarily unavailable"],
    { models: [{ error: { code: 500 } }] },
    { result: [{ message: "unauthorized" }] },
    // An EMPTY catalog next to an error signal. The array shape is valid and empty, so a
    // container-level test alone reads it as "this account has nothing" — the signal lives in
    // a SIBLING key. This is the shape that wiped watsonx/oci/sap after round 11.
    { data: [], message: "Quota exceeded, please retry later", code: 429 },
    { data: [], success: false, message: "unauthorized" },
    { data: [], status: "error", reason: "quota_exceeded" },
    { models: [], success: false, error_code: "quota" },
    { data: [], note: "service degraded" },
    { data: [], error: { code: 429 } },
    // A bare numeric status is enough — no message string to fall back on.
    { data: [], code: 429 },
    { data: [], code: 503 },
    { models: {}, code: 500 },
    // Error dialects the enumerated-key list did not spell. Each of these was a live wipe:
    // an allowlist of known error keys is whack-a-mole, which is why the rule is now
    // default-deny on unrecognised envelope keys.
    { data: [], msg: "Too Many Requests" },
    { data: [], statusCode: 429 },
    { data: [], status_code: 429 },
    { data: [], errmsg: "quota exceeded" },
    { data: [], errorMessage: "quota exceeded" },
    { data: [], meta: { code: 429 } },
    { data: [], result: { code: 429 } },
    { data: [], code: -32000 },
    { data: [], Code: 429 },
    { data: [], Message: "quota exceeded" },
    { data: [], Status: "error" },
    { data: [], whatever: "boom" },
    { data: [], reason: { why: "quota" } },
    // NON-empty error envelopes are still errors — the emptiness fix must not go too far.
    { data: [], errors: [{ code: 429 }] },
    { data: [], error: { code: 429 } },
    { data: [], detail: "quota exceeded" },
    { data: [], error: true },
    // An empty container must not launder a sibling that is really an error envelope. Both keys
    // here are catalog containers, so the per-key "persists nothing" path handles them; the
    // shape check is what refuses it.
    { data: {}, result: { code: 429 } },
    { data: {}, result: { error: { code: 429 } } },
    { models: {}, result: ["Service unavailable"] },
    // A junk array must not be rescued by an empty sibling container.
    { data: [{ message: "quota" }], result: [] },
    { data: [null], models: {} },
    { data: ["Service temporarily unavailable"], items: [] },
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
    // One non-model element alongside a real one is still a catalog (partial junk is normal).
    { data: [{ id: "a" }, { message: "ignored" }] },
    // The other identity fields the repo's own normalizers accept.
    { data: [{ model: "gpt-x" }] },
    { data: [{ name: "Friendly Name" }] },
    // An empty catalog with a BENIGN sibling signal is still a real empty answer.
    { data: [], status: "ok" },
    { data: [], success: true },
    { object: "list", data: [] },
    { data: [], code: 200 },
    { data: [], count: 0 },
    { data: [], has_more: false },
    { data: [], note: null, next: null },
    { data: [], meta: {} },
    // An EMPTY error envelope is not an error. Cloudflare Workers AI sends
    // `{result, success, errors: [], messages: []}` on EVERY successful response; counting
    // `errors: []` as a failure rejected the live catalog and served the local fallback.
    { data: [], errors: [] },
    { data: [], error: {} },
    { data: [], detail: {} },
    { data: [], error: "" },
    { data: [], error: null },
    // Real models win over junk in a sibling container.
    { data: [{ message: "quota" }], models: [{ id: "real" }] },
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

// ---------------------------------------------------------------------------
// BF-1/BF-2 (round 10) — non-empty ARRAYS of non-model values, per parse class.
//
// Every fixture above is classifier-level. The reviewer's point in BF-3 was that a classifier
// test cannot prove the ROUTE refuses these, because the route has its own length-based branch
// (and its own loop). These drive the real handler for each parse class the repo has:
//   - the dedicated normalizer branches (watsonx / oci / sap)
//   - the generic `data.data || data.models` branch (glm)
//   - the openai-compatible endpoint loop
// ---------------------------------------------------------------------------

const ARRAY_JUNK = [
  {
    label: "one-element error array",
    body: { data: [{ error: { code: 429, message: "quota" } }] },
  },
  { label: "one-element status string array", body: { data: ["Service temporarily unavailable"] } },
  { label: "one-element null array", body: { data: [null] } },
];

for (const provider of ["watsonx", "oci", "sap"] as const) {
  for (const { label, body } of ARRAY_JUNK) {
    test(`BF-1: ${provider} survives a ${label} on GET`, async () => {
      await resetStorage();
      const connectionId = await seedConnection(provider, `bf1a-${provider}-${label.length}`);
      await seedCatalog(provider, connectionId);

      globalThis.fetch = (async () => jsonResponse(body)) as typeof fetch;

      const route = await import("../../src/app/api/providers/[id]/models/route.ts");
      await route.GET(
        new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
        { params: Promise.resolve({ id: connectionId }) }
      );

      const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
      assert.equal(rows.length, 2, `${provider} catalog must survive: ${label}`);
    });
  }
}

test("BF-2: glm survives a one-element error array on GET", async () => {
  await resetStorage();
  const connectionId = await seedConnection("glm", "bf2-array-glm");
  await seedCatalog("glm", connectionId);

  globalThis.fetch = (async () =>
    jsonResponse({ data: [{ error: { code: 429, message: "quota" } }] })) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/models/route.ts");
  await route.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection("glm", connectionId);
  assert.equal(rows.length, 2, "glm catalog must survive a non-model array");
});

test("BF-2: the openai-compatible endpoint loop does not break on a non-model array", async () => {
  await resetStorage();
  const provider = "openai-compatible-test";
  // A baseUrl is REQUIRED to reach the endpoint loop at all: without it the route answers
  // "No base URL configured" and the loop never runs, which made the first version of this
  // test pass for the wrong reason.
  const connectionId = await seedConnection(provider, "bf2-loop", {
    baseUrl: "https://loop-test.invalid/v1",
    autoFetchModels: true,
  });
  await seedCatalog(provider, connectionId);
  let probed = 0;

  // The loop treats a `break` as "this endpoint answered authoritatively". A one-element
  // non-model array must not count as an answer.
  globalThis.fetch = (async () => {
    probed++;
    return jsonResponse({ data: [{ error: { code: 429, message: "quota" } }] });
  }) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/models/route.ts");
  await route.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
  assert.ok(probed > 0, "the test must actually reach the endpoint loop");
  assert.equal(rows.length, 2, "endpoint loop must not accept a non-model array as success");
});

// ---------------------------------------------------------------------------
// Round 12 — an EMPTY catalog next to an error signal.
//
// `200 {"data":[],"message":"Quota exceeded","code":429}` has a valid, empty array under the
// container key, so every content test on that VALUE passes. The error lives in a sibling key.
// These drive the real handler, because that is where the wipe was reproduced.
// ---------------------------------------------------------------------------

const ERROR_SIGNAL_BODIES = [
  {
    label: "message+code 429",
    body: { data: [], message: "Quota exceeded, please retry later", code: 429 },
  },
  { label: "success:false", body: { data: [], success: false, message: "unauthorized" } },
  { label: "status:error", body: { data: [], status: "error", reason: "quota_exceeded" } },
  { label: "junk array + empty sibling", body: { data: [{ message: "quota" }], result: [] } },
];

for (const provider of ["watsonx", "oci", "sap"] as const) {
  for (const { label, body } of ERROR_SIGNAL_BODIES) {
    test(`BF-1: ${provider} survives an empty catalog with an error signal (${label}) on GET`, async () => {
      await resetStorage();
      const connectionId = await seedConnection(provider, `sig-${provider}-${label.length}`);
      await seedCatalog(provider, connectionId);

      globalThis.fetch = (async () => jsonResponse(body)) as typeof fetch;

      const route = await import("../../src/app/api/providers/[id]/models/route.ts");
      await route.GET(
        new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
        { params: Promise.resolve({ id: connectionId }) }
      );

      const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
      assert.equal(rows.length, 2, `${provider} catalog must survive: ${label}`);
    });
  }
}

test("BF-1: an empty catalog with no error signal still clears the rows", async () => {
  await resetStorage();
  const connectionId = await seedConnection("watsonx", "sig-benign");
  await seedCatalog("watsonx", connectionId);

  // Positive control: the guard must not simply refuse everything.
  globalThis.fetch = (async () => jsonResponse({ object: "list", data: [] })) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/models/route.ts");
  await route.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection("watsonx", connectionId);
  assert.equal(rows.length, 0, "a genuinely empty answer must still persist emptiness");
});

test("BF-1: POST /sync-models refuses an empty catalog with an error signal", async () => {
  await resetStorage();
  const connectionId = await seedConnection("watsonx", "sig-post");
  await seedCatalog("watsonx", connectionId);

  globalThis.fetch = (async () =>
    jsonResponse({
      data: [],
      message: "Quota exceeded, please retry later",
      code: 429,
    })) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
  await route.POST(
    new Request(`http://localhost/api/providers/${connectionId}/sync-models`, { method: "POST" }),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection("watsonx", connectionId);
  assert.equal(rows.length, 2, "sync must not delete rows on an error-signal empty catalog");
});

// ---------------------------------------------------------------------------
// Round 13 — error dialects the enumerated key list never spelled.
//
// These wiped the catalog in a live probe: `{"data":[],"msg":"Too Many Requests"}`,
// `{"data":[],"statusCode":429}`, `{"data":[],"meta":{"code":429}}`,
// `{"data":[],"code":-32000}`, `{"data":[],"Message":"quota"}`. The fix is not a longer list —
// it is default-deny on unrecognised envelope keys. Driving the real handler is the only way to
// show the wipe is closed.
// ---------------------------------------------------------------------------

const DIALECT_BODIES = [
  { label: "msg", body: { data: [], msg: "Too Many Requests" } },
  { label: "statusCode", body: { data: [], statusCode: 429 } },
  { label: "meta.code", body: { data: [], meta: { code: 429 } } },
  { label: "negative code", body: { data: [], code: -32000 } },
  { label: "Message (case)", body: { data: [], Message: "quota exceeded" } },
  { label: "junk container + sibling error", body: { data: {}, result: { code: 429 } } },
];

for (const { label, body } of DIALECT_BODIES) {
  test(`BF-1: watsonx survives an unenumerated error dialect (${label}) on GET`, async () => {
    await resetStorage();
    const connectionId = await seedConnection("watsonx", `dial-${label.length}`);
    await seedCatalog("watsonx", connectionId);

    globalThis.fetch = (async () => jsonResponse(body)) as typeof fetch;

    const route = await import("../../src/app/api/providers/[id]/models/route.ts");
    await route.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: Promise.resolve({ id: connectionId }) }
    );

    const rows = await getSyncedAvailableModelsForConnection("watsonx", connectionId);
    assert.equal(rows.length, 2, `catalog must survive: ${label}`);
  });
}

test("BF-1: a shape-valid empty catalog with a benign pagination envelope still clears", async () => {
  await resetStorage();
  const connectionId = await seedConnection("watsonx", "dial-benign");
  await seedCatalog("watsonx", connectionId);

  globalThis.fetch = (async () =>
    jsonResponse({ object: "list", data: [], has_more: false, count: 0 })) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/models/route.ts");
  await route.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection("watsonx", connectionId);
  assert.equal(rows.length, 0, "a genuinely empty answer must still clear the rows");
});

// A nested real catalog cannot be asserted at the ROUTE level for watsonx: its parser reads
// `data` as an array, so `{data:{models:[...]}}` legitimately yields zero models there and the
// row count says nothing about the classifier. The property that matters — a nested real catalog
// is NOT mistaken for an empty or broken body — belongs on the classifier, and is covered by the
// `{data:{data:[...]}}` / `{data:{models:[...]}}` fixtures in the positive set above.

// ---------------------------------------------------------------------------
// Round 14 — the emptiness rule must not reject a REAL success envelope.
//
// Cloudflare Workers AI answers every SUCCESSFUL discovery with
// `{result: [...], success: true, errors: [], messages: []}`. Counting `errors: []` as an error
// envelope made the guard reject the live catalog at every site and serve the 13-entry local
// fallback instead — a silent regression that the existing Cloudflare test never saw because its
// fixture omitted the field. This is the inverse risk of default-deny: refusing too much.
// ---------------------------------------------------------------------------

test("BF-1: a Cloudflare success envelope is a catalog, not an error", async () => {
  await resetStorage();
  const connectionId = await seedConnection("cloudflare-ai", "cf-envelope", {
    accountId: "acc-test",
  });

  globalThis.fetch = (async () =>
    jsonResponse({
      result: [{ id: "uuid-1", name: "@cf/meta/llama-3-8b-instruct" }],
      success: true,
      errors: [],
      messages: [],
    })) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/models/route.ts");
  const res = await route.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: Promise.resolve({ id: connectionId }) }
  );
  const body = (await res.json()) as { source?: string; models?: Array<{ id: string }> };

  assert.equal(res.status, 200);
  assert.equal(body.source, "api", "the live Cloudflare catalog must be used, not the fallback");
  assert.deepEqual(
    (body.models ?? []).map((model) => model.id),
    ["@cf/meta/llama-3-8b-instruct"]
  );
});

test("BF-1: an empty error envelope does not make a real catalog an error", () => {
  // The classifier level, for every spelling of "empty".
  for (const body of [
    { result: [{ name: "@cf/x" }], success: true, errors: [], messages: [] },
    { data: [{ id: "a" }], error: {} },
    { data: [{ id: "a" }], detail: {} },
    { data: [{ id: "a" }], error: "" },
    { data: [{ id: "a" }], error: null },
    { data: [{ id: "a" }], error: false },
  ]) {
    assert.equal(hasErrorEnvelope(body), false, JSON.stringify(body));
    assert.equal(hasCatalogCollection(body), true, JSON.stringify(body));
  }
});

test("BF-1: a NON-empty error envelope is still an error", () => {
  for (const body of [
    { data: [], errors: [{ code: 429 }] },
    { data: [], error: { code: 429 } },
    { data: [], detail: "quota exceeded" },
    { data: [], error: true },
    { data: [], fault: { faultstring: "nope" } },
  ]) {
    assert.equal(hasErrorEnvelope(body), true, JSON.stringify(body));
    assert.equal(hasCatalogCollection(body), false, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
// Round 14, BF-3 — a body can carry a model that its own parser cannot read.
//
// `hasCatalogCollection` is a BODY-level question: it hunts the whole envelope for something
// model-shaped. Each provider's parser reads ONE key (`data.data`, `data.models`, `result`, ...).
// `{"data": [], "models": [{"id":"x"}]}` therefore passes the guard and parses to zero, and the
// route then persisted that zero — deleting the rows the body was carrying while answering 200.
// The guard must ask whether the parse agrees with the body, not only whether the body looks like
// a catalog.
// ---------------------------------------------------------------------------

test("BF-3: the divergence helper only fires when models exist that the parse did not see", () => {
  const carrying = [
    { data: [], models: [{ id: "x" }] },
    { data: [], result: [{ id: "x" }] },
    { data: [], data2: undefined, models: [{ name: "x" }] },
    { result: [{ model: "x" }], success: true, errors: [] },
  ];
  for (const body of carrying) {
    assert.equal(catalogParseDiverges(body, 0), true, JSON.stringify(body));
    // A successful parse is never a divergence.
    assert.equal(catalogParseDiverges(body, 1), false, JSON.stringify(body));
  }
  const genuinelyEmpty = [{ data: [] }, { models: [] }, { data: [], success: true, errors: [] }];
  for (const body of genuinelyEmpty) {
    assert.equal(catalogParseDiverges(body, 0), false, JSON.stringify(body));
  }
});

for (const provider of GENERIC_PARSE_PROVIDERS) {
  test(`BF-3: ${provider} keeps its rows when the body carries an unparseable model`, async () => {
    await resetStorage();
    const connectionId = await seedConnection(provider, `bf3-${provider}`);
    await seedCatalog(provider, connectionId);

    // `data.data` is an array, so the generic parser takes it — and it is empty. The only model
    // in the body sits under a key that parser never reads.
    globalThis.fetch = (async () =>
      jsonResponse({ data: [], models: [{ id: "unparseable-model" }] })) as typeof fetch;

    const route = await import("../../src/app/api/providers/[id]/models/route.ts");
    const res = await route.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: Promise.resolve({ id: connectionId }) }
    );
    const body = (await res.json()) as { models?: unknown[] };

    const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
    assert.equal(rows.length, 2, `${provider} catalog must survive a body/parser divergence`);
    assert.notEqual(body.models?.length, 0, `${provider} must not answer an empty catalog`);
  });
}

test("BF-3: POST /sync-models does not persist the divergent empty either", async () => {
  const provider = "glm";
  await resetStorage();
  const connectionId = await seedConnection(provider, "bf3-sync");
  await seedCatalog(provider, connectionId);

  // The sync route re-reads the probe over loopback, so the mock must serve the REAL models
  // handler for that call and only fake the upstream. A blanket mock would hand the raw body to
  // the sync route as if it were a discovery response, which is not what production does.
  const body = { data: [], models: [{ id: "unparseable-model" }] };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/providers/") && url.includes("/models?")) {
      const parsed = new URL(url);
      return providersRoute.GET(new Request(`http://localhost${parsed.pathname}${parsed.search}`), {
        params: Promise.resolve({ id: parsed.pathname.split("/")[3] }),
      });
    }
    if (url.includes("__readiness")) return new Response(null, { status: 404 });
    return jsonResponse(body);
  }) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
  await route.POST(
    new Request(`http://localhost/api/providers/${connectionId}/sync-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
  assert.equal(rows.length, 2, "sync must not persist a parser artefact as an empty catalog");
});

test("BF-3: a genuinely empty catalog still clears stale rows", async () => {
  const provider = "glm";
  await resetStorage();
  const connectionId = await seedConnection(provider, "bf3-empty");
  await seedCatalog(provider, connectionId);

  // No model anywhere and a benign envelope: this IS the account saying "I have nothing".
  globalThis.fetch = (async () => jsonResponse({ data: [] })) as typeof fetch;

  const route = await import("../../src/app/api/providers/[id]/models/route.ts");
  await route.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: Promise.resolve({ id: connectionId }) }
  );

  const rows = await getSyncedAvailableModelsForConnection(provider, connectionId);
  assert.equal(rows.length, 0, "an authoritative empty answer must still clear the catalog");
});

test("BF-1: an explicit `error: false` next to an empty catalog is a real empty catalog", () => {
  // The OpenAI-dialect spelling several proxies emit. `false` is the statement "no error", but
  // the benign-envelope rule only knew about pagination flags, so this refused a legitimate
  // empty answer and kept stale rows forever.
  for (const body of [
    { data: [], error: false },
    { data: [], errors: false },
    { result: [], success: true, errors: [], messages: [] },
  ]) {
    assert.equal(hasErrorEnvelope(body), false, JSON.stringify(body));
    assert.equal(hasCatalogCollection(body), true, JSON.stringify(body));
  }
  // …while a truthy flag or a message next to the empty list is still an error report.
  for (const body of [
    { data: [], error: true },
    { data: [], message: "Quota exceeded" },
    { data: [], code: 429 },
  ]) {
    assert.equal(hasCatalogCollection(body), false, JSON.stringify(body));
  }
});
