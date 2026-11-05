import test from "node:test";
import assert from "node:assert/strict";

import {
  getModelsByProviderId,
  supportsClaudeMaxEffort,
  supportsXHighEffort,
} from "../../open-sse/config/providerModels.ts";
import {
  getClaudeCodeDefaultModels,
  getUnsupportedParams,
} from "../../open-sse/config/providerRegistry.ts";
import { modelHasNativeContext1m } from "../../open-sse/config/claudeCodeCompatibleIdentity.ts";
import { modelSupportsContext1mBeta } from "../../open-sse/services/claudeCodeCompatible.ts";
import { normalizeClaudeAdaptiveThinking } from "../../open-sse/services/claudeAdaptiveThinking.ts";
import { getNextFamilyFallback } from "../../open-sse/services/modelFamilyFallback.ts";
import { getModelPricing } from "../../open-sse/services/providerCostData.ts";
import { shouldRequestClaudeFastMode } from "../../src/lib/providers/claudeFastMode.ts";
import { getStaticModelsForProvider } from "../../src/lib/providers/staticModels.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";
import {
  getModelSpec,
  normalizeForcedToolChoiceForModel,
  normalizeThinkingForModel,
} from "../../src/shared/constants/modelSpecs.ts";

const MODEL_ID = "claude-opus-5-5";
const BEDROCK_MODEL_ID = "anthropic.claude-opus-5-5";
const DOT_MODEL_ID = "claude-opus-5.5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

test("Claude Opus 5.5 is registered on the Claude OAuth surface", () => {
  const model = getModelsByProviderId("claude").find((entry) => entry.id === MODEL_ID);
  assert.ok(model, `claude must expose ${MODEL_ID}`);
  assert.equal(model.contextLength, 1_000_000);
  assert.equal(model.maxOutputTokens, 128_000);
  assert.deepEqual(model.supportedThinkingEfforts, EFFORTS);

  assert.ok(
    getStaticModelsForProvider("claude")?.some((entry) => entry.id === MODEL_ID),
    "Claude OAuth static discovery must expose Opus 5.5"
  );
  assert.equal(
    getNextFamilyFallback(`claude/${MODEL_ID}`, new Set([`claude/${MODEL_ID}`])),
    "claude/claude-opus-5"
  );
});

test("Claude Code CLI keeps Opus 5 as the cc/ Opus default until live catalogs refresh", () => {
  const { opus } = getClaudeCodeDefaultModels();
  assert.equal(opus, "claude-opus-5");
});

test("Claude Opus 5.5 has native 1M context and always-on adaptive thinking", () => {
  assert.equal(modelHasNativeContext1m(MODEL_ID), true);
  assert.equal(modelHasNativeContext1m(BEDROCK_MODEL_ID), true);
  assert.equal(modelHasNativeContext1m(DOT_MODEL_ID), true);
  assert.equal(modelSupportsContext1mBeta(MODEL_ID), false);

  const spec = getModelSpec(MODEL_ID);
  assert.notEqual(spec, getModelSpec("claude-opus-5"), "must not inherit the Opus 5 spec");
  assert.equal(spec?.contextWindow, 1_000_000);
  assert.equal(spec?.maxOutputTokens, 128_000);
  assert.equal(spec?.supportsThinking, true);
  assert.equal(spec?.supportsTools, true);
  assert.equal(spec?.supportsVision, true);
  assert.equal(spec?.adaptiveThinkingOnly, true);
  assert.equal(spec?.rejectsThinkingDisabled, true);
  assert.equal(spec?.rejectsForcedToolChoice, true);
  assert.equal(spec?.maxEffortWhenThinkingDisabled, undefined);

  assert.equal(getModelSpec(`global.${BEDROCK_MODEL_ID}`), spec);
  assert.equal(getModelSpec(DOT_MODEL_ID), spec, "dot notation must not prefix-match Opus 5");
  assert.equal(supportsXHighEffort("claude", MODEL_ID), true);
  assert.equal(supportsClaudeMaxEffort(MODEL_ID), true);
});

test("Claude Opus 5.5 defaults reasoning effort to medium without overriding the client", async () => {
  const { applyDefaultReasoningEffort } = await import(
    "../../open-sse/services/defaultReasoningEffort.ts"
  );
  assert.equal(getModelSpec(MODEL_ID)?.defaultReasoningEffort, "medium");

  const bare: Record<string, unknown> = { model: MODEL_ID, messages: [] };
  assert.equal(applyDefaultReasoningEffort(bare, MODEL_ID).reasoning_effort, "medium");

  const chosen: Record<string, unknown> = {
    model: MODEL_ID,
    messages: [],
    reasoning_effort: "max",
  };
  assert.equal(applyDefaultReasoningEffort(chosen, MODEL_ID).reasoning_effort, "max");
});

test("Claude Opus 5.5 strips unsupported sampling parameters", () => {
  const unsupported = getUnsupportedParams("claude", MODEL_ID);
  for (const param of ["temperature", "top_p", "top_k"]) {
    assert.ok(unsupported.includes(param), `claude/${MODEL_ID} must strip ${param}`);
  }
});

test("Claude Opus 5.5 drops disabled thinking and collapses manual budgets to adaptive", () => {
  const withoutDisabled = normalizeThinkingForModel(
    { model: MODEL_ID, thinking: { type: "disabled" }, output_config: { effort: "low" } },
    MODEL_ID
  );
  assert.equal("thinking" in withoutDisabled, false);
  assert.deepEqual(withoutDisabled.output_config, { effort: "low" });

  const dotWithoutDisabled = normalizeThinkingForModel(
    { model: DOT_MODEL_ID, thinking: { type: "disabled" } },
    DOT_MODEL_ID
  );
  assert.equal("thinking" in dotWithoutDisabled, false);

  const adaptive = normalizeClaudeAdaptiveThinking(
    { model: MODEL_ID, thinking: { type: "enabled", budget_tokens: 64_000 } },
    MODEL_ID
  );
  assert.deepEqual(adaptive.thinking, { type: "adaptive" });
});

test("Claude Opus 5.5 relaxes forced tool choices without removing tools", () => {
  for (const toolChoice of [
    "required",
    { type: "any" },
    { type: "tool", name: "read_file" },
    { type: "function", function: { name: "read_file" } },
  ]) {
    const tools = [{ name: "read_file", input_schema: { type: "object" } }];
    const result = normalizeForcedToolChoiceForModel(
      { model: MODEL_ID, tools, tool_choice: toolChoice },
      MODEL_ID
    );
    assert.equal("tool_choice" in result, false);
    assert.equal(result.tools, tools);
  }

  const opus5 = { model: "claude-opus-5", tool_choice: { type: "tool", name: "read_file" } };
  assert.equal(normalizeForcedToolChoiceForModel(opus5, "claude-opus-5"), opus5);
});

test("Claude Opus 5.5 requests Fast Mode when the toggle is on", () => {
  assert.equal(shouldRequestClaudeFastMode({ claudeFastMode: { enabled: true } }, MODEL_ID), true);
  assert.equal(
    shouldRequestClaudeFastMode({ claudeFastMode: { enabled: false } }, MODEL_ID),
    false
  );
  assert.equal(
    shouldRequestClaudeFastMode(
      { claudeFastMode: { enabled: true, supportedModels: [MODEL_ID] } },
      "claude-opus-5"
    ),
    false
  );
});

test("Claude Opus 5.5 pricing matches Anthropic's published rates", () => {
  const price = getDefaultPricing().cc[MODEL_ID];
  assert.equal(price.input, 4);
  assert.equal(price.output, 20);
  assert.equal(price.cached, 0.2);
  assert.equal(price.reasoning, 20);
  assert.equal(price.cache_creation, 5);
  assert.deepEqual(getModelPricing("cc", MODEL_ID), {
    inputCostPer1M: 4,
    outputCostPer1M: 20,
    isFree: false,
  });
});
