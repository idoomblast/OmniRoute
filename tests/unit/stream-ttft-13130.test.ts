import test from "node:test";
import assert from "node:assert/strict";

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.ts";

/**
 * Regression tests for #13130 — the stream completion payload must carry TTFT.
 *
 * chatCore persists `onComplete().ttft` into call_logs.ttft_ms; before this
 * fix the payload type declared `ttft` but the transform never produced it,
 * so the column stayed NULL for every streamed request.
 */

type CompletePayload = {
  status?: number;
  ttft?: number | null;
};

function makeChunk(content: string): string {
  const chunk = {
    id: "chatcmpl-ttft",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function runStream(rawSSE: string): Promise<CompletePayload | null> {
  let captured: CompletePayload | null = null;
  const transform = createPassthroughStreamWithLogger(
    "test-provider",
    null,
    null,
    "test-model",
    "conn-ttft",
    { model: "test-model" },
    (payload) => {
      captured = payload as CompletePayload;
    }
  );

  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const encoder = new TextEncoder();

  const readAll = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();

  await writer.write(encoder.encode(rawSSE));
  await writer.close();
  await readAll;

  return captured;
}

test("#13130: onComplete carries a finite TTFT for streamed output", async () => {
  const rawSSE = [makeChunk("Hello"), "data: [DONE]\n\n"].join("");

  const payload = await runStream(rawSSE);

  assert.ok(payload, "onComplete should have been called");
  assert.equal(payload.status, 200);
  assert.equal(typeof payload.ttft, "number");
  assert.ok(Number.isFinite(payload.ttft), "TTFT must be finite");
  assert.ok((payload.ttft as number) >= 0, "TTFT must not be negative");
});
