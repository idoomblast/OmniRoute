import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #13130: call_logs.ttft_ms was never written because the INSERT neither listed
// the column nor bound the streaming tail's ttft. Locks the persistence path,
// the non-stream NULL behavior, and the getCallLogs mapping.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-ttft-"));

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const { persistAttemptLogs } = await import("../../open-sse/handlers/chatCore/attemptLogging.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 1000,
    tokens: { in: 10, out: 50 },
    ...overrides,
  } as Record<string, unknown>;
}

function readRow(id: string) {
  const db = core.getDbInstance();
  return db.prepare("SELECT id, duration, ttft_ms FROM call_logs WHERE id = ?").get(id) as
    { id: string; duration: number; ttft_ms: number | null } | undefined;
}

test("saveCallLog persists the streaming ttft into call_logs.ttft_ms", async () => {
  const id = `ttft-stream-${Date.now()}`;
  await callLogs.saveCallLog(baseEntry({ id, ttft: 250 }));

  const row = readRow(id);
  assert.ok(row, "row should exist");
  assert.equal(row.ttft_ms, 250);
  assert.ok(row.ttft_ms < row.duration, "TTFT must be below total duration");
});

test("saveCallLog stores NULL ttft_ms for the non-stream path", async () => {
  const id = `ttft-nonstream-${Date.now()}`;
  await callLogs.saveCallLog(baseEntry({ id }));

  const row = readRow(id);
  assert.ok(row, "row should exist");
  assert.equal(row.ttft_ms, null, "non-stream rows must not fake a TTFT");
});

test("saveCallLog normalizes negative and non-finite TTFT to NULL", async () => {
  const negativeId = `ttft-negative-${Date.now()}`;
  const nanId = `ttft-nan-${Date.now()}`;

  await callLogs.saveCallLog(baseEntry({ id: negativeId, ttft: -5 }));
  await callLogs.saveCallLog(baseEntry({ id: nanId, ttft: Number.NaN }));

  assert.equal(readRow(negativeId)?.ttft_ms, null);
  assert.equal(readRow(nanId)?.ttft_ms, null);
});

test("getCallLogs exposes the persisted TTFT as ttft", async () => {
  const id = `ttft-mapped-${Date.now()}`;
  await callLogs.saveCallLog(baseEntry({ id, ttft: 321 }));

  const logs = await callLogs.getCallLogs({ limit: 200 });
  const found = logs.find((log: { id: string }) => log.id === id) as
    { ttft: number | null } | undefined;
  assert.ok(found, "log entry should be returned by getCallLogs");
  assert.equal(found.ttft, 321);
});

test("persistAttemptLogs forwards the streaming ttft to the writer", async () => {
  const id = `ttft-attempt-${Date.now()}`;
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 }, ttft: 123 },
    {
      traceId: `trace-${id}`,
      provider: "openai",
      connectionId: "conn-1",
      model: "gpt-x",
      skillRequestId: "skill-1",
      detailedLoggingEnabled: false,
      reqLogger: null,
      pendingRequestId: id,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      requestedModel: "gpt-x",
      credentials: { connectionId: "conn-1" },
      startTime: Date.now(),
      body: { messages: [{ role: "user", content: "hi" }] },
      sourceFormat: "openai",
      targetFormat: "openai",
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
      tokensCompressed: 0,
      apiKeyInfo: null,
      noLogEnabled: false,
    }
  );

  let row: { ttft?: number | null } | null = null;
  for (let i = 0; i < 120 && !row; i++) {
    row = (await callLogs.getCallLogById(id)) as { ttft?: number | null } | null;
    if (!row) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(row, "attempt call log row should be persisted");
  assert.equal(row.ttft, 123);
});
