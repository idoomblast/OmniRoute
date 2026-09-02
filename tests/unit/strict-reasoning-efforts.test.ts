import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeReasoningEffortForProvider } =
  await import("../../open-sse/executors/base/reasoningEffort.ts");
const { parseEffortLevel } = await import("../../open-sse/executors/opencode.ts");
const { OpencodeExecutor } = await import("../../open-sse/executors/opencode.ts");
const { getThinkingCapabilityFields } =
  await import("../../src/app/api/v1/models/catalogHelpers.ts");

const STRICT_MODELS = [
  ["opencode", "ox-alpha"],
  ["opencode-go", "ox-alpha-free"],
  ["opencode", "x-preview-f-free"],
  ["opencode-zen", "x-preview-f-free"],
  ["command-code", "x-preview-f-free"],
  // GLM-5.3-Flash strict tiers resolve via the GLOBAL MODEL_SPECS fallback —
  // none of these providers has a registry entry for the model (bai, zai and
  // glm catalogs do not list glm-5.3-flash), proving the fleet-wide path works.
  ["bai", "glm-5.3-flash"],
  ["zai", "glm-5.3-flash"],
  ["glm", "glm-5.3-flash"],
  // DeepSeek V4 family (low|high|max) resolves via the same GLOBAL MODEL_SPECS
  // fallback — bai has no curated registry entry, proving fleet-wide coverage.
  // The -vision-exp / -free variants are matched by model-id prefix.
  ["bai", "deepseek-v4-flash"],
  ["bai", "deepseek-v4-flash-vision-exp"],
  ["bai", "deepseek-v4-pro"],
  ["deepseek", "deepseek-v4-flash"],
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
    assert.equal(result.reasoning_effort, "high");
  });
}

test("OpenCode ox-alpha effort aliases resolve to the canonical model", () => {
  for (const effort of ["low", "high", "max"]) {
    assert.deepEqual(parseEffortLevel(`ox-alpha-${effort}`), {
      baseModel: "ox-alpha",
      effort,
    });
  }
});

test("OpenCode ox-alpha does not expose unsupported effort aliases", () => {
  for (const effort of ["none", "medium", "xhigh"]) {
    assert.equal(parseEffortLevel(`ox-alpha-${effort}`), null);
  }
});

test("strict models expose only their upstream effort tiers in catalog capabilities", () => {
  assert.deepEqual(getThinkingCapabilityFields("opencode", "ox-alpha", true).effort_tiers, [
    "low",
    "high",
    "max",
  ]);
  assert.deepEqual(getThinkingCapabilityFields("opencode-go", "ox-alpha-free", true).effort_tiers, [
    "low",
    "high",
    "max",
  ]);
  assert.deepEqual(
    getThinkingCapabilityFields("command-code", "x-preview-f-free", true).effort_tiers,
    ["low", "high", "max"]
  );
  assert.deepEqual(
    getThinkingCapabilityFields("opencode-zen", "x-preview-f-free", true).effort_tiers,
    ["low", "high", "max"]
  );
});

test("OpenCode Zen sends the mandatory default effort on the final wire payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ id: "probe", choices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const executor = new OpencodeExecutor("opencode-zen");
    await executor.execute({
      model: "x-preview-f-free",
      body: {
        model: "x-preview-f-free",
        messages: [{ role: "user", content: "hello" }],
      },
      stream: false,
      credentials: { apiKey: "probe-key" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(capturedBody);
  assert.equal(capturedBody.reasoning_effort, "high");
});
