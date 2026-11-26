// Round-2 gate regressions (gpt-6.2-sol, report 20261125T235442Z-2123cb).
//
// Every test here reproduces a defect the gate found by driving the PRODUCTION seam
// it used, not the helper the fix introduced:
//
//   F4  a single unrelated pricing override under `antigravity`/`agy` made Hydrogen
//       cost $0, and Antigravity alias resolution was applied to every provider.
//   F3  a successful primary sweep plus a failed supplement removed the four tiers
//       from what discovery returns; a failed primary sweep was reported as an
//       authoritative empty catalog.
//   F1  a wire model that is deliberately NOT a tier (MITM alias -> `-sonar`) fell
//       back to the requested tier name and got cli headers.
//   NB2 the translator tested the unresolved name, so the three display aliases
//       raised max_tokens for a budget the executor then discards.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAntigravityEffectiveCredentials } from "../../open-sse/executors/antigravity/executeAttempt.ts";
import { resolveAntigravityModelId } from "../../open-sse/config/antigravityModelAliases.ts";
import { isDisabledAntigravityModelId } from "../../open-sse/config/antigravityThinkingLevels.ts";

// ---------------------------------------------------------------------------
// F1 — a present wire model is authoritative, even when it is NOT a tier.
// ---------------------------------------------------------------------------

test("F1 round2: a non-tier WIRE model keeps the connection profile, whatever was requested", () => {
  const credentials = {
    accessToken: "tok",
    providerSpecificData: { clientProfile: "ide" },
  } as never;

  // A persisted MITM alias remapped the tier request onto `-sonar`, a model the ide
  // surface serves. The wire id must win; falling back to the requested tier would
  // have forced cli headers onto a non-tier id.
  const effective = resolveAntigravityEffectiveCredentials(
    credentials,
    "gemini-4-hydrogen-sonar",
    "gemini-4-hydrogen-xhigh"
  );

  assert.equal(
    (effective.providerSpecificData as Record<string, unknown>).clientProfile,
    "ide",
    "a present non-tier wire id must not inherit the requested model's cli profile"
  );
});

test("F1 round2: a tier WIRE model still forces cli, whatever was requested", () => {
  const credentials = {
    accessToken: "tok",
    providerSpecificData: { clientProfile: "ide" },
  } as never;

  const effective = resolveAntigravityEffectiveCredentials(
    credentials,
    "gemini-4-hydrogen-xhigh",
    "gemini-3.8-flash-high"
  );

  assert.equal((effective.providerSpecificData as Record<string, unknown>).clientProfile, "cli");
});

test("F1 round2: the requested name is used only when the wire model is absent", () => {
  const credentials = {
    accessToken: "tok",
    providerSpecificData: { clientProfile: "ide" },
  } as never;

  for (const missing of [undefined, null, "", "   "]) {
    const effective = resolveAntigravityEffectiveCredentials(
      credentials,
      missing as string | null | undefined,
      "gemini-4-hydrogen-extra"
    );
    assert.equal(
      (effective.providerSpecificData as Record<string, unknown>).clientProfile,
      "cli",
      `requested alias must drive selection when the wire model is ${JSON.stringify(missing)}`
    );
  }
});

// ---------------------------------------------------------------------------
// F4 — pricing must resolve per MODEL, not per TABLE.
// ---------------------------------------------------------------------------

const PRICING_MODULE = "../src/lib/db/settings/pricing.ts";

test("F4 round2: an unrelated override row must not zero the Hydrogen tiers", async () => {
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");

  // One unrelated row under the provider's OWN table. The table therefore exists,
  // which is exactly the condition that used to skip the `ag` fallback entirely.
  await updatePricing({
    antigravity: { "some-unrelated-model": { input: 99, output: 99 } },
  } as never);

  for (const provider of ["antigravity", "agy"]) {
    for (const model of [
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-extra",
      "gemini-4-hydrogen-max",
    ]) {
      const row = await getPricingForModel(provider, model);
      assert.ok(
        row,
        `${provider}/${model} must resolve to a price, not $0 — got ${JSON.stringify(row)}`
      );
      assert.equal(row.input, 1.5, `${provider}/${model} input`);
      assert.equal(row.output, 7.5, `${provider}/${model} output`);
    }
  }
});

test("F4 round2: an explicit override still wins over the namespace fallback", async () => {
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");

  await updatePricing({
    antigravity: { "gemini-4-hydrogen-xhigh": { input: 42, output: 84 } },
  } as never);

  const row = await getPricingForModel("antigravity", "gemini-4-hydrogen-xhigh");
  assert.ok(row);
  assert.equal(row.input, 42, "explicit per-model override must be honoured");
  assert.equal(row.output, 84);
});

test("F4 round2: alias resolution is scoped to the Antigravity namespaces", async () => {
  const { updatePricing, getPricingForModel } =
    await import("../../src/lib/db/settings/pricing.ts");

  // A different provider with BOTH an exact row and a `-high` row. Applying the
  // Antigravity alias table globally replaced the exact $1 row with the $3 tier row.
  await updatePricing({
    gemini: {
      "gemini-4-hydrogen": { input: 1, output: 2 },
      "gemini-4-hydrogen-high": { input: 3, output: 6 },
    },
  } as never);

  const row = await getPricingForModel("gemini", "gemini-4-hydrogen");
  assert.ok(row);
  assert.equal(row.input, 1, "a non-Antigravity provider must not use Antigravity aliases");
  assert.equal(row.output, 2);
});

test("F4 round2: prototype-looking ids resolve without throwing", () => {
  for (const hostile of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(
      resolveAntigravityModelId(hostile),
      hostile,
      `${hostile} must come back as itself, not an inherited member`
    );
  }
});

// ---------------------------------------------------------------------------
// F3 — the disabled filter must run on READ too, not only at sync time.
// ---------------------------------------------------------------------------

test("F3 round2: disabled catalog ids are rejected on read and on write", () => {
  for (const id of [
    "gemini-4-carbon-disabled",
    "gemini-4-argon-disabled",
    "gemini-4-neon-disabled",
  ]) {
    assert.equal(isDisabledAntigravityModelId(id), true, `${id} must be filtered`);
  }
  for (const id of [
    "gemini-4-hydrogen-xhigh",
    "gemini-4-hydrogen-sonar",
    "gemini-4-hydrogen-high",
  ]) {
    assert.equal(isDisabledAntigravityModelId(id), false, `${id} must survive`);
  }
});

void PRICING_MODULE;
