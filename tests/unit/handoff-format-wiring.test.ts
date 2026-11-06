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

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

test("the combo safety-net redirect passes the in-scope sourceFormat", () => {
  const chat = read("src", "sse", "handlers", "chat.ts");
  // Shorthand property inside the redirect's handleComboChat({...}) call.
  assert.match(chat, /\n\s+sourceFormat,\n/);
  assert.ok(!/sourceFormat:\s*\(resolved as any\)\.sourceFormat/.test(chat));
});

test("nested combo dispatches rebuild options with sourceFormat", () => {
  const combo = read("open-sse", "services", "combo.ts");
  const prelude = read("open-sse", "services", "combo", "dispatchPrelude.ts");
  assert.ok(prelude.includes('sourceFormat?: HandleComboChatOptions["sourceFormat"];'));
  assert.ok(prelude.includes("sourceFormat: a.sourceFormat,"));
  const forwarded = combo.match(/sourceFormat,\n\s+signal,/g) ?? [];
  assert.equal(forwarded.length, 2, "fusion and runtime-unit dispatches must forward sourceFormat");
});
