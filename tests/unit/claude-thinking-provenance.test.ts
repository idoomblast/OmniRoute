/**
 * Rebuilt layouts must insert the store's restored block objects, not fresh
 * copies: request preparation uses a WeakSet to tell bound historical signed
 * thinking apart from foreign signed-empty blocks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clearClaudeThinkingStore } from "../../open-sse/services/claudeThinkingStore.ts";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

const MODEL = "claude-sonnet-4-5";
const CONN = "conn-provenance";
const TOOL_ID = "toolu_provenance";
const SIGNATURE = "SIG_EMPTY_THINKING";

function captureSignedEmptyTurn() {
  clearClaudeThinkingStore();
  const state: Record<string, unknown> = {
    provider: "claude",
    connectionId: CONN,
    toolCalls: new Map(),
    suppressThinkClose: true,
  };
  const events = [
    { type: "message_start", message: { id: "msg_prov", model: MODEL } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: SIGNATURE },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: TOOL_ID, name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  for (const event of events) claudeToOpenAIResponse(event, state);
}

test("signed-empty thinking restored through the layout rebuild survives as earlier history", () => {
  captureSignedEmptyTurn();
  const translated = translateRequest(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    MODEL,
    {
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: TOOL_ID, type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: TOOL_ID, content: "ok" },
        { role: "user", content: "continue" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    },
    false,
    { _connectionId: CONN },
    "claude"
  ) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };

  const signed = translated.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
  assert.deepEqual(
    signed.map((block) => block.signature),
    [SIGNATURE],
    "the restored signed-empty block keeps its provenance and is not dropped"
  );
  clearClaudeThinkingStore();
});
