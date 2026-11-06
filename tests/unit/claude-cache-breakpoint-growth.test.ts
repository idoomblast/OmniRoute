import test from "node:test";
import assert from "node:assert/strict";

import { ensureCacheControlOnLastUserMessage } from "../../open-sse/services/claudeCodeConstraints.ts";

type Block = Record<string, unknown>;
type Message = { role: string; content: Block[] };

function contentAt(messages: Message[], index: number): Block {
  return messages[index].content[0];
}

test("advances the breakpoint to a new last user turn after an earlier one is cached", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "one", cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
    ] as Message[],
  };
  ensureCacheControlOnLastUserMessage(body);
  assert.deepEqual(contentAt(body.messages, 2).cache_control, { type: "ephemeral" });
  assert.deepEqual(contentAt(body.messages, 0).cache_control, { type: "ephemeral" });
});

test("does not add a fifth breakpoint", () => {
  const marked = { type: "ephemeral" };
  const body = {
    system: [{ type: "text", text: "sys", cache_control: marked }],
    messages: [
      { role: "user", content: [{ type: "text", text: "a", cache_control: marked }] },
      { role: "assistant", content: [{ type: "text", text: "b", cache_control: marked }] },
      { role: "user", content: [{ type: "text", text: "c", cache_control: marked }] },
      { role: "assistant", content: [{ type: "text", text: "d" }] },
      { role: "user", content: [{ type: "text", text: "e" }] },
    ] as Message[],
  };
  ensureCacheControlOnLastUserMessage(body);
  assert.equal("cache_control" in contentAt(body.messages, 4), false);
});

test("matches an existing 5m TTL instead of introducing a 1h breakpoint", () => {
  const body = {
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "5m" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "c" }] },
    ] as Message[],
  };
  ensureCacheControlOnLastUserMessage(body);
  assert.deepEqual(contentAt(body.messages, 2).cache_control, {
    type: "ephemeral",
    ttl: "5m",
  });
});
