/**
 * #18607 follow-up — exact replay must keep text boundaries, not just text length.
 *
 * Streaming capture used to omit text blocks from the stored layout, and the
 * non-streaming client response concatenates text blocks before the next request.
 * Both paths now persist the original text lengths so replay can restore the
 * emitted block sequence: [thinking, text, redacted_thinking, text, tool_use].
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clearClaudeThinkingStore } from "../../open-sse/services/claudeThinkingStore.ts";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.ts";
import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

const MODEL = "claude-sonnet-4-5";
const CONN = "conn-18607-text";
const T1 = { type: "thinking", thinking: "THINK_A", signature: "SIG_A" };
const T2 = { type: "redacted_thinking", data: "OPAQUE_B" };
const FIRST = "first ";
const SECOND = "second";
const TOOL_ID = "toolu_text";

function claudeContent() {
  return [
    T1,
    { type: "text", text: FIRST },
    T2,
    { type: "text", text: SECOND },
    { type: "tool_use", id: TOOL_ID, name: "read", input: {} },
  ];
}

function captureStreamingTurn(marker = false) {
  clearClaudeThinkingStore();
  const state: Record<string, unknown> = {
    provider: "claude",
    connectionId: CONN,
    toolCalls: new Map(),
    suppressThinkClose: !marker,
  };
  const events = [
    { type: "message_start", message: { id: "msg_text", model: MODEL } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: T1.thinking },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: T1.signature },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: FIRST } },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "redacted_thinking", data: T2.data },
    },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: SECOND } },
    { type: "content_block_stop", index: 3 },
    {
      type: "content_block_start",
      index: 4,
      content_block: { type: "tool_use", id: TOOL_ID, name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 4,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 4 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  let clientContent = "";
  for (const event of events) {
    const chunks = claudeToOpenAIResponse(event, state) as Array<{
      choices?: Array<{ delta?: { content?: string } }>;
    }>;
    for (const chunk of chunks ?? []) clientContent += chunk.choices?.[0]?.delta?.content ?? "";
  }
  return clientContent;
}

function replay(content: string) {
  const translated = translateRequest(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    MODEL,
    {
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "Synthetic task" },
        {
          role: "assistant",
          content,
          tool_calls: [
            { id: TOOL_ID, type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: TOOL_ID, content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    },
    false,
    { _connectionId: CONN },
    "claude"
  ) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  const [turn] = translated.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.map(({ cache_control: _c, ...block }) => block));
  return turn;
}

const expected = () => [
  T1,
  { type: "text", text: FIRST },
  T2,
  { type: "text", text: SECOND },
  { type: "tool_use", id: TOOL_ID },
];

const stripToolUse = (block: Record<string, unknown>) =>
  block.type === "tool_use" ? { type: "tool_use", id: block.id } : block;

test("streaming capture replays thinking blocks around both text blocks", () => {
  const content = captureStreamingTurn(false);
  assert.equal(content, `${FIRST}${SECOND}`);
  const turn = replay(content);
  assert.deepEqual(turn.map(stripToolUse), expected());
  clearClaudeThinkingStore();
});

test("streaming capture keeps text boundaries when the client opted into the </think> marker", () => {
  const content = captureStreamingTurn(true);
  assert.equal(content, `</think>${FIRST}${SECOND}`);
  const turn = replay(content);
  assert.deepEqual(
    turn.map((block) => block.type),
    ["thinking", "text", "redacted_thinking", "text", "tool_use"]
  );
  assert.deepEqual(
    turn.filter((block) => block.type === "text").map((block) => block.text),
    [`</think>${FIRST}`, SECOND],
    "marker belongs to the first client-visible text block; genuine text is untouched"
  );
  assert.equal(
    turn
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    content
  );
  clearClaudeThinkingStore();
});

test("non-streaming translation replays original text boundaries after concatenation", () => {
  clearClaudeThinkingStore();
  const clientResponse = translateNonStreamingResponse(
    {
      id: "msg_ns_text",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "tool_use",
      content: claudeContent(),
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    null,
    { provider: "claude", model: MODEL, connectionId: CONN }
  ) as { choices: Array<{ message: { content: string } }> };
  assert.equal(clientResponse.choices[0].message.content, `${FIRST}${SECOND}`);

  const turn = replay(clientResponse.choices[0].message.content);
  assert.deepEqual(turn.map(stripToolUse), expected());
  clearClaudeThinkingStore();
});
