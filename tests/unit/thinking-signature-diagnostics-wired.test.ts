/**
 * The THINKING_SIGNATURE diagnostics emitter must fire from the production
 * recovery path (chatCore -> recoverAnthropicThinkingSignature), not only exist
 * as a test-only module.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recoverAnthropicThinkingSignature } from "../../open-sse/handlers/chatCore/thinkingSignatureRecovery.ts";

test("failed signature recovery emits the production THINKING_SIGNATURE diagnostic", async () => {
  const events: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const result = await recoverAnthropicThinkingSignature({
    provider: "claude",
    model: "claude-sonnet-4-5",
    statusCode: 400,
    message:
      "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
    body: {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "sig" },
            { type: "tool_use", id: "toolu_1", name: "read", input: {} },
          ],
        },
      ],
    },
    execute: async () => ({
      response: new Response(JSON.stringify({ error: { message: "invalid signature" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    }),
    parseError: async () => ({
      statusCode: 400,
      message: "invalid signature",
      retryAfterMs: null,
      responseBody: {},
    }),
    diagnostics: {
      correlationId: "00000000-0000-4000-8000-000000000000",
      noLog: false,
      log: {
        warn: (tag: string, message: string) => events.push({ tag, payload: JSON.parse(message) }),
      },
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.succeeded, false);
  assert.equal(events.length, 1, "one diagnostic event per attempted recovery");
  assert.equal(events[0].tag, "THINKING_SIGNATURE");
  assert.equal(events[0].payload.correlationId, "00000000-0000-4000-8000-000000000000");
  assert.equal(events[0].payload.recoveryAttempted, true);
});

test("recovery respects noLog by emitting nothing", async () => {
  const events: unknown[] = [];
  await recoverAnthropicThinkingSignature({
    provider: "claude",
    model: "claude-sonnet-4-5",
    statusCode: 400,
    message:
      "thinking or redacted_thinking blocks in the latest assistant message cannot be modified",
    body: {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "sig" },
            { type: "tool_use", id: "toolu_1", name: "read", input: {} },
          ],
        },
      ],
    },
    execute: async () => ({
      response: new Response("{}", {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    }),
    parseError: async () => ({
      statusCode: 400,
      message: "invalid signature",
      retryAfterMs: null,
      responseBody: {},
    }),
    diagnostics: {
      noLog: true,
      log: { warn: (_tag: string, message: string) => events.push(message) },
    },
  });
  assert.deepEqual(events, []);
});
