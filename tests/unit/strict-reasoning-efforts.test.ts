import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeReasoningEffortForProvider } =
  await import("../../open-sse/executors/base/reasoningEffort.ts");
const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { getThinkingCapabilityFields } =
  await import("../../src/app/api/v1/models/catalogHelpers.ts");

const STRICT_MODELS = [
  // GLM-5.3 family strict tiers resolve via the GLOBAL MODEL_SPECS fallback —
  // none of these providers has a registry entry for the models (bai, zai and
  // glm catalogs do not list them), proving the fleet-wide path works.
  // Bare "glm-5.3" and "-vision" variants (prefix-resolved) are covered too.
  ["bai", "glm-5.3"],
  ["zai", "glm-5.3"],
  ["glm", "glm-5.3"],
  ["bai", "glm-5.3-flash"],
  ["zai", "glm-5.3-flash"],
  ["glm", "glm-5.3-flash"],
  ["bai", "glm-5.3-flash-vision"],
  // GLM-5.2 family — same strict low|high|max enum, declared globally so every
  // provider resolving a glm-5.2* id inherits it (Decart/zai/qwen-cloud/bai/…).
  // The effort-suffixed registry aliases (glm-5.2-high/glm-5.2-max) each
  // exact-match their own spec key, so they are listed separately.
  ["zai", "glm-5.2"],
  ["zai", "glm-5.2-high"],
  ["zai", "glm-5.2-max"],
  ["qwen-cloud", "glm-5.2"],
  ["glm", "glm-5.2-max"],
  // DeepSeek V4 family (low|high|max) resolves via the same GLOBAL MODEL_SPECS
  // fallback — bai has no curated registry entry, proving fleet-wide coverage.
  // The -vision-exp / -free variants are matched by model-id prefix.
  // The NATIVE deepseek provider has its own sanitizer branch (reasoningEffort.ts)
  // — a {low, high, max} contract that maps medium → high (the #4219 floor,
  // relaxed to admit `low` at the V4 GA on 2026-08-13). It wins over the global
  // enum; medium clamping is covered by base-executor-sanitize-effort.test.ts.
  ["bai", "deepseek-v4-flash"],
  ["bai", "deepseek-v4-flash-vision-exp"],
  ["bai", "deepseek-v4-pro"],
  // DeepSeek V4.1-Flash — same strict low|high|max enum, declared globally in
  // MODEL_SPECS. The retired V4 ids route to it upstream, so both the
  // user-facing id and the official wire id (deepseek-flash) resolve here.
  ["bai", "deepseek-v4.1-flash"],
  ["deepseek", "deepseek-flash"],
  ["custom:idoomai", "deepseek-v4.1-flash"],
  ["openai-compatible-chat", "deepseek-v4.1-flash"],
] as const;

for (const [provider, model] of STRICT_MODELS) {
  test(`${provider}/${model} preserves only low, high, and max`, () => {
    for (const effort of ["low", "high", "max"]) {
      const result = sanitizeReasoningEffortForProvider(
        { model, reasoning_effort: effort },
        provider,
        model
      ) as Record<string, unknown>;
      assert.equal(result.reasoning_effort, effort);
    }
  });

  test(`${provider}/${model} maps aliases and strips unsupported explicit efforts`, () => {
    const expected = { medium: "high", xhigh: "max" } as const;

    for (const [effort, mappedEffort] of Object.entries(expected)) {
      const result = sanitizeReasoningEffortForProvider(
        { model, reasoning_effort: effort },
        provider,
        model
      ) as Record<string, unknown>;
      assert.equal(result.reasoning_effort, mappedEffort, `effort=${effort}`);
    }

    for (const effort of ["none", "invalid"]) {
      const result = sanitizeReasoningEffortForProvider(
        { model, reasoning_effort: effort },
        provider,
        model
      ) as Record<string, unknown>;
      assert.equal(result.reasoning_effort, "high", `effort=${effort}`);
    }
  });

  test(`${provider}/${model} injects the mandatory default when explicit effort is absent`, () => {
    const body = { model, messages: [{ role: "user", content: "hello" }] };
    const result = sanitizeReasoningEffortForProvider(body, provider, model) as Record<
      string,
      unknown
    >;
    // Claude-format providers (zai, …) speak `thinking`/`output_config`, not the
    // OpenAI-shaped `reasoning_effort` — the sanitizer must not inject the wrong
    // field shape into their Anthropic-format body. OpenAI-format providers keep
    // the mandatory `high` default (GLM strict tiers always think).
    if (getRegistryEntry(provider)?.format === "claude") {
      assert.equal(result.reasoning_effort, undefined, "no OpenAI-shaped injection");
      assert.equal(result, body, "body untouched");
    } else {
      assert.equal(result.reasoning_effort, "high");
    }
  });
}

test("strict models expose only their upstream effort tiers in catalog capabilities", () => {
  // GLM-5.3 family — declared globally in MODEL_SPECS, resolved via fallback.
  assert.deepEqual(getThinkingCapabilityFields("bai", "glm-5.3-flash", true).effort_tiers, [
    "low",
    "high",
    "max",
  ]);
});
