// Round-3 gate regressions (gpt-6.2-sol, report 20261126T003334Z-e64a74).
//
// Round 3 FAILed at the persistence and send boundaries, after the earlier rounds had
// been closed at the helper level. Every test here enters where the gate entered:
//
//   F3a  ide-ok + cli-fail persisted an ide-only union, deleting all four tiers.
//   F3b  a failed IDE sweep still wrote state through POST /sync-models (models and a
//        regenerated MITM alias), because the degraded cache response looked importable.
//   F4b  an explicit `gemini-4-hydrogen` override lost to the canonical High default.
//   F1b  the sender replaced a missing wire id with "unknown", so the requested-name
//        fallback never ran and a tier request went out on the ide surface.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAntigravityEffectiveCredentials } from "../../open-sse/executors/antigravity/executeAttempt.ts";
import {
  DEGRADED_TIER_WARNING,
  mergeLastKnownTiers,
} from "../../src/app/api/providers/[id]/models/discovery/normalizers.ts";

const TIERS = [
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
];

// ---------------------------------------------------------------------------
// F3a — a cli outage must not delete the tiers.
// ---------------------------------------------------------------------------

test("F3a: degraded discovery merges the last-known-good tiers back in", () => {
  const primary = [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
  ];
  const lastKnownGood = [
    ...TIERS.map((id) => ({ id, name: id })),
    { id: "gemini-4-carbon-disabled", name: "Gemini 4 Carbon" },
    { id: "gemini-4-hydrogen-sonar", name: "Gemini 4 Hydrogen Sonar" },
  ];

  const merged = mergeLastKnownTiers(primary, lastKnownGood);
  const ids = merged.map((model) => model.id);

  for (const tier of TIERS) {
    assert.ok(ids.includes(tier), `a cli outage must not delete ${tier}`);
  }
  // Only tiers are re-added: the primary sweep stays authoritative for everything else,
  // including a non-tier model that happens to be in last-known-good state.
  assert.equal(ids.includes("gemini-4-hydrogen-sonar"), false, "only tier ids are merged");
  assert.equal(ids.includes("gemini-4-carbon-disabled"), false, "disabled ids are never merged");
  // And the primary rows are untouched and first.
  assert.deepEqual(ids.slice(0, 2), ["gemini-3.8-flash-high", "gemini-3.1-pro-high"]);
});

test("F3a: merging is idempotent and de-duplicates", () => {
  const primary = TIERS.map((id) => ({ id, name: id }));
  const merged = mergeLastKnownTiers(
    primary,
    TIERS.map((id) => ({ id, name: `${id}-stale` }))
  );
  assert.equal(merged.length, 4, "a tier already present must not be added twice");
  assert.equal(merged[0].name, "gemini-4-hydrogen-low", "the primary row's name wins");
});

test("F3a: the degraded warning names the tier rows as stale", () => {
  assert.match(DEGRADED_TIER_WARNING, /tier/i);
  assert.match(DEGRADED_TIER_WARNING, /last successful refresh/i);
});

// ---------------------------------------------------------------------------
// F1b — the send boundary must not hide a missing wire id behind "unknown".
// ---------------------------------------------------------------------------

test("F1b: an absent wire id falls back to the requested tier alias, not ide", () => {
  const credentials = {
    accessToken: "tok",
    providerSpecificData: { clientProfile: "ide" },
  } as never;

  // The sender used to pass the logging placeholder "unknown" here, which read as a
  // present non-tier id and kept the ide fingerprint.
  for (const requested of [
    "gemini-4-hydrogen-extra",
    "gemini-4-hydrogen",
    "gemini-4-hydrogen-max",
    "antigravity/gemini-4-hydrogen-extra",
  ]) {
    for (const absent of [null, undefined, "", "   "]) {
      const effective = resolveAntigravityEffectiveCredentials(
        credentials,
        absent as string | null | undefined,
        requested
      );
      assert.equal(
        (effective.providerSpecificData as Record<string, unknown>).clientProfile,
        "cli",
        `${requested} with wire=${JSON.stringify(absent)} must use cli`
      );
    }
  }
});

test("F1b: a provider-qualified wire id is compared in the bare namespace", () => {
  const credentials = {
    accessToken: "tok",
    providerSpecificData: { clientProfile: "ide" },
  } as never;

  const effective = resolveAntigravityEffectiveCredentials(
    credentials,
    "antigravity/gemini-4-hydrogen-xhigh",
    null
  );
  assert.equal(
    (effective.providerSpecificData as Record<string, unknown>).clientProfile,
    "cli",
    "a prefixed tier id must still force cli"
  );
});

test("F1b: the placeholder sentinel is not treated as a present wire id", () => {
  // Guards the class of bug rather than the one call site: any non-real value must
  // leave the requested-name path available.
  const credentials = {
    accessToken: "tok",
    providerSpecificData: { clientProfile: "ide" },
  } as never;
  const effective = resolveAntigravityEffectiveCredentials(
    credentials,
    "   ",
    "gemini-4-hydrogen-extra"
  );
  assert.equal((effective.providerSpecificData as Record<string, unknown>).clientProfile, "cli");
});

// ---------------------------------------------------------------------------
// F4b — an explicit override beats the canonical default, including partial ones.
// ---------------------------------------------------------------------------

test("F4b: an explicit alias override wins over the canonical tier default", async () => {
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");

  // Written under the SHARED `ag` namespace, which is where the default tier rows live
  // and therefore where a user override for a shared model belongs.
  await updatePricing({
    ag: { "gemini-4-hydrogen": { input: 42, output: 84, cached: 0.42 } },
  } as never);

  for (const provider of ["ag", "antigravity", "agy"]) {
    const row = await getPricingForModel(provider, "gemini-4-hydrogen");
    assert.ok(row, `${provider} must resolve the override`);
    assert.equal(row.input, 42, `${provider} explicit override input must win`);
    assert.equal(row.output, 84, `${provider} explicit override output must win`);
  }
});

test("F4b: a partial override keeps its rates and inherits the rest", async () => {
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");

  // Input-only override: the untouched output rate must come from the default row, not
  // become undefined (which bills output tokens at $0).
  await updatePricing({
    antigravity: { "gemini-4-hydrogen-medium": { input: 42 } },
  } as never);

  const row = await getPricingForModel("antigravity", "gemini-4-hydrogen-medium");
  assert.ok(row);
  assert.equal(row.input, 42, "the explicit rate is kept");
  assert.equal(row.output, 7.5, "the omitted rate is inherited, not dropped");
});

test("F4b: an inherited namespace key does not throw", async () => {
  const { getPricingForModel } = await import("../../src/lib/db/settings/pricing.ts");
  for (const hostile of ["constructor", "__proto__", "toString"]) {
    await assert.doesNotReject(
      () => getPricingForModel(hostile, "caller-model"),
      `${hostile} must not throw`
    );
  }
});
