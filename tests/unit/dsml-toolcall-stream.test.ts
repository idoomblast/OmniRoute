/**
 * DSML streaming guard — regression tests for the DeepSeek V4.1-flash crash.
 *
 * `applyDsmlToolCallStreamingGuard` referenced `DSML_OPEN_TAG` / `DSML_CLOSE_TAG`
 * without any binding in scope, so the first content delta of a
 * `deepseek-v4.1-flash` stream threw `ReferenceError` and killed the whole SSE
 * transform — even for plain prose.
 *
 * These tests drive the real `createSSEStream` in PASSTHROUGH mode through a
 * controllable fake upstream and assert that:
 * - complete DSML tool_calls blocks become standard wire `delta.tool_calls`
 *   chunks and never leak the raw DSML markup;
 * - DSML fragmented across several content deltas is still reassembled;
 * - ordinary text passes through untouched;
 * - malformed / incomplete DSML falls back to plain text losslessly.
 *
 * Run with:
 * node --import tsx/esm --test --test-concurrency=1 tests/unit/dsml-toolcall-stream.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeUpstreamStream } from "../helpers/fakeUpstreamStream.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dsml-stream-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const core = await import("../../src/lib/db/core.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");

const MODEL = "deepseek-v4.1-flash";
const DSML_OPEN_TAG = "<｜DSML｜tool_calls>";
const DSML_CLOSE_TAG = "</｜DSML｜tool_calls>";

const DSML_SINGLE = [
  DSML_OPEN_TAG,
  '<｜DSML｜invoke name="terminal">',
  '<｜DSML｜parameter name="command">ls /tmp</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  DSML_CLOSE_TAG,
].join("\n");

// Structurally malformed: the parameter tag is never closed before the invoke
// close, so the block must be rejected and passed through verbatim.
const DSML_MALFORMED = [
  DSML_OPEN_TAG,
  '<｜DSML｜invoke name="terminal">',
  '<｜DSML｜parameter name="command">ls /tmp',
  "</｜DSML｜invoke>",
  DSML_CLOSE_TAG,
].join("\n");

const REQUEST_BODY = {
  model: MODEL,
  tools: [
    {
      type: "function",
      function: {
        name: "terminal",
        description: "run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ],
};

function sseContent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

function sseFinish(reason = "stop"): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function makeStream(options: Parameters<typeof createSSEStream>[0] = {}) {
  const up = fakeUpstreamStream();
  let completion: any;
  const transform = createSSEStream({
    mode: "passthrough",
    model: MODEL,
    body: REQUEST_BODY,
    onComplete: (payload) => {
      completion = payload;
    },
    ...options,
  });
  const out = up.stream.pipeThrough(transform as TransformStream);
  return { up, out, completion: () => completion };
}

/** Drain a client stream to a string with a timeout guard. */
async function drain(out: ReadableStream, timeoutMs = 5000): Promise<string> {
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`drain timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  const read = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  };
  try {
    return await Promise.race([read(), timeout]);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function parseSSEPayloads(text: string): any[] {
  const payloads: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // Non-JSON frames are not part of this contract.
    }
  }
  return payloads;
}

function collectToolCallDeltas(payloads: any[]): any[] {
  const calls: any[] = [];
  for (const payload of payloads) {
    const deltaCalls = payload?.choices?.[0]?.delta?.tool_calls;
    if (Array.isArray(deltaCalls)) calls.push(...deltaCalls);
  }
  return calls;
}

function collectContentDeltas(payloads: any[]): string {
  let content = "";
  for (const payload of payloads) {
    const value = payload?.choices?.[0]?.delta?.content;
    if (typeof value === "string") content += value;
  }
  return content;
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("complete DSML block becomes standard delta.tool_calls with no raw DSML leak", async () => {
  const { up, out } = makeStream();
  up.push(sseContent(DSML_SINGLE));
  up.push(sseFinish());
  up.push(DONE);
  up.close();

  const text = await drain(out);
  const payloads = parseSSEPayloads(text);
  const calls = collectToolCallDeltas(payloads);

  assert.equal(calls.length, 1, `expected exactly one tool call, got: ${JSON.stringify(calls)}`);
  const [call] = calls;
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "terminal");
  assert.equal(typeof call.id, "string");
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "ls /tmp" });

  // The raw DSML markup must never reach the client — neither as content nor
  // as serialized metadata.
  assert.equal(text.includes("｜DSML｜"), false, `raw DSML leaked: ${JSON.stringify(text)}`);
  assert.equal(collectContentDeltas(payloads).includes("DSML"), false);
});

test("DSML fragmented across separate SSE content deltas is reassembled", async () => {
  const { up, out } = makeStream();
  // Deliberately split inside tag names so partial-prefix buffering is exercised.
  const pieces: string[] = [];
  for (let i = 0; i < DSML_SINGLE.length; i += 7) pieces.push(DSML_SINGLE.slice(i, i + 7));
  for (const piece of pieces) up.push(sseContent(piece));
  up.push(sseFinish());
  up.push(DONE);
  up.close();

  const text = await drain(out);
  const payloads = parseSSEPayloads(text);
  const calls = collectToolCallDeltas(payloads);

  assert.equal(
    calls.length,
    1,
    `expected one tool call after reassembly, got: ${JSON.stringify(calls)}`
  );
  assert.equal(calls[0].function.name, "terminal");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: "ls /tmp" });
  assert.equal(text.includes("｜DSML｜"), false, `raw DSML leaked: ${JSON.stringify(text)}`);
});

test("close-tag boundary split (tag name in one delta, '>' in the next) is reassembled", async () => {
  const { up, out } = makeStream();
  const closeTagBody = DSML_CLOSE_TAG.slice(0, -1); // "</｜DSML｜tool_calls" without ">"
  const splitAt = DSML_SINGLE.indexOf(closeTagBody);
  assert.ok(splitAt > 0, "expected the close tag body in the fixture");

  up.push(sseContent(DSML_SINGLE.slice(0, splitAt + closeTagBody.length)));
  up.push(sseContent(DSML_SINGLE.slice(splitAt + closeTagBody.length)));
  up.push(sseFinish());
  up.push(DONE);
  up.close();

  const text = await drain(out);
  const payloads = parseSSEPayloads(text);
  const calls = collectToolCallDeltas(payloads);

  assert.equal(calls.length, 1, `expected one tool call, got: ${JSON.stringify(calls)}`);
  assert.equal(calls[0].function.name, "terminal");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: "ls /tmp" });
  assert.equal(text.includes("｜DSML｜"), false, `raw DSML leaked: ${JSON.stringify(text)}`);
});

test("regular text passes through untouched", async () => {
  const { up, out } = makeStream();
  up.push(sseContent("Hello "));
  up.push(sseContent("plain text."));
  up.push(sseFinish());
  up.push(DONE);
  up.close();

  const text = await drain(out);
  const payloads = parseSSEPayloads(text);

  assert.equal(collectContentDeltas(payloads), "Hello plain text.");
  assert.equal(collectToolCallDeltas(payloads).length, 0);
});

test("malformed DSML block stays lossless as plain text", async () => {
  const { up, out } = makeStream();
  up.push(sseContent(DSML_MALFORMED));
  up.push(sseFinish());
  up.push(DONE);
  up.close();

  const text = await drain(out);
  const payloads = parseSSEPayloads(text);

  // Malformed blocks are never promoted to tool calls...
  assert.equal(collectToolCallDeltas(payloads).length, 0);
  // ...and their text is preserved verbatim (lossless fallback).
  assert.equal(collectContentDeltas(payloads), DSML_MALFORMED);
});

test("unmatched close tag passes through losslessly", async () => {
  const { up, out } = makeStream();
  up.push(sseContent(DSML_CLOSE_TAG));
  up.push(sseFinish());
  up.push(DONE);
  up.close();

  const text = await drain(out);
  const payloads = parseSSEPayloads(text);

  assert.equal(collectToolCallDeltas(payloads).length, 0);
  assert.equal(collectContentDeltas(payloads), DSML_CLOSE_TAG);
});

function sseDelta(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
}

function nativeCall(argumentsText = '{"command":"ls /tmp"}', initial = true) {
  return {
    index: 0,
    ...(initial ? { id: "call_native", type: "function" } : {}),
    function: { ...(initial ? { name: "terminal" } : {}), arguments: argumentsText },
  };
}

function assembledWireCalls(payloads: any[]): any[] {
  const byIndex = new Map<number, any>();
  for (const call of collectToolCallDeltas(payloads)) {
    let accumulated = byIndex.get(call.index);
    if (!accumulated) {
      accumulated = { ...call, function: { ...call.function, arguments: "" } };
      byIndex.set(call.index, accumulated);
    }
    if (call.id) {
      assert.equal(accumulated.id, call.id, "one index must not acquire conflicting identities");
    }
    accumulated.function.arguments += call.function?.arguments ?? "";
  }
  return [...byIndex.values()];
}

function assertCompletionMatches(completion: any, payloads: any[]) {
  const message = completion?.responseBody?.choices?.[0]?.message;
  assert.ok(message, "completion must include the reconstructed call log response");
  assert.equal(message.content ?? "", collectContentDeltas(payloads));
  assert.deepEqual(message.tool_calls ?? [], assembledWireCalls(payloads));
}

async function runFrames(frames: string[], options: Parameters<typeof createSSEStream>[0] = {}) {
  const stream = makeStream(options);
  for (const frame of frames) stream.up.push(frame);
  stream.up.close();
  const text = await drain(stream.out);
  const payloads = parseSSEPayloads(text);
  return { text, payloads, completion: stream.completion() };
}

for (const ordering of ["same-event", "native-before", "native-after", "fragmented-native-after"]) {
  test(`native tool calls win over DSML without duplicate execution: ${ordering}`, async () => {
    let frames: string[];
    if (ordering === "same-event") {
      frames = [sseDelta({ content: DSML_SINGLE, tool_calls: [nativeCall()] })];
    } else if (ordering === "native-before") {
      frames = [sseDelta({ tool_calls: [nativeCall()] }), sseContent(DSML_SINGLE)];
    } else if (ordering === "fragmented-native-after") {
      frames = [
        sseContent(DSML_SINGLE),
        sseDelta({ tool_calls: [nativeCall('{"command":')] }),
        sseDelta({ tool_calls: [nativeCall('"ls /tmp"}', false)] }),
      ];
    } else {
      frames = [sseContent(DSML_SINGLE), sseDelta({ tool_calls: [nativeCall()] })];
    }
    const { text, payloads, completion } = await runFrames([...frames, sseFinish(), DONE]);
    const calls = assembledWireCalls(payloads);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "call_native");
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: "ls /tmp" });
    assert.equal(text.includes("｜DSML｜"), false);
    assertCompletionMatches(completion, payloads);
  });
}

for (const input of [
  `before ${DSML_SINGLE} after`,
  `before ${DSML_MALFORMED} between ${DSML_SINGLE} after`,
  `before ${DSML_SINGLE} between ${DSML_MALFORMED} after`,
]) {
  test(`converted DSML retains ordered prose and malformed neighbors: ${input.indexOf(DSML_MALFORMED)}`, async () => {
    const { payloads, completion } = await runFrames([sseContent(input), sseFinish(), DONE]);
    assert.equal(collectContentDeltas(payloads), input.replace(DSML_SINGLE, ""));
    assert.equal(assembledWireCalls(payloads).length, 1);
    assertCompletionMatches(completion, payloads);
  });
}

for (const ending of ["finish", "done", "eof"]) {
  test(`incomplete DSML is drained losslessly before ${ending}`, async () => {
    const input = `before ${DSML_SINGLE.slice(0, -8)}`;
    const frames = [sseContent(input)];
    if (ending === "finish") frames.push(sseFinish(), DONE);
    if (ending === "done") frames.push(DONE);
    const { text, payloads, completion } = await runFrames(frames);
    assert.equal(collectContentDeltas(payloads), input);
    assert.equal(assembledWireCalls(payloads).length, 0);
    const contentAt = payloads.findIndex((p) => p.choices?.[0]?.delta?.content?.includes("DSML"));
    const finishAt = payloads.findIndex((p) => p.choices?.[0]?.finish_reason);
    assert.ok(contentAt >= 0 && finishAt >= contentAt, "content must precede completion");
    assert.ok(text.lastIndexOf("[DONE]") > text.indexOf("DSML"));
    assertCompletionMatches(completion, payloads);
  });
}

for (let split = 1; split <= DSML_OPEN_TAG.length; split++) {
  test(`opening DSML tag is retained at split ${split} after prose`, async () => {
    const { text, payloads, completion } = await runFrames([
      sseContent(`before ${DSML_SINGLE.slice(0, split)}`),
      sseContent(DSML_SINGLE.slice(split)),
      sseContent(" after"),
      sseFinish(),
      DONE,
    ]);
    assert.equal(collectContentDeltas(payloads), "before  after");
    assert.equal(assembledWireCalls(payloads).length, 1);
    assert.equal(text.includes("｜DSML｜"), false);
    assertCompletionMatches(completion, payloads);
  });
}

test("a complete block does not evict the following partial block", async () => {
  const { text, payloads, completion } = await runFrames([
    sseContent(`${DSML_SINGLE} between ${DSML_SINGLE.slice(0, 35)}`),
    sseContent(DSML_SINGLE.slice(35)),
    sseContent(" after"),
    sseFinish(),
    DONE,
  ]);
  assert.equal(collectContentDeltas(payloads), " between  after");
  const calls = assembledWireCalls(payloads);
  assert.deepEqual(
    calls.map((call) => call.index),
    [0, 1]
  );
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(text.includes("｜DSML｜"), false);
  assertCompletionMatches(completion, payloads);
});

test("a released safe prefix is included in the completion exactly once", async () => {
  const { payloads, completion } = await runFrames([
    sseContent(`prefix ${DSML_SINGLE.slice(0, 40)}`),
    sseContent(DSML_SINGLE.slice(40)),
    sseContent(" suffix"),
    sseFinish(),
    DONE,
  ]);
  assert.equal(collectContentDeltas(payloads), "prefix  suffix");
  assertCompletionMatches(completion, payloads);
});

for (const content of [DSML_SINGLE, DSML_SINGLE.slice(0, 50), "ordinary tail"]) {
  test(`final no-newline SSE data passes through the guard: ${content.length}`, async () => {
    const { text, payloads, completion } = await runFrames([sseContent(content).trimEnd()]);
    assert.equal(collectContentDeltas(payloads), content === DSML_SINGLE ? "" : content);
    assert.equal(assembledWireCalls(payloads).length, content === DSML_SINGLE ? 1 : 0);
    if (content === DSML_SINGLE) assert.equal(text.includes("｜DSML｜"), false);
    assertCompletionMatches(completion, payloads);
  });
}

test("unsupported models retain raw DSML as ordinary text", async () => {
  const { payloads } = await runFrames([sseContent(DSML_SINGLE), sseFinish(), DONE], {
    model: "gpt-4o",
  });
  assert.equal(collectContentDeltas(payloads), DSML_SINGLE);
  assert.equal(assembledWireCalls(payloads).length, 0);
});

test("DSML admission still rejects tools outside the request schema", async () => {
  const { text, payloads } = await runFrames([
    sseContent(DSML_SINGLE.replace('name="terminal"', 'name="unknown_tool"')),
    sseFinish(),
    DONE,
  ]);
  assert.equal(assembledWireCalls(payloads).length, 0);
  assert.equal(text.includes("｜DSML｜"), false);
});

test("plain less-than comparisons do not lose following prose", async () => {
  const { payloads, completion } = await runFrames([
    sseContent("2 <"),
    sseContent(" 3 and this is prose"),
    sseFinish(),
    DONE,
  ]);
  assert.equal(collectContentDeltas(payloads), "2 < 3 and this is prose");
  assertCompletionMatches(completion, payloads);
});

test("drain releases its reader on upstream errors", async () => {
  const out = new ReadableStream({
    start: (controller) => controller.error(new Error("read failure")),
  });
  await assert.rejects(drain(out), /read failure/);
  assert.equal(out.locked, false);
});

test("drain clears the timeout on success", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  let handle: ReturnType<typeof setTimeout> | undefined;
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    handle = originalSetTimeout(...args);
    return handle;
  });
  const clear = t.mock.method(globalThis, "clearTimeout");
  const out = new ReadableStream({ start: (controller) => controller.close() });
  try {
    await drain(out);
    assert.ok(clear.mock.calls.some((call) => call.arguments[0] === handle));
    assert.equal(out.locked, false);
  } finally {
    if (handle) clearTimeout(handle);
  }
});

test("drain cancels and releases the reader on timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const out = new ReadableStream({
    cancel: () => {
      cancelled = true;
    },
  });
  const reading = assert.rejects(drain(out, 50), /drain timeout/);
  t.mock.timers.tick(50);
  await reading;
  assert.equal(cancelled, true);
  assert.equal(out.locked, false);
});

test("pending DSML does not swallow upstream stream errors", async () => {
  const { up, out } = makeStream();
  up.push(sseContent(DSML_SINGLE.slice(0, 40)));
  const reading = assert.rejects(drain(out), /upstream failed/);
  up.error(new Error("upstream failed"));
  await reading;
});

test("cancelling a pending DSML stream reaches upstream", async () => {
  const { up, out } = makeStream();
  const cancelled = new Promise<unknown>((resolve) => up.onCancel(resolve));
  up.push(sseContent(DSML_SINGLE.slice(0, 40)));
  const reader = out.getReader();
  try {
    await reader.read();
    await reader.cancel("client stopped");
    assert.equal(await cancelled, "client stopped");
  } finally {
    reader.releaseLock();
  }
});
