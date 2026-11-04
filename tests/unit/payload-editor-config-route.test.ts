import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "../../src/app/api/config/payload-editor/route.ts";
import { PAYLOAD_TREE_MAX_CHARS } from "../../src/shared/utils/payloadEditorMode.ts";

test("payload editor config route returns runtime env threshold and is not cached", async () => {
  const previous = process.env.PAYLOAD_TREE_MAX_CHARS;
  process.env.PAYLOAD_TREE_MAX_CHARS = "262144";
  try {
    const response = await GET();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(await response.json(), { maxTreeChars: 262144 });
  } finally {
    if (previous === undefined) delete process.env.PAYLOAD_TREE_MAX_CHARS;
    else process.env.PAYLOAD_TREE_MAX_CHARS = previous;
  }
});

test("payload editor config route falls back to the default for invalid env values", async () => {
  const previous = process.env.PAYLOAD_TREE_MAX_CHARS;
  process.env.PAYLOAD_TREE_MAX_CHARS = "invalid";
  try {
    const response = await GET();
    assert.deepEqual(await response.json(), { maxTreeChars: PAYLOAD_TREE_MAX_CHARS });
  } finally {
    if (previous === undefined) delete process.env.PAYLOAD_TREE_MAX_CHARS;
    else process.env.PAYLOAD_TREE_MAX_CHARS = previous;
  }
});
