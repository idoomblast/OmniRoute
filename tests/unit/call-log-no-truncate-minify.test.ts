import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR must be set before importing callLogArtifacts: CALL_LOGS_DIR is
// captured at module load time.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-minify-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { writeCallArtifact, readCallArtifact } =
  await import("../../src/lib/usage/callLogArtifacts.ts");

type Artifact = Parameters<typeof writeCallArtifact>[0];

const ORIGINAL = {
  CALL_LOG_NO_TRUNCATE: process.env.CALL_LOG_NO_TRUNCATE,
  CHAT_DEBUG_FILE: process.env.CHAT_DEBUG_FILE,
  APP_LOG_LEVEL: process.env.APP_LOG_LEVEL,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function buildArtifact(): Artifact {
  return {
    schemaVersion: 5,
    summary: {
      id: "test-id-1",
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "test-model",
      requestedModel: null,
      provider: "test",
      account: "test",
      connectionId: null,
      duration: 10,
      tokens: {
        in: 1,
        out: 2,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: null,
      sourceFormat: null,
      targetFormat: null,
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { messages: [{ role: "user", content: "hello" }] },
    responseBody: { choices: [{ message: { role: "assistant", content: "hi" } }] },
    error: null,
  };
}

function writeAndReadRaw() {
  const artifact = buildArtifact();
  const result = writeCallArtifact(artifact);
  assert.ok(result, "artifact write should succeed");
  return fs.readFileSync(path.join(TEST_DATA_DIR, "call_logs", result.relPath), "utf8");
}

test.after(() => {
  restoreEnv();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("CALL_LOG_NO_TRUNCATE wins over CHAT_DEBUG_FILE: artifact stays compact", () => {
  process.env.CALL_LOG_NO_TRUNCATE = "true";
  process.env.CHAT_DEBUG_FILE = "true";
  const raw = writeAndReadRaw();
  assert.equal(raw.includes("\n"), false, "no-truncate artifact must not be pretty-printed");
  assert.equal(JSON.parse(raw).summary.id, "test-id-1");
});

test("CALL_LOG_NO_TRUNCATE wins over APP_LOG_LEVEL=debug: artifact stays compact", () => {
  process.env.CALL_LOG_NO_TRUNCATE = "true";
  delete process.env.CHAT_DEBUG_FILE;
  process.env.APP_LOG_LEVEL = "debug";
  const raw = writeAndReadRaw();
  assert.equal(raw.includes("\n"), false, "no-truncate artifact must not be pretty-printed");
  assert.equal(JSON.parse(raw).summary.id, "test-id-1");
});

test("debug mode without no-truncate still pretty-prints for humans", () => {
  delete process.env.CALL_LOG_NO_TRUNCATE;
  process.env.CHAT_DEBUG_FILE = "true";
  const raw = writeAndReadRaw();
  assert.ok(raw.includes("\n"), "debug artifact should be pretty-printed");
  const parsed = readCallArtifact(null); // sanity: reader API still usable
  assert.equal(parsed.state, "missing");
});

test("default mode stays compact", () => {
  delete process.env.CALL_LOG_NO_TRUNCATE;
  delete process.env.CHAT_DEBUG_FILE;
  process.env.APP_LOG_LEVEL = "info";
  const raw = writeAndReadRaw();
  assert.equal(raw.includes("\n"), false);
  assert.equal(JSON.parse(raw).summary.id, "test-id-1");
});
