// Gemini 4 Hydrogen on the Antigravity / AGY (Cloud Code) surface.
//
// Wire facts measured against the live backend on 2026-11-26 with a consumer
// Antigravity OAuth token:
//   - `:fetchAvailableModels` fetched with the cli client profile advertises
//     `gemini-4-hydrogen-{low,medium,high,xhigh}` (groupedModels entry "Gemini 4
//     Hydrogen", supportedThinkingLevels Low/Medium/High/"Extra High") at
//     maxOutputTokens 262144, plus `gemini-4-hydrogen-sonar` as a distinct
//     65536-output model. `xhigh` carries the thinkingLevel sentinel 100.
//   - The tier ids are served by the cli client profile ONLY. With the ide profile
//     (the repo default) all of them answer 404 "Requested entity was not found"
//     and are absent from the ide catalog (17 vs 26 models).
//   - `gemini-4-hydrogen-sonar` does NOT implement XHIGH: it answers 400
//     "Thinking level is unsupported: THINKING_LEVEL_XHIGH" for the fourth rung —
//     one more reason tier ids must never resolve onto it.
//   - Carbon/Argon/Neon exist in the catalog only as `*-disabled` entries.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_MODEL_ALIASES,
  ANTIGRAVITY_PUBLIC_MODELS,
  resolveAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";
import {
  antigravityGemini4TierFromModelId,
  antigravityGemini4TierForBudget,
  antigravityGemini4TierModelForTier,
  isAntigravityGemini4TierModel,
  resolveAntigravityClientProfileForModel,
} from "../../open-sse/config/antigravityThinkingLevels.ts";
import {
  AntigravityExecutor,
  preserveAntigravityGemini4TierRequest,
} from "../../open-sse/executors/antigravity.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";

const TIER_IDS = [
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
] as const;

test("every Gemini 4 tier id passes through the alias layer untouched", () => {
  for (const modelId of TIER_IDS) {
    assert.equal(resolveAntigravityModelId(modelId), modelId, `${modelId} must stay itself`);
  }
});

test("display ids resolve onto tier ids, never onto -sonar", () => {
  // -sonar does not implement XHIGH, so no request may ever collapse onto it.
  assert.equal(resolveAntigravityModelId("gemini-4-hydrogen"), "gemini-4-hydrogen-high");
  assert.equal(resolveAntigravityModelId("gemini-4-hydrogen-extra"), "gemini-4-hydrogen-xhigh");
  assert.equal(resolveAntigravityModelId("gemini-4-hydrogen-max"), "gemini-4-hydrogen-xhigh");
  for (const id of ["gemini-4-hydrogen-sonar"]) {
    // -sonar itself is a real upstream id and must pass through as itself.
    assert.equal(resolveAntigravityModelId(id), id, id);
  }
});

test("the catalog exposes exactly the four rungs the client shows", () => {
  const ids = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id));
  for (const modelId of TIER_IDS) {
    assert.equal(ids.has(modelId), true, `${modelId} missing from ANTIGRAVITY_PUBLIC_MODELS`);
  }
  const xhigh = ANTIGRAVITY_PUBLIC_MODELS.find((m) => m.id === "gemini-4-hydrogen-xhigh");
  assert.equal(xhigh?.name, "Gemini 4 Hydrogen (Extra High)");
  assert.equal(xhigh?.maxOutputTokens, 262144);
  assert.equal(xhigh?.supportsReasoning, true);
});

test("unreachable Gemini 4 models stay out of the catalog and alias map", () => {
  // Carbon / Argon / Neon exist upstream only as `*-disabled` entries.
  for (const id of ["gemini-4-carbon", "gemini-4-argon", "gemini-4-neon"]) {
    assert.equal(Object.hasOwn(ANTIGRAVITY_MODEL_ALIASES, id), false, `${id} must not be aliased`);
    const publicIds = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((model) => model.id));
    assert.equal(publicIds.has(id), false, `${id} must not be advertised`);
  }
});

test("tier detection is exact: only the four rung ids qualify", () => {
  for (const modelId of TIER_IDS) {
    assert.equal(isAntigravityGemini4TierModel(modelId), true, modelId);
    assert.equal(isAntigravityGemini4TierModel(`antigravity/${modelId}`), true, modelId);
  }
  // Not tier ids: the distinct sonar model, the tiered aliases, other families.
  assert.equal(isAntigravityGemini4TierModel("gemini-4-hydrogen-sonar"), false);
  assert.equal(isAntigravityGemini4TierModel("gemini-4-hydrogen-tiered-xhigh"), false);
  assert.equal(isAntigravityGemini4TierModel("gemini-4-hydrogen"), false);
  assert.equal(isAntigravityGemini4TierModel("gemini-3.8-flash-high"), false);
  assert.equal(isAntigravityGemini4TierModel(""), false);
  assert.equal(isAntigravityGemini4TierModel(null), false);
});

test("tier ids map onto their own surface and rung", () => {
  for (const modelId of TIER_IDS) {
    const bare = modelId.replace("gemini-4-hydrogen-", "");
    assert.equal(antigravityGemini4TierFromModelId(modelId), bare, modelId);
    assert.equal(resolveAntigravityClientProfileForModel(modelId), "cli", modelId);
  }
  // Non-tier ids keep the connection's configured profile.
  assert.equal(antigravityGemini4TierFromModelId("gemini-4-hydrogen-sonar"), null);
  assert.equal(resolveAntigravityClientProfileForModel("gemini-4-hydrogen-sonar"), null);
  assert.equal(resolveAntigravityClientProfileForModel("gemini-3.8-flash-high"), null);
  assert.equal(resolveAntigravityClientProfileForModel(null), null);
});

test("client tier names resolve onto the real tier ids", () => {
  assert.equal(antigravityGemini4TierModelForTier("low"), "gemini-4-hydrogen-low");
  assert.equal(antigravityGemini4TierModelForTier("medium"), "gemini-4-hydrogen-medium");
  assert.equal(antigravityGemini4TierModelForTier("high"), "gemini-4-hydrogen-high");
  // All the top-rung names the ecosystem uses.
  assert.equal(antigravityGemini4TierModelForTier("xhigh"), "gemini-4-hydrogen-xhigh");
  assert.equal(antigravityGemini4TierModelForTier("extra"), "gemini-4-hydrogen-xhigh");
  assert.equal(antigravityGemini4TierModelForTier("extra-high"), "gemini-4-hydrogen-xhigh");
  assert.equal(antigravityGemini4TierModelForTier("max"), "gemini-4-hydrogen-xhigh");
  assert.equal(antigravityGemini4TierModelForTier("nonsense"), null);
  assert.equal(antigravityGemini4TierModelForTier(undefined), null);
});

test("budget tiers, including the rejected range, land on real tier ids", () => {
  assert.equal(antigravityGemini4TierForBudget(1024), "low");
  assert.equal(antigravityGemini4TierForBudget(4096), "low");
  assert.equal(antigravityGemini4TierForBudget(8192), "medium");
  assert.equal(antigravityGemini4TierForBudget(24576), "high");
  // A budget above the high rung means "top tier", which this family serves as its
  // own id — never as a budget, which the upstream reads as an out-of-range level.
  assert.equal(antigravityGemini4TierForBudget(32768), "xhigh");
  assert.equal(antigravityGemini4TierForBudget(131072), "xhigh");
  assert.equal(antigravityGemini4TierForBudget(null), "high");
});

test("preserveAntigravityGemini4TierRequest strips the derived level and budget", () => {
  const request: Record<string, unknown> = {
    generationConfig: {
      maxOutputTokens: 262144,
      thinkingConfig: { thinkingBudget: 32768, thinkingLevel: "high", includeThoughts: true },
    },
  };

  preserveAntigravityGemini4TierRequest(request, "gemini-4-hydrogen-xhigh");

  const thinkingConfig = (request.generationConfig as Record<string, unknown>)
    .thinkingConfig as Record<string, unknown>;
  assert.equal("thinkingLevel" in thinkingConfig, false);
  assert.equal("thinkingBudget" in thinkingConfig, false);
  // includeThoughts survives: it routes thought parts to reasoning_content and keeps
  // the thought signature replayable across multi-turn tool loops.
  assert.equal(thinkingConfig.includeThoughts, true);
});

test("preserveAntigravityGemini4TierRequest removes an emptied thinkingConfig", () => {
  const request: Record<string, unknown> = {
    generationConfig: { thinkingConfig: { thinkingBudget: 24576 } },
  };

  preserveAntigravityGemini4TierRequest(request, "gemini-4-hydrogen-low");

  const generationConfig = request.generationConfig as Record<string, unknown>;
  assert.equal("thinkingConfig" in generationConfig, false);
});

test("preserveAntigravityGemini4TierRequest leaves other families untouched", () => {
  const original = {
    generationConfig: { thinkingConfig: { thinkingBudget: 24576, includeThoughts: true } },
  };
  const request = JSON.parse(JSON.stringify(original));

  preserveAntigravityGemini4TierRequest(request, "gemini-3.8-flash-high");
  assert.deepEqual(request, original);

  preserveAntigravityGemini4TierRequest(request, "gemini-4-hydrogen-sonar");
  assert.deepEqual(request, original);
});

test("transformRequest keeps the requested tier id end to end", async () => {
  const executor = new AntigravityExecutor();
  const result = await executor.transformRequest(
    "antigravity/gemini-4-hydrogen-xhigh",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 24576, includeThoughts: true } },
      },
    },
    true,
    { projectId: "project-1" }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  // The tier id must survive intact — collapsing onto -sonar would lose the rung.
  assert.equal(result.model, "gemini-4-hydrogen-xhigh");
  const thinkingConfig = (
    result.request as { generationConfig?: { thinkingConfig?: Record<string, unknown> } }
  ).generationConfig?.thinkingConfig;
  // The derived level/budget are dropped; includeThoughts survives.
  assert.equal("thinkingLevel" in (thinkingConfig ?? {}), false);
  assert.equal("thinkingBudget" in (thinkingConfig ?? {}), false);
  assert.equal(thinkingConfig?.includeThoughts, true);
});

test("Gemini 4 tier ids carry specs and pricing rows", () => {
  for (const modelId of [...TIER_IDS, "gemini-4-hydrogen-sonar"]) {
    const spec = getModelSpec(modelId);
    assert.ok(spec, `${modelId} must resolve to a MODEL_SPECS entry`);
    assert.equal(spec?.contextWindow, 1048576, modelId);
  }
  assert.equal(getModelSpec("gemini-4-hydrogen-xhigh")?.maxOutputTokens, 262144);
  assert.equal(getModelSpec("gemini-4-hydrogen-sonar")?.maxOutputTokens, 65536);

  const pricing = getDefaultPricing().ag;
  for (const modelId of [...TIER_IDS, "gemini-4-hydrogen-sonar"]) {
    const row = pricing[modelId];
    assert.ok(row, `ag/${modelId} must have a pricing row`);
    // LiteLLM gemini/gemini-4-hydrogen: $1.50 in / $7.50 out / $0.075 cached per MTok.
    assert.equal(row.input, 1.5, modelId);
    assert.equal(row.output, 7.5, modelId);
    assert.equal(row.cached, 0.075, modelId);
  }
});
