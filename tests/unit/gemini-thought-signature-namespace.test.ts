/**
 * Non-streaming Gemini responses must persist thought signatures under the same
 * namespace the next request reads: `<connection>:<family>:<toolId>`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.ts";
import { resolveGeminiThoughtSignature } from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

test("streaming Gemini tool response stores its signature under the request namespace", async () => {
  const state: {
    toolCalls: Map<unknown, unknown>;
    signatureNamespace: string;
    pendingThoughtSignature?: unknown;
  } = { toolCalls: new Map(), signatureNamespace: "conn-antigravity-1" };
  const result = geminiToOpenAIResponse(
    {
      responseId: "resp-split-signature",
      modelVersion: "gemini-3-flash-agent",
      candidates: [
        {
          content: {
            parts: [
              { thoughtSignature: "sig-split-1" },
              {
                functionCall: {
                  id: "call_split_1",
                  name: "read_file",
                  args: { path: "/tmp/a" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    state
  );

  type StreamEvent = { choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string }> } }> };
  const toolCall = (result as StreamEvent[]).find((event) => event.choices?.[0]?.delta?.tool_calls)
    ?.choices[0].delta?.tool_calls?.[0];
  assert.equal(toolCall?.id, "call_split_1");
  assert.equal(state.pendingThoughtSignature, null);
  assert.equal(
    resolveGeminiThoughtSignature("conn-antigravity-1:gemini:call_split_1"),
    "sig-split-1"
  );
});

test("non-streaming Gemini tool response stores its signature under the request namespace", () => {
  translateNonStreamingResponse(
    {
      responseId: "resp-ns-sig",
      modelVersion: "gemini-3-flash-agent",
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { id: "call_ns_1", name: "read_file", args: { path: "/tmp/a" } },
                thoughtSignature: "sig-ns-1",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    FORMATS.GEMINI,
    FORMATS.OPENAI,
    null,
    { provider: "antigravity", model: "gemini-3-flash-agent", connectionId: "conn-ns" }
  );

  assert.equal(
    resolveGeminiThoughtSignature("conn-ns:gemini:call_ns_1"),
    "sig-ns-1",
    "writer and reader must agree on <connection>:<family>:<toolId>"
  );
});
