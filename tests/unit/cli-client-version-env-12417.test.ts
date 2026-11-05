/**
 * Regression for #12417 — Anthropic gates models (Fable 5.1) on the advertised
 * Claude Code client version. A CLAUDE_USER_AGENT override is not enough: billing
 * (`cc_version=`), stainless headers, and the four identity aliases all read
 * the captured pin.
 *
 * Env override is a safe token. Garbage is ignored.
 */
import test from "node:test";
import assert from "node:assert/strict";

const canonical = await import("../../src/shared/constants/claudeCodeClient.ts");
const claudeHeaders = await import("../../open-sse/config/providers/shared.ts");

async function withEnv<T>(
  entries: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("#12417 Claude pin stays the captured 2.1.280 binary", () => {
  assert.equal(canonical.CLAUDE_CODE_CLIENT_VERSION, "2.1.280");
});

test("#12417 getClaudeCodeClientVersion falls back to the captured pin", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: undefined }, () => {
    assert.equal(canonical.getClaudeCodeClientVersion(), canonical.CLAUDE_CODE_CLIENT_VERSION);
  });
});

test("#12417 getClaudeCodeClientVersion honors a safe env override", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: "2.1.281" }, () => {
    assert.equal(canonical.getClaudeCodeClientVersion(), "2.1.281");
    assert.equal(canonical.getClaudeCodeUserAgent("cli"), "claude-cli/2.1.281 (external, cli)");
    assert.equal(
      canonical.getClaudeCodeUserAgent("sdk-cli"),
      "claude-cli/2.1.281 (external, sdk-cli)"
    );
    assert.equal(
      canonical.getClaudeCodeClientBillingVersion(),
      `2.1.281.${canonical.CLAUDE_CODE_CLIENT_BUILD_REVISION}`
    );
  });
});

test("#12417 getClaudeCodeClientVersion ignores an unsafe env override", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: "bad version value" }, () => {
    assert.equal(canonical.getClaudeCodeClientVersion(), canonical.CLAUDE_CODE_CLIENT_VERSION);
  });
});

test("#12417 getClaudeCliHeaders reads the env at call time", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: "2.1.281" }, () => {
    assert.equal(
      claudeHeaders.getClaudeCliHeaders()["User-Agent"],
      "claude-cli/2.1.281 (external, cli)"
    );
  });
});

test("#12417 Claude billing pin stays captured while getter follows env", async () => {
  const hdr = await import("../../open-sse/config/anthropicHeaders.ts");
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: "2.1.281" }, () => {
    assert.equal(hdr.CLAUDE_CLI_BILLING_VERSION, canonical.CLAUDE_CODE_CLIENT_BILLING_VERSION);
    assert.equal(
      hdr.getClaudeCliBillingVersion(),
      `2.1.281.${canonical.CLAUDE_CODE_CLIENT_BUILD_REVISION}`
    );
  });
});
