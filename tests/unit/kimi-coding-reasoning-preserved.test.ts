/**
 * Kimi Coding is an OpenAI-shaped provider whose assistant turns carry
 * `reasoning_content`. The Claude translator replays it as a leading thinking
 * block. Continuity restoration now runs on the assembled assistant turn, so
 * the first fragment after a user/tool message must still keep that reasoning.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.ts";

const MODEL = "kimi-k2.7-code";
const TOOL = (id: string) => ({
  id,
  type: "function",
  function: { name: "read", arguments: "{}" },
});

function translate(messages: Array<Record<string, unknown>>) {
  return openaiToClaudeRequest(
    MODEL,
    {
      reasoning_effort: "high",
      messages,
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    } as unknown as Parameters<typeof openaiToClaudeRequest>[1],
    true,
    { _provider: "kimi-coding" }
  ) as unknown as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
}

function reasoningOf(body: {
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
}) {
  return body.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking);
}

test("Kimi reasoning after a user message survives translation", () => {
  const body = translate([
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "on it",
      reasoning_content: "REASONING_SENTINEL",
      tool_calls: [TOOL("call_a")],
    },
    { role: "tool", tool_call_id: "call_a", content: "ok" },
  ]);
  assert.deepEqual(reasoningOf(body), ["REASONING_SENTINEL"]);
});

test("Kimi reasoning after tool results survives on every assistant turn", () => {
  const body = translate([
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "FIRST_REASONING",
      tool_calls: [TOOL("call_a")],
    },
    { role: "tool", tool_call_id: "call_a", content: "A" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "SECOND_REASONING",
      tool_calls: [TOOL("call_b")],
    },
    { role: "tool", tool_call_id: "call_b", content: "B" },
  ]);
  assert.deepEqual(reasoningOf(body), ["FIRST_REASONING", "SECOND_REASONING"]);
});
