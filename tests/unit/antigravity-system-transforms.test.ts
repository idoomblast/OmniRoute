/**
 * systemTransforms → Antigravity wiring (regression).
 *
 * Covers the gap that made `providers.antigravity` dead config: the base DSL
 * only runs on Anthropic-shaped `body.system`, while Antigravity ships a
 * Gemini-shaped `request.systemInstruction`. These tests pin the behaviour of
 * the bridge added in open-sse/services/antigravitySystemTransforms.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAntigravitySystemTransforms,
  countTextParts,
  PROVIDER_ANTIGRAVITY,
} from "../../open-sse/services/antigravitySystemTransforms.ts";
import {
  resetSystemTransformsConfig,
  setSystemTransformsConfig,
} from "../../open-sse/services/systemTransforms.ts";

function geminiRequest(systemText: string, userText = "hello") {
  return {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    systemInstruction: { role: "system", parts: [{ text: systemText }] },
  };
}

function enableAntigravity(pipeline: unknown[]) {
  setSystemTransformsConfig({
    providers: {
      [PROVIDER_ANTIGRAVITY]: { enabled: true, pipeline },
    },
  });
}

test.afterEach(() => resetSystemTransformsConfig());

test("replace_text rewrites the system instruction (Hermes → H3rm3s)", () => {
  enableAntigravity([
    { kind: "replace_text", match: "Hermes", replacement: "H3rm3s", allOccurrences: true },
  ]);
  const req = geminiRequest("You are Hermes Agent, an AI assistant. Hermes again.");

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, ["replace_text"]);
  assert.equal(
    req.systemInstruction.parts[0].text,
    "You are H3rm3s Agent, an AI assistant. H3rm3s again."
  );
});

test("contents are left untouched unless targets opts into messages", () => {
  enableAntigravity([
    { kind: "replace_text", match: "Hermes", replacement: "H3rm3s", allOccurrences: true },
  ]);
  const req = geminiRequest("You are Hermes Agent", "please inspect Hermes source");

  applyAntigravitySystemTransforms(req);
  assert.match(req.systemInstruction.parts[0].text, /H3rm3s/);
  assert.match(req.contents[0].parts[0].text, /Hermes source/);

  const withMessages = geminiRequest("You are Hermes Agent", "please inspect Hermes source");
  enableAntigravity([
    {
      kind: "replace_text",
      match: "Hermes",
      replacement: "H3rm3s",
      allOccurrences: true,
      targets: ["system", "messages"],
    },
  ]);
  const result = applyAntigravitySystemTransforms(withMessages);
  assert.equal(result.targetedMessages, true);
  assert.match(withMessages.contents[0].parts[0].text, /H3rm3s source/);
});

test("replace_regex supports case-insensitive substitution", () => {
  enableAntigravity([
    { kind: "replace_regex", pattern: "hermes", flags: "gi", replacement: "H3rm3s" },
  ]);
  const req = geminiRequest("you are HERMES agent / hermes-agent");

  applyAntigravitySystemTransforms(req);
  assert.equal(req.systemInstruction.parts[0].text, "you are H3rm3s agent / H3rm3s-agent");
});

test("disabled provider entry is a strict no-op", () => {
  setSystemTransformsConfig({
    providers: {
      [PROVIDER_ANTIGRAVITY]: {
        enabled: false,
        pipeline: [{ kind: "replace_text", match: "Hermes", replacement: "H3rm3s" }],
      },
    },
  });
  const req = geminiRequest("You are Hermes Agent");
  const before = JSON.stringify(req);

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, []);
  assert.equal(JSON.stringify(req), before);
});

test("missing provider entry is a strict no-op", () => {
  resetSystemTransformsConfig();
  const req = geminiRequest("You are Hermes Agent");
  const before = JSON.stringify(req);

  applyAntigravitySystemTransforms(req);

  assert.equal(JSON.stringify(req), before);
});

test("structural ops are ignored instead of corrupting the Gemini envelope", () => {
  enableAntigravity([
    { kind: "prepend_system_block", text: "billing" },
    { kind: "drop_paragraph_if_contains", needles: ["Hermes"] },
  ]);
  const req = geminiRequest("You are Hermes Agent");
  const before = JSON.stringify(req);

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, []);
  assert.equal(JSON.stringify(req), before);
});

test("malformed regex is skipped without throwing", () => {
  enableAntigravity([{ kind: "replace_regex", pattern: "([a-z", flags: "g", replacement: "x" }]);
  const req = geminiRequest("You are Hermes Agent");

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, []);
  assert.equal(req.systemInstruction.parts[0].text, "You are Hermes Agent");
});

test("countTextParts counts system parts by default and message parts on request", () => {
  const req = geminiRequest("sys", "user");
  assert.equal(countTextParts(req), 1);
  assert.equal(countTextParts(req, true), 2);
});

test("non-text parts (function calls) are never rewritten", () => {
  enableAntigravity([
    { kind: "replace_text", match: "Hermes", replacement: "H3rm3s", allOccurrences: true },
  ]);
  const req = {
    contents: [
      {
        role: "model",
        parts: [{ functionCall: { name: "run_hermes", args: { q: "Hermes" } } }],
      },
    ],
    systemInstruction: { parts: [{ text: "You are Hermes Agent" }] },
  };

  applyAntigravitySystemTransforms(req);

  const call = (req.contents[0].parts[0] as { functionCall: { name: string; args: { q: string } } })
    .functionCall;
  assert.equal(call.name, "run_hermes");
  assert.equal(call.args.q, "Hermes");
});
