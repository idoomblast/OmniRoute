import test from "node:test";
import assert from "node:assert/strict";

import { injectHandoffIntoBody } from "../../open-sse/services/contextHandoff.ts";
import type { HandoffPayload } from "../../src/lib/db/contextHandoffs.ts";

const payload: HandoffPayload = {
  sessionId: "s",
  comboName: "c",
  fromAccount: "a",
  summary: "prior work",
  keyDecisions: [],
  taskProgress: "halfway",
  activeEntities: [],
  messageCount: 3,
  model: "claude-opus-5",
  warningThresholdPct: 85,
  generatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test("Claude-native handoff appends to the top-level system field", () => {
  const body = {
    system: "existing system",
    messages: [{ role: "user", content: "hello" }],
  };
  const next = injectHandoffIntoBody(body, payload, "claude");
  assert.equal(Array.isArray(next.system), true);
  const system = next.system as Array<Record<string, unknown>>;
  assert.equal(system[0].text, "existing system");
  assert.match(String(system[1].text), /context_handoff/);
  assert.equal((next.messages as Array<Record<string, unknown>>)[0].role, "user");
});

test("non-Claude handoff keeps the legacy leading system message", () => {
  const body = { messages: [{ role: "user", content: "hello" }] };
  const next = injectHandoffIntoBody(body, payload, "openai");
  assert.equal((next.messages as Array<Record<string, unknown>>)[0].role, "system");
});
