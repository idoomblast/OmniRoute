import test from "node:test";
import assert from "node:assert/strict";

import { getModelPricing } from "../../open-sse/services/providerCostData.ts";
import { CLAUDE_HAIKU_5_PRICING } from "../../src/shared/constants/pricing/shared-tiers.ts";
import {
  getModelsByProviderId,
  supportsClaudeMaxEffort,
} from "../../open-sse/config/providerModels.ts";
import { getNextFamilyFallback } from "../../open-sse/services/modelFamilyFallback.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";
import { getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { normalizeClaudeHaikuConstraints } from "../../open-sse/services/claudeHaikuConstraints.ts";
import { getStaticModelsForProvider } from "../../src/lib/providers/staticModels.ts";
import { modelHasNativeContext1m } from "../../open-sse/config/claudeCodeCompatibleIdentity.ts";

const MODEL_ID = "claude-haiku-5-5";

test("Claude Haiku 5.5 is adaptive-only and preserves adaptive thinking", () => {
  const spec = getModelSpec(MODEL_ID);
  assert.equal(spec?.contextWindow, 1_000_000);
  assert.equal(spec?.maxOutputTokens, 128_000);
  assert.equal(spec?.adaptiveThinkingOnly, true);

  const input = {
    model: MODEL_ID,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  };
  const out = normalizeClaudeHaikuConstraints(input, input.model);
  assert.strictEqual(out, input);
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.deepEqual(out.output_config, { effort: "high" });
});

test("Claude Haiku 5.5 supports max effort", () => {
  assert.equal(supportsClaudeMaxEffort(MODEL_ID), true);
  assert.equal(supportsClaudeMaxEffort(`claude/${MODEL_ID}`), true);
});

test("Claude Haiku 5.5 has a native 1M context window (no context-1m beta)", () => {
  assert.equal(modelHasNativeContext1m(MODEL_ID), true);
  assert.equal(modelHasNativeContext1m(`claude/${MODEL_ID}`), true);
});

test("Claude Haiku 5.5 is priced at the documented length-tiered rate", () => {
  const pricing = getModelPricing("claude", MODEL_ID);
  assert.equal(pricing?.inputCostPer1M, 0.1);
  assert.equal(pricing?.outputCostPer1M, 0.5);
  assert.equal(CLAUDE_HAIKU_5_PRICING.input, 0.1);
  assert.equal(CLAUDE_HAIKU_5_PRICING.output, 0.5);
  assert.equal(CLAUDE_HAIKU_5_PRICING.cached, 0.01);
  assert.equal(CLAUDE_HAIKU_5_PRICING.cache_creation, 0.125);
  assert.deepEqual(CLAUDE_HAIKU_5_PRICING.long_context, {
    threshold: 100_000,
    input: 0.5,
    output: 2.5,
    cached: 0.05,
    reasoning: 2.5,
    cache_creation: 0.625,
  });

  const defaults = getDefaultPricing() as Record<
    string,
    Record<string, { input: number; output: number; long_context?: { threshold: number } }>
  >;
  assert.equal(defaults.anthropic[MODEL_ID].input, 0.1);
  assert.equal(defaults.anthropic[MODEL_ID].output, 0.5);
  assert.equal(defaults.anthropic[MODEL_ID].long_context?.threshold, 100_000);
  assert.equal(defaults.cc[MODEL_ID].input, 0.1);
  assert.equal(defaults.cc[MODEL_ID].output, 0.5);
  assert.equal(defaults.cc[MODEL_ID].long_context?.threshold, 100_000);
});

test("Claude Haiku 5.5 is not exposed on claude-web", () => {
  const ids = new Set(getModelsByProviderId("claude-web").map((entry) => entry.id));
  assert.equal(ids.has(MODEL_ID), false);
});

test("Claude Haiku 5.5 is registered on the Claude OAuth surface", () => {
  const entry = getModelsByProviderId("claude").find((model) => model.id === MODEL_ID);
  assert.ok(entry, `claude must expose ${MODEL_ID}`);
  assert.deepEqual(entry?.supportedThinkingEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(
    getNextFamilyFallback(`claude/${MODEL_ID}`, new Set()),
    "claude/claude-haiku-4-5-20251001"
  );
});

test("Claude Haiku 5.5 is exposed in static provider models", () => {
  const staticClaude = getStaticModelsForProvider("claude");
  assert.ok(staticClaude.some((entry) => entry.id === MODEL_ID));
});
