import test from "node:test";
import assert from "node:assert/strict";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";

// DefaultExecutor.ensureThinkingBudget — fork (2026-10-06): output budgets pass through
// untouched. The historical 4096 floor injected `max_tokens = 4096` when the client sent no
// cap and raised explicit budgets below 4096; that behavior truncated long reasoning
// (upstream #14888, still open) and overrode explicit client limits (fixed upstream by
// #14912). This fork adopts both directions: no injection when absent, no raise when
// explicit — parity with passthrough executors (opencode-go / bai / codex).
// Historically the floor was gated to clinepass only, then generalized to all providers
// (#6912); the tests below keep the cross-provider coverage to pin the new contract.

test("leaves an undersized explicit max_tokens untouched (no floor raise, #14912)", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/deepseek-v4-pro",
    reasoning_effort: "high",
    max_tokens: 512,
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/deepseek-v4-pro");
  assert.equal(body.max_tokens, 512);
});

test("leaves max_tokens absent when the client sent no cap (no 4096 injection, #14888)", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/deepseek-v4-flash",
    reasoning_effort: "medium",
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/deepseek-v4-flash");
  assert.ok(!("max_tokens" in body), "no max_tokens key may be invented");
  assert.ok(!("max_completion_tokens" in body), "no max_completion_tokens key may be invented");
});

test("leaves max_tokens absent for an extra_body thinking.type=enabled request", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/deepseek-v4-pro",
    extra_body: { thinking: { type: "enabled" } },
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/deepseek-v4-pro");
  assert.ok(!("max_tokens" in body), "no max_tokens key may be invented");
});

test("leaves an explicit max_completion_tokens untouched without adding max_tokens", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/deepseek-v4-pro",
    reasoning_effort: "high",
    max_completion_tokens: 1500,
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/deepseek-v4-pro");
  assert.equal(body.max_completion_tokens, 1500);
  assert.ok(!("max_tokens" in body), "must not re-introduce max_tokens alongside");
});

test("leaves a large explicit budget untouched", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/deepseek-v4-pro",
    reasoning_effort: "high",
    max_tokens: 32000,
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/deepseek-v4-pro");
  assert.equal(body.max_tokens, 32000);
});

test("no-op when reasoning is disabled", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/deepseek-v4-pro",
    max_tokens: 100,
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/deepseek-v4-pro");
  assert.equal(body.max_tokens, 100);
});

test("leaves an explicit small budget on a reasoning-capable catalog model untouched (glm-5.2)", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/glm-5.2",
    reasoning_effort: "high",
    max_tokens: 100,
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/glm-5.2");
  assert.equal(body.max_tokens, 100);
});

test("no-op for an unknown model without reasoning metadata", () => {
  const executor = new DefaultExecutor("clinepass");
  const body = {
    model: "cline-pass/unknown-model",
    reasoning_effort: "high",
    max_tokens: 100,
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "cline-pass/unknown-model");
  assert.equal(body.max_tokens, 100);
});

test("leaves explicit max_tokens untouched for a non-clinepass reasoning provider (#6912 gate removed)", () => {
  // Issue #6912: ensureThinkingBudget was gated to clinepass only; the floor used to
  // apply to all providers. Use nvidia (non-clinepass) which has
  // deepseek-ai/deepseek-v4-pro with supportsReasoning in the registry — the
  // passthrough must hold here too.
  const executor = new DefaultExecutor("nvidia");
  const body = {
    model: "deepseek-ai/deepseek-v4-pro",
    reasoning_effort: "high",
    max_tokens: 100,
  } as Record<string, unknown>;

  executor.ensureThinkingBudget(body, "deepseek-ai/deepseek-v4-pro");
  assert.equal(body.max_tokens, 100);
});
