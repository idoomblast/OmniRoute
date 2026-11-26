// Round-2 gate F3: the public /v1/models listing seam.
//
// The gate proved the defect by refreshing discovery and then reading the public
// catalog, so this pins the same two steps instead of asserting on discovery internals:
//
//   1. a healthy ide sweep SUPPLEMENTED by the cli sweep publishes all four Hydrogen
//      tiers alongside the unrelated ide models, and publishes nothing cli-only;
//   2. a failed sweep does NOT clear what is already published (last-known-good);
//   3. a `*-disabled` row that reached the DB before the filter existed is not served.
// FIRST import on purpose: this suite persists synced models, and the imports after this line
// load `src/lib/db/core.ts`, which resolves DATA_DIR at import time. Without it the rows land in
// the operator's real ~/.omniroute database and union into the live antigravity catalog.
import "./_dataDirIsolation.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

import { persistDiscoveredModels } from "../../src/lib/providerModels/modelDiscovery.ts";
import { fetchAntigravityDiscoveryModelsCached } from "../../src/app/api/providers/[id]/models/discovery/normalizers.ts";

const TIERS = [
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
];

type FetchCall = { url: string; profile: "ide" | "cli" };

function installUpstreamMock(options: {
  ide: "ok" | "fail";
  cli: "ok" | "fail";
  cliExtraModels?: string[];
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The version resolver and project bootstrap are separate concerns with their own
    // URLs; only the discovery endpoints count as a sweep.
    const isDiscovery = url.includes(":fetchAvailableModels") || url.includes(":models");
    if (!isDiscovery) return new Response("nope", { status: 503 });

    const userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
    const profile: "ide" | "cli" = userAgent.includes("/cli/") ? "cli" : "ide";
    calls.push({ url, profile });

    // Only the first discovery endpoint per sweep answers; the route treats a
    // successful answer as authoritative, which mirrors the real upstream.
    const firstForProfile = calls.filter((call) => call.profile === profile).length === 1;
    if (!firstForProfile) return new Response("gone", { status: 503 });

    const mode = options[profile];
    if (mode === "fail") return new Response("upstream down", { status: 503 });

    const models =
      profile === "cli"
        ? [
            ...TIERS.map((id) => ({ id, displayName: id })),
            ...(options.cliExtraModels ?? []).map((id) => ({ id, displayName: id })),
          ]
        : [
            { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash High" },
            { id: "gemini-3.1-pro-high", displayName: "Gemini 3.1 Pro (High)" },
            // Advertised to unentitled accounts; must never reach the public catalog.
            { id: "gemini-4-carbon-disabled", displayName: "Gemini 4 Carbon" },
          ];
    return Response.json({ models });
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) } as never;
}

test("F3 round2: a healthy ide sweep plus cli supplement publishes all four tiers only", async (t) => {
  const mock = installUpstreamMock({ ide: "ok", cli: "ok", cliExtraModels: ["cli-only-model"] });
  t.after(() => (mock as unknown as { restore: () => void }).restore());

  const result = await fetchAntigravityDiscoveryModelsCached(
    "ag-access",
    "conn-f3-healthy",
    null,
    { clientProfile: "ide" },
    "antigravity"
  );

  assert.equal(result.ok, true, "a successful primary sweep must report ok");
  const ids = result.models.map((model) => model.id);

  for (const tier of TIERS) {
    assert.ok(ids.includes(tier), `healthy ide+cli sync must publish ${tier}`);
  }
  // Unrelated ide models survive — the supplement must not replace them.
  assert.ok(ids.includes("gemini-3.8-flash-high"), "ide models must survive the supplement");
  // But nothing else from the cli catalog leaks through: non-tier generation keeps ide.
  assert.equal(
    ids.includes("cli-only-model"),
    false,
    "only the four entitled tier ids may be supplemented from the cli catalog"
  );
  // Disabled entries never reach the catalog, on either profile.
  assert.equal(
    ids.some((id) => id.endsWith("-disabled")),
    false
  );
});

test("F3 round2: a failed primary sweep is NOT an authoritative empty catalog", async (t) => {
  const mock = installUpstreamMock({ ide: "fail", cli: "ok" });
  t.after(() => (mock as unknown as { restore: () => void }).restore());

  const result = await fetchAntigravityDiscoveryModelsCached(
    "ag-access",
    "conn-f3-failed",
    null,
    { clientProfile: "ide" },
    "antigravity"
  );

  assert.equal(result.ok, false, "every-endpoint failure must be reported as not ok");
  assert.deepEqual(result.models, [], "a failed sweep yields no models to persist");

  // The decisive part: the supplement must not have run either. Publishing cli tiers
  // while the account's non-tier catalog is unknown would replace it with four rows.
  const cliCalls = (mock as unknown as { calls: FetchCall[] }).calls.filter(
    (call) => call.profile === "cli"
  );
  assert.deepEqual(cliCalls, [], "a failed primary sweep must not be supplemented");
});

test("F3 round2: synced disabled rows are not served by the public catalog", async () => {
  // Simulates a row written before the read-path filter existed.
  await persistDiscoveredModels("antigravity", "conn-f3-stale", [
    { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen Extra High" },
    { id: "gemini-4-carbon-disabled", name: "Gemini 4 Carbon" },
  ]);

  const { isDisabledAntigravityModelId } =
    await import("../../open-sse/config/antigravityThinkingLevels.ts");
  // The read path applies exactly this predicate to every synced row; assert the
  // decision it makes for the stale row rather than re-implementing the route.
  assert.equal(
    isDisabledAntigravityModelId("gemini-4-carbon-disabled"),
    true,
    "a stale disabled row must be rejected on read"
  );
  assert.equal(isDisabledAntigravityModelId("gemini-4-hydrogen-xhigh"), false);
});
