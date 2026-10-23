import test from "node:test";
import assert from "node:assert/strict";

const { truncateForLog, cloneBoundedChatLogPayload, truncateChatLogText } =
  await import("../../open-sse/handlers/chatCore/logTruncation.ts");
const { cloneBoundedForLog } = await import("../../open-sse/utils/requestLogger.ts");
const { isCallLogNoTruncate } = await import("../../src/lib/logEnv.ts");

function withNoTruncate(fn: () => void) {
  process.env.CALL_LOG_NO_TRUNCATE = "true";
  try {
    fn();
  } finally {
    delete process.env.CALL_LOG_NO_TRUNCATE;
  }
}

function buildLargeBody(messageCount: number) {
  return {
    model: "test-model",
    stream: true,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} `.repeat(400),
      tools: [{ type: "function", function: { name: `tool_${i}`, description: "d".repeat(500) } }],
    })),
  };
}

test("CALL_LOG_NO_TRUNCATE defaults to off", () => {
  delete process.env.CALL_LOG_NO_TRUNCATE;
  assert.equal(isCallLogNoTruncate(), false);
});

test("truncateForLog collapses >8KB bodies into a summary by default", () => {
  delete process.env.CALL_LOG_NO_TRUNCATE;
  const out = truncateForLog(buildLargeBody(40)) as Record<string, unknown>;
  assert.equal(out._truncated, true);
  assert.equal(typeof out._originalBytes, "number");
  assert.equal(out.model, "test-model");
});

test("truncateForLog keeps the full body when CALL_LOG_NO_TRUNCATE is set", () =>
  withNoTruncate(() => {
    const body = buildLargeBody(40);
    const out = truncateForLog(body) as Record<string, unknown>;
    assert.equal(out._truncated, undefined);
    assert.equal((out.messages as unknown[]).length, 40);
    assert.deepEqual(out, body);
  }));

test("cloneBoundedChatLogPayload keeps every message and long string when enabled", () =>
  withNoTruncate(() => {
    const body = buildLargeBody(100);
    const cloned = cloneBoundedChatLogPayload(body) as Record<string, unknown>;
    const messages = cloned.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 100);
    assert.deepEqual(cloned, body);
  }));

test("cloneBoundedChatLogPayload still tail-truncates arrays when disabled", () => {
  delete process.env.CALL_LOG_NO_TRUNCATE;
  const cloned = cloneBoundedChatLogPayload(new Array(100).fill("a")) as unknown[];
  assert.equal((cloned[0] as Record<string, unknown>)._omniroute_truncated_array, true);
});

test("cloneBoundedForLog keeps pipeline payloads intact when enabled", () =>
  withNoTruncate(() => {
    const body = buildLargeBody(60);
    const cloned = cloneBoundedForLog(body) as Record<string, unknown>;
    assert.equal((cloned.messages as unknown[]).length, 60);
    assert.deepEqual(cloned, body);
  }));

test("truncateChatLogText keeps over-limit strings whole when enabled", () =>
  withNoTruncate(() => {
    const value = "x".repeat(200 * 1024);
    assert.equal(truncateChatLogText(value), value);
  }));
