import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCacheControlTtl } from "../../open-sse/services/claudeCodeConstraints.ts";

test("defaults a missing cache_control.ttl to 1h across tools, system, and messages", () => {
  const body = {
    tools: [{ name: "Bash", cache_control: { type: "ephemeral" } }],
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  normalizeCacheControlTtl(body);
  assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("never overrides an explicit 5m or 1h TTL", () => {
  const body = {
    system: [
      { type: "text", text: "five", cache_control: { type: "ephemeral", ttl: "5m" } },
      { type: "text", text: "one", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  };
  normalizeCacheControlTtl(body);
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
  assert.deepEqual(body.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("leaves non-ephemeral cache_control values alone", () => {
  const body = {
    system: [{ type: "text", text: "sys", cache_control: { type: "persistent" } }],
  };
  normalizeCacheControlTtl(body);
  assert.deepEqual(body.system[0].cache_control, { type: "persistent" });
});

test("defaults to 1h before the first 5m breakpoint and to 5m after it", () => {
  const body = {
    tools: [{ name: "Bash", cache_control: { type: "ephemeral" } }],
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "5m" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  normalizeCacheControlTtl(body);
  assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
  assert.deepEqual(body.messages[0].content[0].cache_control, {
    type: "ephemeral",
    ttl: "5m",
  });
});
