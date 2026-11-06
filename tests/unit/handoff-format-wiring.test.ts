/**
 * handoff-format-wiring.test.ts — the universal handoff must receive an
 * authoritative request format on every combo dispatch path. A body-shape
 * heuristic used to guess it and misread OpenAI bodies carrying max_tokens as
 * Claude; these guards keep the provenance wiring from silently regressing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { resolveInboundSourceFormat } = await import("../../open-sse/services/provider.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

test("resolveInboundSourceFormat prefers the route over an ambiguous body", () => {
  // An OpenAI body carrying max_tokens must not be read as Claude just because
  // Claude also understands max_tokens.
  const ambiguousBody = { model: "claude-opus-4-6", max_tokens: 1024, messages: [] };
  assert.equal(resolveInboundSourceFormat(ambiguousBody, "/v1/messages", null), "claude");
  assert.equal(resolveInboundSourceFormat(ambiguousBody, "/v1/chat/completions", null), "openai");
  assert.equal(
    resolveInboundSourceFormat(ambiguousBody, null, "https://host/v1/messages"),
    "claude"
  );
  assert.equal(
    resolveInboundSourceFormat(ambiguousBody, null, "https://host/v1/chat/completions"),
    "openai"
  );
});

test("the combo safety-net redirect derives its format before dispatch", () => {
  const chat = read("src", "sse", "handlers", "chat.ts");
  const start = chat.indexOf("if ((resolved as any).combo) {");
  assert.ok(start >= 0, "safety-net redirect branch not found");
  const end = chat.indexOf("const {\n    provider: resolvedProvider", start);
  assert.ok(end > start, "redirect branch terminator not found");
  const branch = chat.slice(start, end);

  // The branch must derive the format itself: referencing the later
  // destructured binding is a temporal-dead-zone ReferenceError.
  assert.match(branch, /const redirectSourceFormat = resolveInboundSourceFormat\(/);
  assert.match(branch, /sourceFormat: redirectSourceFormat,/);
  assert.ok(!/\n\s+sourceFormat,\n/.test(branch), "redirect must not use a TDZ-shadowed binding");
  assert.ok(!/sourceFormat:\s*\(resolved as any\)\.sourceFormat/.test(branch));
});
