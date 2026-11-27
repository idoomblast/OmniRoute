import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLogTpsTitle,
  computeLogTps,
  resolveGenerationMs,
  resolveTpsOutputTokens,
} from "../../src/shared/utils/logTps.ts";

// #13130 — Logs dashboard TPS must exclude TTFT from the denominator and
// defensively count reasoning tokens when a provider reports them outside
// completion_tokens. These tests pin the pure helpers used by
// RequestLoggerV2.tsx.

test("resolveGenerationMs subtracts TTFT only when it is a sane in-window value", () => {
  assert.equal(resolveGenerationMs(100_000, 20_000), 80_000);
  // No TTFT recorded (old rows / non-streaming): fall back to full duration.
  assert.equal(resolveGenerationMs(100_000, null), 100_000);
  assert.equal(resolveGenerationMs(100_000, undefined), 100_000);
  assert.equal(resolveGenerationMs(100_000, 0), 100_000);
  // Degenerate TTFT values must not zero-out or negate the window.
  assert.equal(resolveGenerationMs(100_000, 100_000), 100_000);
  assert.equal(resolveGenerationMs(100_000, 150_000), 100_000);
  assert.equal(resolveGenerationMs(100_000, -5), 100_000);
  // Unusable duration kills the sample entirely.
  assert.equal(resolveGenerationMs(0, 100), null);
  assert.equal(resolveGenerationMs(-1, null), null);
  assert.equal(resolveGenerationMs(Number.NaN, 10), null);
});

test("resolveTpsOutputTokens counts reasoning without double counting", () => {
  // Provider folds reasoning into completion tokens: max picks tokens_out.
  assert.equal(resolveTpsOutputTokens(3000, 2500), 3000);
  // Provider excludes reasoning from completion tokens: reasoning is the better
  // available lower bound.
  assert.equal(resolveTpsOutputTokens(500, 2500), 2500);
  // No reasoning reported: plain output tokens.
  assert.equal(resolveTpsOutputTokens(1000, null), 1000);
  assert.equal(resolveTpsOutputTokens(undefined, undefined), 0);
});

test("computeLogTps measures generation throughput, not wall-clock TPS", () => {
  // No TTFT persisted: old behavior preserved (full duration denominator).
  const kimi = computeLogTps(3000, null, 208_676, null);
  assert.ok(Math.abs(kimi - 14.375) < 0.01, `got ${kimi}`);

  // Thinking model with recorded TTFT: 60s of the 90s request was queue +
  // prefill + first-token wait; 1000 tokens generated in 30s.
  const thinking = computeLogTps(1000, 800, 90_000, 60_000);
  assert.ok(Math.abs(thinking - 33.333) < 0.01, `got ${thinking}`);

  // Reasoning-excluding provider: 500 visible tokens, 2500 reasoning tokens,
  // 80s generation window.
  const excluded = computeLogTps(500, 2500, 100_000, 20_000);
  assert.ok(Math.abs(excluded - 31.25) < 0.01, `got ${excluded}`);

  // Degenerate inputs still resolve to 0 (the historical display contract).
  assert.equal(computeLogTps(0, 0, 10_000, 100), 0);
  assert.equal(computeLogTps(100, 0, 0, 0), 0);
});

test("buildLogTpsTitle explains TTFT, generation window and reasoning", () => {
  const fmt = (ms: number) => `${ms}ms`;
  assert.equal(
    buildLogTpsTitle({ duration: 10_000, ttft: 4_000, tokens: { reasoning: 120 } }, 50, fmt),
    "50.00 tokens/sec · TTFT 4000ms · generation 6.0s · reasoning 120 tok"
  );
  // No TTFT recorded (old row / non-streaming): only the rate, no fake breakdown.
  assert.equal(buildLogTpsTitle({ duration: 10_000 }, 12.5, fmt), "12.50 tokens/sec");
});
