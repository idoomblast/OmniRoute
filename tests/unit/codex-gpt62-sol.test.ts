import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import { extendCodexGpt56EffortValues } from "../../src/shared/reasoning/effortStandardization.ts";
import { DEFAULT_CODEX_CLIENT_VERSION } from "../../open-sse/config/codexClient.ts";
import { getCodexFastCostMultiplier } from "../../src/lib/usage/costCalculator.ts";
import { CODEX_FAST_TIER_DEFAULT_SUPPORTED_MODELS } from "../../src/lib/providers/codexFastTier.ts";

// GPT-6.2 Sol: the ChatGPT Codex backend gates the model on the reported client
// version (0.159.2 -> model_not_found, 0.170.0 -> 200). The Codex catalog window
// is 872K usable (max_context_window; context_window is only the 500K pricing
// tier), which is deliberately different from the OpenAI platform API limit.
const MODEL = "gpt-6.2-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const IDS = [MODEL, ...EFFORTS.map((effort) => `${MODEL}-${effort}`)];

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});

function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

type ResponsesBody = Record<string, unknown> & {
  model?: string;
  reasoning?: { effort?: string; summary?: string };
};

function transform(model: string, body: Record<string, unknown> = {}): ResponsesBody {
  return new CodexExecutor().transformRequest(model, { model, input: [], ...body }, false, {
    requestEndpointPath: "/responses",
  }) as ResponsesBody;
}

test("Codex client version default clears the GPT-6.2 Sol gate", () => {
  assert.ok(versionAtLeast(DEFAULT_CODEX_CLIENT_VERSION, "0.170.0"));
});

test("GPT-6.2 Sol is registered on Codex with the 872K OAuth window", () => {
  const entries = getModelsByProviderId("codex").filter((entry) => entry.id.startsWith(MODEL));
  assert.deepEqual(entries.map((entry) => entry.id).sort(), [...IDS].sort());
  for (const entry of entries) {
    assert.equal(entry.contextLength, 872000);
    assert.equal(entry.maxInputTokens, 872000);
    assert.equal(entry.maxOutputTokens, 128000);
    assert.equal(entry.targetFormat, "openai-responses");
    assert.equal(entry.supportsVision, true);
    assert.equal(entry.supportsReasoning, true);
    assert.equal(entry.toolCalling, true);
  }
});

test("GPT-6.2 Sol effort aliases collapse to the base model on the wire", () => {
  for (const effort of EFFORTS) {
    const result = transform(`${MODEL}-${effort}`);
    assert.equal(result.model, MODEL);
    assert.equal(result.reasoning?.effort, effort === "ultra" ? "max" : effort);
  }
  for (const effort of ["max", "ultra"]) {
    const result = transform(`${MODEL}(${effort})`, { reasoning: { summary: "detailed" } });
    assert.equal(result.model, MODEL);
    assert.equal(result.reasoning?.effort, "max");
    assert.equal(result.reasoning?.summary, "detailed");
  }
});

test("GPT-6.2 Sol defaults to low effort without overriding explicit values", () => {
  assert.equal(transform(MODEL).reasoning?.effort, "low");
  assert.equal(transform(MODEL, { reasoning: { effort: "high" } }).reasoning?.effort, "high");
  assert.equal(transform("gpt-6-sol").reasoning?.effort, "medium");
  for (const provider of ["codex", "cx"]) {
    assert.deepEqual(extendCodexGpt56EffortValues(provider, MODEL, ["none", "high"]), EFFORTS);
  }
});

test("GPT-6.2 Sol pricing follows the Standard USD rates with a 2x Fast tier", () => {
  for (const id of IDS) {
    const price = getPricingForModel("cx", id);
    assert.ok(price, `cx/${id}`);
    assert.equal(price.input, 2);
    assert.equal(price.cached, 0.1);
    assert.equal(price.output, 10);
    assert.equal(price.reasoning, 10);
    assert.equal(getCodexFastCostMultiplier("codex", id, "priority"), 2);
  }
  assert.equal(getCodexFastCostMultiplier("codex", MODEL, "default"), 1);
  assert.ok(CODEX_FAST_TIER_DEFAULT_SUPPORTED_MODELS.includes(MODEL));
});
