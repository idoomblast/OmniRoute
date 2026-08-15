import test from "node:test";
import assert from "node:assert/strict";

import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import { normalizeResponsesReasoningEffort } from "../../open-sse/translator/request/openai-responses/helpers.ts";
import { sanitizeReasoningEffortForProvider } from "../../open-sse/executors/base/reasoningEffort.ts";
import {
  CANONICAL_EFFORT_VALUES,
  extendCodexGpt56EffortValues,
} from "../../src/shared/reasoning/effortStandardization.ts";

// GPT-5.6 `max` support was cosmetic: CodexExecutor.transformRequest() emitted `max`,
// but BaseExecutor.execute() runs sanitizeReasoningEffortForProvider() AFTER the
// transform (base.ts), and supportsMaxEffortForProvider() did not whitelist openai/codex
// — so `max` was demoted to `xhigh` right before fetch. GPT-5.5 topping at `xhigh` is
// correct behavior and must stay. These tests probe the FINAL fetch body (the wire),
// not the transformer, because the 28/28 transform-level suite stayed green while the
// bug was live.

type CapturedBody = Record<string, unknown>;

async function captureCodexBody(
  model: string,
  body: Record<string, unknown>
): Promise<CapturedBody> {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;
  let captured: CapturedBody | null = null;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ id: "resp_probe", object: "response", output: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await executor.execute({
      model,
      body,
      stream: true,
      credentials: { accessToken: "codex-probe-token" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, `CodexExecutor did not fetch for ${model}`);
  return captured;
}

async function captureOpenAIBody(model: string, reasoningEffort: string): Promise<CapturedBody> {
  const executor = new DefaultExecutor("openai");
  const translated = openaiToOpenAIResponsesRequest(
    model,
    {
      model,
      messages: [{ role: "user", content: "probe" }],
      reasoning_effort: reasoningEffort,
    },
    false,
    null
  ) as CapturedBody;
  const originalFetch = globalThis.fetch;
  let captured: CapturedBody | null = null;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ id: "resp_probe", object: "response", output: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await executor.execute({
      model,
      body: translated,
      stream: false,
      credentials: { apiKey: "probe-key" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, `DefaultExecutor(openai) did not fetch for ${model}`);
  return captured;
}

function reasoningEffortOf(body: CapturedBody): unknown {
  const reasoning =
    body.reasoning && typeof body.reasoning === "object"
      ? (body.reasoning as Record<string, unknown>)
      : null;
  return reasoning?.effort ?? body.reasoning_effort;
}

// ── Codex wire ──────────────────────────────────────────────────────────

test("CodexExecutor: gpt-5.6-sol reasoning.effort=max reaches the wire as max", async () => {
  const body = await captureCodexBody("gpt-5.6-sol", {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "probe" }],
    reasoning: { effort: "max" },
  });
  assert.equal(reasoningEffortOf(body), "max");
});

test("CodexExecutor: gpt-5.6-sol-max alias reaches the wire as max", async () => {
  const body = await captureCodexBody("gpt-5.6-sol-max", {
    model: "gpt-5.6-sol-max",
    input: [{ role: "user", content: "probe" }],
  });
  assert.equal(reasoningEffortOf(body), "max");
});

test("CodexExecutor: bare gpt-5.6 reasoning.effort=max reaches the wire as max (unsuffixed clamp)", async () => {
  const body = await captureCodexBody("gpt-5.6", {
    model: "gpt-5.6",
    input: [{ role: "user", content: "probe" }],
    reasoning: { effort: "max" },
  });
  assert.equal(reasoningEffortOf(body), "max");
});

test("CodexExecutor: gpt-5.5 reasoning.effort=max is still demoted to xhigh", async () => {
  const body = await captureCodexBody("gpt-5.5", {
    model: "gpt-5.5",
    input: [{ role: "user", content: "probe" }],
    reasoning: { effort: "max" },
  });
  assert.equal(reasoningEffortOf(body), "xhigh");
});

// ── OpenAI API wire ─────────────────────────────────────────────────────

test("DefaultExecutor(openai): bare gpt-5.6 reasoning_effort=max reaches the wire as max", async () => {
  const body = await captureOpenAIBody("gpt-5.6", "max");
  assert.equal(reasoningEffortOf(body), "max");
});

test("DefaultExecutor(openai): gpt-5.6-sol reasoning_effort=max reaches the wire as max", async () => {
  const body = await captureOpenAIBody("gpt-5.6-sol", "max");
  assert.equal(reasoningEffortOf(body), "max");
});

test("DefaultExecutor(openai): gpt-5.5 reasoning_effort=max is still demoted to xhigh", async () => {
  const body = await captureOpenAIBody("gpt-5.5", "max");
  assert.equal(reasoningEffortOf(body), "xhigh");
});

// ── Sanitizer (unit) ────────────────────────────────────────────────────

test("sanitizeReasoningEffortForProvider: openai gpt-5.6 max passes through", () => {
  const out = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "max" },
    "openai",
    "gpt-5.6"
  ) as Record<string, unknown>;
  assert.equal(out.reasoning_effort, "max");
});

test("sanitizeReasoningEffortForProvider: codex gpt-5.6-luna reasoning.effort=max passes through", () => {
  const out = sanitizeReasoningEffortForProvider(
    { reasoning: { effort: "max" } },
    "codex",
    "gpt-5.6-luna"
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).effort, "max");
});

test("sanitizeReasoningEffortForProvider: openai gpt-5.5 max → xhigh", () => {
  const out = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "max" },
    "openai",
    "gpt-5.5"
  ) as Record<string, unknown>;
  assert.equal(out.reasoning_effort, "xhigh");
});

test("sanitizeReasoningEffortForProvider: non-GPT-5.6 models stay on xhigh", () => {
  const codex = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "max" },
    "codex",
    "gpt-5.5"
  ) as Record<string, unknown>;
  assert.equal(codex.reasoning_effort, "xhigh");

  const openai = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "max" },
    "openai",
    "gpt-4.1"
  ) as Record<string, unknown>;
  assert.equal(openai.reasoning_effort, "xhigh");
});

// ── Chat→Responses translator helper ────────────────────────────────────

test("normalizeResponsesReasoningEffort: max preserved for GPT-5.6 (bare + prefixed)", () => {
  assert.equal(normalizeResponsesReasoningEffort("max", "gpt-5.6"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "openai/gpt-5.6-sol"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "gpt-5.6-terra-max"), "max");
});

test("normalizeResponsesReasoningEffort: max → xhigh for gpt-5.5", () => {
  assert.equal(normalizeResponsesReasoningEffort("max", "gpt-5.5"), "xhigh");
});

// ── Catalog capability exposure ─────────────────────────────────────────

test("extendCodexGpt56EffortValues: openai GPT-5.6 advertises max but NOT ultra", () => {
  const bare = extendCodexGpt56EffortValues("openai", "gpt-5.6", CANONICAL_EFFORT_VALUES);
  assert.ok(bare.includes("max"), "openai gpt-5.6 should advertise max");
  assert.equal(bare.includes("ultra"), false, "public OpenAI API has no ultra tier");

  const sol = extendCodexGpt56EffortValues("openai", "gpt-5.6-sol", CANONICAL_EFFORT_VALUES);
  assert.ok(sol.includes("max"));
  assert.equal(sol.includes("ultra"), false);
});

test("extendCodexGpt56EffortValues: codex sol/terra get max + ultra; luna/bare stop at max", () => {
  const sol = extendCodexGpt56EffortValues("codex", "gpt-5.6-sol", CANONICAL_EFFORT_VALUES);
  assert.ok(sol.includes("max") && sol.includes("ultra"));

  const luna = extendCodexGpt56EffortValues("codex", "gpt-5.6-luna", CANONICAL_EFFORT_VALUES);
  assert.ok(luna.includes("max"));
  assert.equal(luna.includes("ultra"), false);

  const bare = extendCodexGpt56EffortValues("codex", "gpt-5.6", CANONICAL_EFFORT_VALUES);
  assert.ok(bare.includes("max"));
  assert.equal(bare.includes("ultra"), false);
});

test("extendCodexGpt56EffortValues: gpt-5.5 / other providers unchanged", () => {
  assert.deepEqual(extendCodexGpt56EffortValues("openai", "gpt-5.5", CANONICAL_EFFORT_VALUES), [
    ...CANONICAL_EFFORT_VALUES,
  ]);
  assert.deepEqual(extendCodexGpt56EffortValues("codex", "gpt-5.5", CANONICAL_EFFORT_VALUES), [
    ...CANONICAL_EFFORT_VALUES,
  ]);
  assert.deepEqual(extendCodexGpt56EffortValues("groq", "gpt-5.6-sol", CANONICAL_EFFORT_VALUES), [
    ...CANONICAL_EFFORT_VALUES,
  ]);
});
