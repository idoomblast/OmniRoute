/**
 * Runtime-unit execute mode must apply the #3587 reasoning-token buffer.
 *
 * The buffer lives in two execution sites: the normal target loop (combo.ts) and
 * the round-robin handler. A combo that opts into `nestedComboMode: "execute"`
 * with a simple strategy and executable combo-refs (production example:
 * `deepseek-v4.1-flash`, strategy priority, units [model, combo-ref, combo-ref])
 * is dispatched through `tryRuntimeUnitDispatch` →
 * `open-sse/services/combo/runtimeUnits.ts::executeRuntimeUnitCombo` instead —
 * and that path forwarded each direct model unit's max_tokens verbatim, so the
 * same model buffered fine (10000 → 15000) through a plain combo but not when
 * reached as a runtime unit. This suite pins the parity fix: per-attempt copy +
 * #3587 buffer for model units, with combo-ref units left as black boxes (their
 * own combos buffer their inner targets).
 *
 * Model fixture mirrors tests/unit/reasoning-token-buffer-6274.test.ts: a
 * models.dev capability entry for zhipu/glm-5.2 (reasoning + 65536 output cap)
 * passes the #3587 guards, so 10000 → max(11000, 15000) = 15000.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-runtime-unit-buffer-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "runtime-unit-buffer-test-secret";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../src/lib/modelsDevSync.ts");

function capabilityEntry(limitContext: number, overrides: Record<string, unknown> = {}) {
  return {
    tool_call: true,
    reasoning: false,
    attachment: false,
    structured_output: true,
    temperature: true,
    modalities_input: JSON.stringify(["text"]),
    modalities_output: JSON.stringify(["text"]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: false,
    limit_context: limitContext,
    limit_input: limitContext,
    limit_output: 4096,
    interleaved_field: null,
    ...overrides,
  };
}

test.before(() => {
  // Thinking-capable model with a large output cap: every #3587 guard passes.
  saveModelsDevCapabilities({
    zhipu: {
      "glm-5.2": capabilityEntry(200000, { reasoning: true, limit_output: 65536 }),
    },
  });
});

test.after(() => {
  clearModelsDevCapabilities();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

type Body = Record<string, unknown>;

function okResponse(content: string): Response {
  const body = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeLog() {
  const records: Array<{ level: string; scope: string; msg: string }> = [];
  const cap = (level: string) => (scope: string, msg: string) => {
    records.push({ level, scope, msg: String(msg) });
  };
  return {
    log: { info: cap("info"), warn: cap("warn"), debug: cap("debug"), error: cap("error") },
    records,
  };
}

/** Nested leaf: plain priority combo whose single target buffers normally. */
const LEAF_BUFFER_COMBO = {
  name: "leaf-buffer",
  strategy: "priority",
  models: [{ model: "zhipu/glm-5.2" }],
  config: { maxRetries: 0, retryDelayMs: 0 },
};

/** Parent in execute mode: the production shape that re-routes through runtimeUnits. */
function executeModeCombo(models: unknown[], config: Record<string, unknown> = {}) {
  return {
    name: "runtime-unit-parent",
    strategy: "priority",
    models,
    config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0, ...config },
  };
}

test("execute-mode runtime units apply the reasoning buffer to direct model units", async () => {
  const { log, records } = makeLog();
  const seen: Array<{ model: string; maxTokens: unknown }> = [];
  const handleSingleModel = async (b: Body, m: string) => {
    seen.push({ model: m, maxTokens: b.max_tokens });
    return okResponse("ok");
  };
  const body: Body = { messages: [{ role: "user", content: "hi" }], max_tokens: 10000 };
  const combo = executeModeCombo([
    { model: "zhipu/glm-5.2" },
    { kind: "combo-ref", comboName: "leaf-buffer" },
  ]);

  const res = await handleComboChat({
    body,
    combo,
    handleSingleModel,
    log,
    settings: {},
    allCombos: [combo, LEAF_BUFFER_COMBO],
  });

  assert.equal(res.status, 200);
  assert.equal(
    seen[0]?.model,
    "zhipu/glm-5.2",
    "priority order must dispatch the direct model unit first"
  );
  assert.equal(
    seen[0]?.maxTokens,
    15000,
    "runtime-unit model units must receive the #3587 buffer (10000 -> 15000)"
  );
  assert.ok(
    records.some((r) =>
      r.msg.includes("Reasoning model zhipu/glm-5.2: adjusted max_tokens 10000 -> 15000")
    ),
    "the buffer adjustment must be logged like the normal target loop"
  );
  assert.equal(body.max_tokens, 10000, "the caller's body must not be mutated");
});

test("execute-mode runtime units respect reasoningTokenBufferEnabled: false", async () => {
  const { log } = makeLog();
  const seen: Array<{ model: string; maxTokens: unknown }> = [];
  const handleSingleModel = async (b: Body, m: string) => {
    seen.push({ model: m, maxTokens: b.max_tokens });
    return okResponse("ok");
  };
  const body: Body = { messages: [{ role: "user", content: "hi" }], max_tokens: 10000 };
  const combo = executeModeCombo(
    [{ model: "zhipu/glm-5.2" }, { kind: "combo-ref", comboName: "leaf-buffer" }],
    { reasoningTokenBufferEnabled: false }
  );

  const res = await handleComboChat({
    body,
    combo,
    handleSingleModel,
    log,
    settings: {},
    allCombos: [combo, LEAF_BUFFER_COMBO],
  });

  assert.equal(res.status, 200);
  assert.equal(
    seen[0]?.maxTokens,
    10000,
    "disabled buffer must forward the client's budget verbatim"
  );
});

test("execute-mode runtime units leave an omitted max_tokens absent", async () => {
  const { log } = makeLog();
  const seen: Array<{ model: string; maxTokens: unknown }> = [];
  const handleSingleModel = async (b: Body, m: string) => {
    seen.push({ model: m, maxTokens: b.max_tokens });
    return okResponse("ok");
  };
  const body: Body = { messages: [{ role: "user", content: "hi" }] };
  const combo = executeModeCombo([
    { model: "zhipu/glm-5.2" },
    { kind: "combo-ref", comboName: "leaf-buffer" },
  ]);

  const res = await handleComboChat({
    body,
    combo,
    handleSingleModel,
    log,
    settings: {},
    allCombos: [combo, LEAF_BUFFER_COMBO],
  });

  assert.equal(res.status, 200);
  assert.equal(
    seen[0]?.maxTokens,
    undefined,
    "no client budget means the buffer must not invent one"
  );
});

test("combo-ref units stay black boxes: the nested combo buffers its own target", async () => {
  const { log } = makeLog();
  const seen: Array<{ model: string; maxTokens: unknown }> = [];
  const handleSingleModel = async (b: Body, m: string) => {
    seen.push({ model: m, maxTokens: b.max_tokens });
    return okResponse("ok");
  };
  const body: Body = { messages: [{ role: "user", content: "hi" }], max_tokens: 10000 };
  const combo = executeModeCombo([{ kind: "combo-ref", comboName: "leaf-buffer" }]);

  const res = await handleComboChat({
    body,
    combo,
    handleSingleModel,
    log,
    settings: {},
    allCombos: [combo, LEAF_BUFFER_COMBO],
  });

  assert.equal(res.status, 200);
  assert.equal(seen[0]?.model, "zhipu/glm-5.2", "the referenced combo must execute its own target");
  assert.equal(seen[0]?.maxTokens, 15000, "the nested combo applies the buffer to its own target");
});
