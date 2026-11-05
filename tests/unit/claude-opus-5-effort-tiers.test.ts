import assert from "node:assert/strict";
import { test } from "node:test";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";

const OPUS_5 = "claude-opus-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

test("claude registry advertises opus 5 reasoning tiers", () => {
  const model = getModelsByProviderId("claude").find((entry) => entry.id === OPUS_5);
  assert.ok(model, "claude-opus-5 must stay a seeded Claude Code model");
  assert.deepEqual(model.supportedThinkingEfforts, EFFORTS);
  assert.equal(model.supportsReasoning, true);
  assert.equal(model.supportsXHighEffort, true);
});
