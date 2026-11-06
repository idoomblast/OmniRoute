import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getModelsByProviderId,
  supportsXHighEffort,
} from "../../open-sse/config/providerModels.ts";

// Tier lists follow Anthropic's published per-model effort table:
// xhigh exists on Opus 4.7+ / Opus 5 / Fable 5 (added with Opus 4.7); max exists on
// Opus 5/4.8/4.7/4.6 and Fable 5; Opus 4.5 tops out at high.
const FIVE = ["low", "medium", "high", "xhigh", "max"];
const FOUR = ["low", "medium", "high", "max"]; // no xhigh — Opus 4.6
const THREE = ["low", "medium", "high"]; // Opus 4.5

function entry(modelId: string) {
  const model = getModelsByProviderId("claude").find((e) => e.id === modelId);
  assert.ok(model, `claude/${modelId} must stay seeded`);
  return model;
}

const EXPECTED: Array<[string, string[]]> = [
  ["claude-fable-5", FIVE],
  ["claude-opus-4-8", FIVE],
  ["claude-opus-4-7", FIVE],
  ["claude-opus-4-6", FOUR],
  ["claude-opus-4-5-20251101", THREE],
];

test("claude registry declares per-model thinking efforts", () => {
  for (const [modelId, tiers] of EXPECTED) {
    const model = entry(modelId);
    assert.deepEqual(model.supportedThinkingEfforts, tiers, `claude/${modelId} tiers`);
    assert.equal(model.supportsReasoning, true, `claude/${modelId} reasoning`);
    assert.equal(
      model.supportsXHighEffort,
      tiers.includes("xhigh") ? true : model.supportsXHighEffort,
      `claude/${modelId} xhigh flag consistency`
    );
  }
});

test("xhigh-capable entries declare supportsXHighEffort; 4.6/4.5 must not", () => {
  for (const [modelId, tiers] of EXPECTED) {
    const model = entry(modelId);
    if (tiers.includes("xhigh")) {
      assert.equal(model.supportsXHighEffort, true, `claude/${modelId}`);
    } else {
      assert.notEqual(
        model.supportsXHighEffort,
        true,
        `claude/${modelId} must not advertise xhigh`
      );
    }
  }
});

test("supportsXHighEffort() end-to-end: 4.6/4.5 resolve false", () => {
  for (const modelId of ["claude-opus-4-6", "claude-opus-4-5-20251101"]) {
    assert.equal(supportsXHighEffort("claude", modelId), false, `claude/${modelId}`);
  }
});

test("supportsXHighEffort() end-to-end: xhigh-capable models resolve true", () => {
  for (const modelId of ["claude-opus-4-8", "claude-opus-4-7", "claude-fable-5"]) {
    assert.equal(supportsXHighEffort("claude", modelId), true, `claude/${modelId}`);
  }
});
