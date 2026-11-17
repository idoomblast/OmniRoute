/**
 * systemTransforms → Antigravity wiring (regression).
 *
 * Covers the gap that made `providers.antigravity` dead config: the base DSL
 * only runs on Anthropic-shaped `body.system`, while Antigravity ships a
 * Gemini-shaped `request.systemInstruction`. These tests pin the bridge in
 * open-sse/services/antigravitySystemTransforms.ts, including the executor
 * retry boundary (clone-on-write) and the real settings-schema boundary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAntigravitySystemTransforms,
  PROVIDER_ANTIGRAVITY,
} from "../../open-sse/services/antigravitySystemTransforms.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import {
  resetSystemTransformsConfig,
  setSystemTransformsConfig,
} from "../../open-sse/services/systemTransforms.ts";
import { updateSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";

type TextPart = Record<string, unknown> & { text?: string };

type GeminiRequest = {
  contents: Array<{ role?: string; parts: TextPart[] }>;
  systemInstruction: { role?: string; parts: TextPart[] };
  tools?: Array<Record<string, unknown>>;
};

function geminiRequest(systemText: string, userText = "hello"): GeminiRequest {
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

function systemTextOf(request: Record<string, unknown>): string | undefined {
  const system = request.systemInstruction as { parts?: TextPart[] } | undefined;
  return system?.parts?.[0]?.text;
}

/** Mirrors the executor: each attempt derives a fresh body from the caller's input. */
function transformAttempt(input: GeminiRequest): string | undefined {
  const attempt = { ...input } as Record<string, unknown>;
  applyAntigravitySystemTransforms(attempt);
  return systemTextOf(attempt);
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
  const originalContents = req.contents;

  applyAntigravitySystemTransforms(req);
  assert.match(req.systemInstruction.parts[0].text as string, /H3rm3s/);
  assert.match(req.contents[0].parts[0].text as string, /Hermes source/);
  assert.equal(req.contents, originalContents, "untargeted contents array must keep identity");

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
  assert.match(withMessages.contents[0].parts[0].text as string, /H3rm3s source/);
});

test("explicit targets exclude the system instruction", () => {
  enableAntigravity([{ kind: "obfuscate_words", words: ["Hermes"], targets: ["messages"] }]);
  const req = geminiRequest("You are Hermes Agent", "please inspect Hermes source");
  const systemBefore = req.systemInstruction.parts[0].text;

  applyAntigravitySystemTransforms(req);

  assert.equal(req.systemInstruction.parts[0].text, systemBefore);
  assert.notEqual(req.contents[0].parts[0].text, "please inspect Hermes source");
});

test("tools are never rewritten, even when messages are targeted", () => {
  enableAntigravity([
    {
      kind: "replace_text",
      match: "Hermes",
      replacement: "H3rm3s",
      allOccurrences: true,
      targets: ["system", "messages", "tools"],
    },
  ]);
  const req = geminiRequest("You are Hermes Agent", "Hermes source");
  req.tools = [
    {
      functionDeclarations: [
        { name: "run_hermes", description: "Runs the Hermes helper", parameters: {} },
      ],
    },
  ];
  const toolsBefore = JSON.stringify(req.tools);

  applyAntigravitySystemTransforms(req);

  assert.equal(JSON.stringify(req.tools), toolsBefore);
  assert.match(req.systemInstruction.parts[0].text as string, /H3rm3s/);
  assert.match(req.contents[0].parts[0].text as string, /H3rm3s/);
});

test("non-text parts inside targeted contents survive untouched", () => {
  enableAntigravity([
    {
      kind: "replace_text",
      match: "Hermes",
      replacement: "H3rm3s",
      allOccurrences: true,
      targets: ["system", "messages"],
    },
  ]);
  const req = geminiRequest("You are Hermes Agent", "call the tool");
  req.contents.push({
    role: "model",
    parts: [
      { functionCall: { name: "run_hermes", args: { q: "Hermes" } } },
      { functionResponse: { name: "run_hermes", response: { result: "Hermes ok" } } },
      { inlineData: { mimeType: "text/plain", data: "Hermes" } },
    ],
  });

  applyAntigravitySystemTransforms(req);

  const parts = req.contents[1].parts;
  assert.deepEqual(parts[0], { functionCall: { name: "run_hermes", args: { q: "Hermes" } } });
  assert.deepEqual(parts[1], {
    functionResponse: { name: "run_hermes", response: { result: "Hermes ok" } },
  });
  assert.deepEqual(parts[2], { inlineData: { mimeType: "text/plain", data: "Hermes" } });
});

test("replace_regex honours supplied flags instead of forcing global", () => {
  enableAntigravity([{ kind: "replace_regex", pattern: "Hermes", flags: "i", replacement: "X" }]);
  const req = geminiRequest("Hermes hermes");
  applyAntigravitySystemTransforms(req);
  assert.equal(req.systemInstruction.parts[0].text, "X hermes");

  const withGlobal = geminiRequest("Hermes hermes");
  enableAntigravity([{ kind: "replace_regex", pattern: "hermes", flags: "gi", replacement: "X" }]);
  applyAntigravitySystemTransforms(withGlobal);
  assert.equal(withGlobal.systemInstruction.parts[0].text, "X X");

  const withoutFlags = geminiRequest("Hermes Hermes");
  enableAntigravity([{ kind: "replace_regex", pattern: "Hermes", replacement: "X" }]);
  applyAntigravitySystemTransforms(withoutFlags);
  assert.equal(withoutFlags.systemInstruction.parts[0].text, "X Hermes");
});

test("repeated attempts do not compound the transform (retry boundary)", () => {
  enableAntigravity([{ kind: "replace_text", match: "Hermes", replacement: "HermesX" }]);
  const input = geminiRequest("Hermes agent");
  const originalPart = input.systemInstruction.parts[0];
  const originalContents = input.contents;

  const first = transformAttempt(input);
  const second = transformAttempt(input);
  const third = transformAttempt(input);

  assert.equal(first, "HermesX agent");
  assert.equal(second, "HermesX agent");
  assert.equal(third, "HermesX agent");
  assert.equal(input.systemInstruction.parts[0], originalPart, "caller part must not be replaced");
  assert.equal(input.systemInstruction.parts[0].text, "Hermes agent");
  assert.equal(input.contents, originalContents);
  assert.equal(input.contents[0].parts[0].text, "hello");
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
  const systemInstruction = req.systemInstruction;
  const before = JSON.stringify(req);

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, []);
  assert.equal(JSON.stringify(req), before);
  assert.equal(req.systemInstruction, systemInstruction);
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

test("malformed config entries are skipped without throwing", () => {
  setSystemTransformsConfig({
    providers: {
      [PROVIDER_ANTIGRAVITY]: {
        enabled: true,
        pipeline: [
          null,
          { kind: "obfuscate_words", words: "Hermes" },
          { kind: "replace_regex", pattern: "([a-z", flags: "g", replacement: "x" },
        ],
      },
    },
  });
  const req = geminiRequest("You are Hermes Agent");

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, []);
  assert.equal(req.systemInstruction.parts[0].text, "You are Hermes Agent");
});

test("settings schema preserves targets for replacements", () => {
  const pipeline = [
    {
      kind: "replace_text",
      match: "Hermes",
      replacement: "H3rm3s",
      allOccurrences: true,
      targets: ["system", "messages"],
    },
    {
      kind: "replace_regex",
      pattern: "hermes",
      flags: "gi",
      replacement: "H3rm3s",
      targets: ["messages"],
    },
  ];

  const parsed = updateSettingsSchema.parse({
    systemTransforms: { providers: { [PROVIDER_ANTIGRAVITY]: { enabled: true, pipeline } } },
  });

  assert.deepEqual(parsed.systemTransforms?.providers[PROVIDER_ANTIGRAVITY]?.pipeline, pipeline);
});

test("a schema-parsed config is applied by the bridge end to end", () => {
  const parsed = updateSettingsSchema.parse({
    systemTransforms: {
      providers: {
        [PROVIDER_ANTIGRAVITY]: {
          enabled: true,
          pipeline: [
            {
              kind: "replace_text",
              match: "Hermes",
              replacement: "H3rm3s",
              allOccurrences: true,
              targets: ["messages"],
            },
          ],
        },
      },
    },
  });
  setSystemTransformsConfig(parsed.systemTransforms);

  const req = geminiRequest("You are Hermes Agent", "find Hermes source");
  applyAntigravitySystemTransforms(req);

  assert.equal(req.systemInstruction.parts[0].text, "You are Hermes Agent");
  assert.equal(req.contents[0].parts[0].text, "find H3rm3s source");
});

test("an explicitly empty targets list selects nothing (all op kinds)", () => {
  const pipeline = [
    { kind: "replace_text", match: "Hermes", replacement: "X", allOccurrences: true, targets: [] },
    { kind: "replace_regex", pattern: "Hermes", flags: "g", replacement: "X", targets: [] },
    { kind: "obfuscate_words", words: ["Hermes"], targets: [] },
  ];
  enableAntigravity(pipeline);

  const req = geminiRequest("You are Hermes Agent", "find Hermes source");
  const before = JSON.stringify(req);

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, []);
  assert.equal(result.targetedMessages, false);
  assert.equal(JSON.stringify(req), before);
});

test("schema-parsed empty targets still select nothing", () => {
  const parsed = updateSettingsSchema.parse({
    systemTransforms: {
      providers: {
        [PROVIDER_ANTIGRAVITY]: {
          enabled: true,
          pipeline: [
            {
              kind: "replace_text",
              match: "Hermes",
              replacement: "X",
              allOccurrences: true,
              targets: [],
            },
          ],
        },
      },
    },
  });
  setSystemTransformsConfig(parsed.systemTransforms);

  const req = geminiRequest("You are Hermes Agent", "find Hermes source");
  const before = JSON.stringify(req);

  applyAntigravitySystemTransforms(req);

  assert.equal(JSON.stringify(req), before);
});

test("non-string replacement fields are skipped instead of throwing", () => {
  const poison = { toString: null };
  enableAntigravity([
    { kind: "replace_text", match: "Hermes", replacement: poison, allOccurrences: true },
    { kind: "replace_text", match: "Hermes", replacement: poison },
    { kind: "replace_text", match: poison, replacement: "X" },
    { kind: "replace_regex", pattern: "Hermes", flags: "g", replacement: poison },
  ]);

  const req = geminiRequest("You are Hermes Agent");

  const result = applyAntigravitySystemTransforms(req);

  assert.deepEqual(result.appliedOpKinds, []);
  assert.equal(req.systemInstruction.parts[0].text, "You are Hermes Agent");
});

test("executor transformRequest applies the configured pipeline (live wiring)", async () => {
  enableAntigravity([
    { kind: "replace_text", match: "Hermes", replacement: "H3rm3s", allOccurrences: true },
  ]);
  const executor = new AntigravityExecutor();
  // Antigravity bodies arrive as the Cloud Code envelope; the executor transforms body.request.
  const body = {
    model: "gemini-3.8-flash-high",
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { role: "system", parts: [{ text: "You are Hermes Agent" }] },
    },
  };

  const result = await executor.transformRequest("gemini-3.8-flash-high", body, false, {
    projectId: "review",
  } as Parameters<AntigravityExecutor["transformRequest"]>[3]);

  assert.ok(!(result instanceof Response), "transformRequest must not error for a valid body");
  const envelope = result as unknown as {
    request: { systemInstruction: { parts: Array<{ text: string }> } };
  };
  assert.equal(envelope.request.systemInstruction.parts[0].text, "You are H3rm3s Agent");
});

test("executor retries derive the same text and never mutate the caller body", async () => {
  enableAntigravity([{ kind: "replace_text", match: "Hermes", replacement: "HermesX" }]);
  const executor = new AntigravityExecutor();
  const body = {
    model: "gemini-3.8-flash-high",
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { role: "system", parts: [{ text: "Hermes agent" }] },
    },
  };
  const credentials = { projectId: "review" } as Parameters<
    AntigravityExecutor["transformRequest"]
  >[3];

  const texts: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await executor.transformRequest(
      "gemini-3.8-flash-high",
      body,
      false,
      credentials
    );
    const envelope = result as unknown as {
      request: { systemInstruction: { parts: Array<{ text: string }> } };
    };
    texts.push(envelope.request.systemInstruction.parts[0].text);
  }

  assert.deepEqual(texts, ["HermesX agent", "HermesX agent", "HermesX agent"]);
  assert.equal(body.request.systemInstruction.parts[0].text, "Hermes agent");
});

test("executor survives a malformed operator config", async () => {
  enableAntigravity([
    {
      kind: "replace_text",
      match: "Hermes",
      replacement: { toString: null },
      allOccurrences: true,
    },
  ]);
  const executor = new AntigravityExecutor();
  const body = {
    model: "gemini-3.8-flash-high",
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { role: "system", parts: [{ text: "You are Hermes Agent" }] },
    },
  };

  const result = await executor.transformRequest("gemini-3.8-flash-high", body, false, {
    projectId: "review",
  } as Parameters<AntigravityExecutor["transformRequest"]>[3]);

  assert.ok(!(result instanceof Response), "malformed config must not become a request error");
  const envelope = result as unknown as {
    request: { systemInstruction: { parts: Array<{ text: string }> } };
  };
  assert.equal(envelope.request.systemInstruction.parts[0].text, "You are Hermes Agent");
});
