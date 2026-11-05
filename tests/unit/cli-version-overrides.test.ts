/**
 * CLI client-version override store: normalization, precedence, hydration.
 * Claude-only port of the #14817 tests; Codex support is intentionally not
 * included in this P0 backport.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLI_VERSION_KEYS,
  CLI_VERSION_PATTERN,
  getCliVersionOverride,
  getCliVersionOverrides,
  hydrateCliVersionOverrides,
  normalizeCliVersion,
  normalizeCliVersionOverrides,
  setCliVersionOverrides,
} from "../../open-sse/config/cliVersions.ts";

// Every `await import` MUST precede the first test(): node:test only registers
// tests declared before the first top-level await in the module.
const claude = await import("../../src/shared/constants/claudeCodeClient.ts");

async function withEnv<T>(
  entries: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The store is process-global; clear it around every case. */
function resetOverrides() {
  setCliVersionOverrides({});
}

test("normalizeCliVersion accepts the version tokens a real CLI sends", () => {
  resetOverrides();
  for (const value of ["2.1.259", "0.155.0", "1.0.81-6", "2026.07.08-0c04a8a", "a", "0.33.2"]) {
    assert.equal(normalizeCliVersion(value), value, `should accept ${value}`);
  }
  // Exactly 32 characters is still inside the bound.
  assert.equal(normalizeCliVersion("a".repeat(32)), "a".repeat(32));
  assert.ok(CLI_VERSION_PATTERN.test("a".repeat(32)));
  assert.ok(!CLI_VERSION_PATTERN.test("a".repeat(33)));
});

test("normalizeCliVersion trims accidental whitespace but drops unsafe tokens", () => {
  resetOverrides();
  assert.equal(normalizeCliVersion("   2.1.259   "), "2.1.259");
  for (const value of [
    "",
    "   ",
    "-2.1.259",
    ".2.1.259",
    "bad version value",
    "2.1.259;drop",
    "2.1.259\nX-Injected: 1",
    "a".repeat(33),
    null,
    undefined,
    42,
    {},
    [],
    true,
  ]) {
    assert.equal(normalizeCliVersion(value), null, `should reject ${String(value)}`);
  }
});

test("normalizeCliVersionOverrides keeps only well-formed Claude values", () => {
  resetOverrides();
  const normalized = normalizeCliVersionOverrides({
    claude: "2.1.260",
    codex: "0.156.0",
    copilot: "1.0.82",
    ["__proto__"]: "1.0.0",
  });
  assert.deepEqual(normalized, { claude: "2.1.260" });
});

test("normalizeCliVersionOverrides ignores input that is not a plain record", () => {
  resetOverrides();
  for (const value of [null, undefined, "nope", 42, ["claude"], true]) {
    assert.deepEqual(normalizeCliVersionOverrides(value), {}, `should ignore ${String(value)}`);
  }
});

test("setCliVersionOverrides drops malformed values instead of coercing them", () => {
  resetOverrides();
  const applied = setCliVersionOverrides({ claude: "2.1.260", codex: "0.156.0" });
  assert.deepEqual(applied, { claude: "2.1.260" });
  assert.deepEqual(getCliVersionOverrides(), { claude: "2.1.260" });
  assert.equal(getCliVersionOverride("claude"), "2.1.260");
  assert.equal(getCliVersionOverride("codex" as never), null);
});

test("setCliVersionOverrides replaces the whole map and ignores unknown keys", () => {
  resetOverrides();
  setCliVersionOverrides({ claude: "2.1.260" });
  setCliVersionOverrides({ claude: "2.1.261", grok: "1.0.0" });
  assert.deepEqual(getCliVersionOverrides(), { claude: "2.1.261" });
  assert.deepEqual([...CLI_VERSION_KEYS], ["claude"]);
});

test("hydrateCliVersionOverrides reads the settings record", () => {
  resetOverrides();
  assert.equal(hydrateCliVersionOverrides({ cliVersionOverrides: { claude: "2.1.260" } }), true);
  assert.equal(claude.getClaudeCodeClientVersion(), "2.1.260");
  assert.equal(claude.getClaudeCodeClientVersionSource(), "settings");
  assert.equal(hydrateCliVersionOverrides({}), false);
  assert.deepEqual(getCliVersionOverrides(), {});
});

test("Claude precedence: falls to the captured pin when nothing is set", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: undefined }, () => {
    resetOverrides();
    assert.equal(claude.getClaudeCodeClientVersion(), claude.CLAUDE_CODE_CLIENT_VERSION);
    assert.equal(claude.getClaudeCodeClientVersionSource(), "default");
  });
});

test("Claude precedence: env wins over the pin when no override is set", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: "2.1.259" }, () => {
    resetOverrides();
    assert.equal(claude.getClaudeCodeClientVersion(), "2.1.259");
    assert.equal(claude.getClaudeCodeClientVersionSource(), "env");
  });
});

test("Claude precedence: the dashboard override outranks a set env var", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: "2.1.259" }, () => {
    setCliVersionOverrides({ claude: "2.1.261" });
    assert.equal(claude.getClaudeCodeClientVersion(), "2.1.261");
    assert.equal(claude.getClaudeCodeClientVersionSource(), "settings");
    resetOverrides();
  });
});

test("Claude override moves the UA but NOT the pinned billing build revision", async () => {
  await withEnv({ CLAUDE_CODE_CLIENT_VERSION: undefined }, () => {
    setCliVersionOverrides({ claude: "2.1.260" });
    assert.equal(claude.getClaudeCodeUserAgent("cli"), "claude-cli/2.1.260 (external, cli)");
    assert.equal(claude.CLAUDE_CODE_CLIENT_BUILD_REVISION, "1e2");
    assert.equal(
      claude.getClaudeCodeClientBillingVersion(),
      "2.1.260." + claude.CLAUDE_CODE_CLIENT_BUILD_REVISION
    );
    resetOverrides();
  });
});
