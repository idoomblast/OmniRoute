/**
 * Long-context pricing tiers: a pricing row may carry
 * `long_context: { threshold, inclusive?, ...rates }` and the whole request
 * switches to those rates once the cache-inclusive prompt crosses the
 * threshold. Covers the Claude Haiku 5.5 tier the P0 catalog port introduced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeCostFromPricing } from "../../src/lib/usage/costCalculator.ts";

function assertCost(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, got ${actual}`);
}

const HAIKU_5_5 = {
  input: 0.1,
  output: 0.5,
  cached: 0.01,
  reasoning: 0.5,
  cache_creation: 0.125,
  long_context: {
    threshold: 100_000,
    input: 0.5,
    output: 2.5,
    cached: 0.05,
    reasoning: 2.5,
    cache_creation: 0.625,
  },
};

test("prompts at or below the threshold are billed at the flat rates", () => {
  const cost = computeCostFromPricing(HAIKU_5_5, { input: 100_000, output: 1_000 });
  // 100k * $0.10/M + 1k * $0.50/M
  assertCost(cost, 0.0105);
});

test("prompts above the threshold switch the whole request to the tier", () => {
  const cost = computeCostFromPricing(HAIKU_5_5, { input: 200_000, output: 1_000 });
  // 200k * $0.50/M + 1k * $2.50/M
  assertCost(cost, 0.1025);
});

test("cached prompt tokens count toward the threshold", () => {
  const cost = computeCostFromPricing(HAIKU_5_5, {
    input: 150_000,
    cacheRead: 100_000,
    output: 0,
  });
  // 50k non-cached * $0.50/M + 100k cached * $0.05/M
  assertCost(cost, 0.03);
});

test("a malformed tier is ignored instead of corrupting the estimate", () => {
  const broken = { ...HAIKU_5_5, long_context: { threshold: "many" } };
  const cost = computeCostFromPricing(broken, { input: 200_000, output: 0 });
  assertCost(cost, 0.02);
});

test("a tier with any invalid rate falls back to the flat rates", () => {
  for (const [key, value] of [
    ["input", -0.5],
    ["output", "2.5"],
    ["cached", null],
    ["reasoning", Number.NaN],
    ["cache_creation", Number.POSITIVE_INFINITY],
  ] as const) {
    const broken = {
      ...HAIKU_5_5,
      long_context: { ...HAIKU_5_5.long_context, [key]: value },
    };
    const cost = computeCostFromPricing(broken, { input: 200_000, output: 1_000 });
    // Flat rates: 200k * $0.10/M + 1k * $0.50/M
    assertCost(cost, 0.0205);
  }
});

test("a valid subset of tier rates overrides only those keys", () => {
  const partial = {
    ...HAIKU_5_5,
    long_context: { threshold: 100_000, input: 0.5 },
  };
  const cost = computeCostFromPricing(partial, { input: 200_000, output: 1_000 });
  // 200k * tier input $0.50/M + 1k * flat output $0.50/M
  assertCost(cost, 0.1005);
});

test("the inclusive flag switches at the threshold, not past it", () => {
  const inclusive = {
    ...HAIKU_5_5,
    long_context: { ...HAIKU_5_5.long_context, inclusive: true },
  };
  const cost = computeCostFromPricing(inclusive, { input: 100_000, output: 0 });
  assertCost(cost, 0.05);
});
