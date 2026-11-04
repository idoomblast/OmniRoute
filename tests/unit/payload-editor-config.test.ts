import test from "node:test";
import assert from "node:assert/strict";

import {
  loadPayloadTreeMaxChars,
  resetPayloadTreeMaxCharsCache,
} from "../../src/shared/utils/payloadEditorConfig.ts";
import { PAYLOAD_TREE_MAX_CHARS } from "../../src/shared/utils/payloadEditorMode.ts";

const originalFetch = globalThis.fetch;

function restoreFetch() {
  globalThis.fetch = originalFetch;
  resetPayloadTreeMaxCharsCache();
}

test("loadPayloadTreeMaxChars uses the runtime endpoint value and deduplicates concurrent loads", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ maxTreeChars: 5000 }), { status: 200 });
  }) as typeof fetch;
  resetPayloadTreeMaxCharsCache();
  try {
    const [first, second] = await Promise.all([
      loadPayloadTreeMaxChars(),
      loadPayloadTreeMaxChars(),
    ]);
    assert.equal(first, 5000);
    assert.equal(second, 5000);
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

test("loadPayloadTreeMaxChars falls back to the default for invalid endpoint payloads", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ maxTreeChars: "not-a-number" }), {
      status: 200,
    })) as typeof fetch;
  resetPayloadTreeMaxCharsCache();
  try {
    assert.equal(await loadPayloadTreeMaxChars(), PAYLOAD_TREE_MAX_CHARS);
  } finally {
    restoreFetch();
  }
});

test("loadPayloadTreeMaxChars falls back to the default when fetch is unavailable", async () => {
  // Deliberately simulate an environment without fetch.
  globalThis.fetch = undefined;
  resetPayloadTreeMaxCharsCache();
  try {
    assert.equal(await loadPayloadTreeMaxChars(), PAYLOAD_TREE_MAX_CHARS);
  } finally {
    restoreFetch();
  }
});
