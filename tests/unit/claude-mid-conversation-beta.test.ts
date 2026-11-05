import test from "node:test";
import assert from "node:assert/strict";

import {
  selectBetaFlags,
  shouldUseMidConversationSystem,
} from "../../open-sse/executors/claudeIdentity.ts";

const body = {
  system: [{ type: "text", text: "system" }],
  tools: [{ name: "Bash" }],
  messages: [{ role: "system", content: [{ type: "text", text: "mid" }] }],
};

test("mid-conversation system is enabled for Opus with system and tools", () => {
  assert.equal(shouldUseMidConversationSystem(body, "claude-opus-5"), true);
  assert.equal(selectBetaFlags(body, "claude-opus-5").includes("mid-conversation-system-2026-04-07"), true);
});

test("mid-conversation system stays off without tools or for legacy models", () => {
  assert.equal(shouldUseMidConversationSystem({ system: body.system }, "claude-opus-5"), false);
  assert.equal(shouldUseMidConversationSystem(body, "claude-sonnet-4"), false);
  assert.equal(
    selectBetaFlags(body, "claude-sonnet-4").includes("mid-conversation-system-2026-04-07"),
    false
  );
});
