import test from "node:test";
import assert from "node:assert/strict";

import { CodexExecutor } from "../../open-sse/executors/codex.ts";

test("CodexExecutor.transformRequest strips reasoning.enabled on the native passthrough path", () => {
  const executor = new CodexExecutor();
  const result = executor.transformRequest(
    "gpt-5.6-terra",
    {
      model: "gpt-5.6-terra",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      reasoning: { enabled: true, effort: "high" },
    },
    true,
    { requestEndpointPath: "/responses" }
  );

  const reasoning = result.reasoning as Record<string, unknown>;

  assert.equal(reasoning.enabled, undefined, "enabled must be stripped");
  assert.equal(reasoning.effort, "high", "effort must be preserved");
});

test("CodexExecutor.transformRequest strips reasoning.enabled on the translated path", () => {
  const executor = new CodexExecutor();
  const result = executor.transformRequest(
    "gpt-5.6-terra",
    {
      model: "gpt-5.6-terra",
      input: [],
      reasoning: { enabled: true, effort: "medium" },
    },
    true,
    { requestEndpointPath: "/responses" }
  );

  const reasoning = result.reasoning as Record<string, unknown>;

  assert.equal(reasoning.enabled, undefined, "enabled must be stripped");
  assert.equal(reasoning.effort, "medium", "effort must be preserved");
});

test("CodexExecutor.transformRequest preserves effort none while stripping enabled", () => {
  const executor = new CodexExecutor();
  const result = executor.transformRequest(
    "gpt-5.6-terra",
    {
      model: "gpt-5.6-terra",
      input: [],
      reasoning_effort: "none",
      reasoning: { enabled: true },
    },
    true,
    { requestEndpointPath: "/responses" }
  );

  const reasoning = result.reasoning as Record<string, unknown>;

  assert.equal(reasoning.enabled, undefined, "enabled must be stripped");
  assert.equal(reasoning.effort, "none", "explicit effort none must be preserved");
});
