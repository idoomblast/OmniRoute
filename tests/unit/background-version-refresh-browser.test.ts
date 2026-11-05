/**
 * Background client-version refreshes must never start from a browser bundle.
 *
 * The provider registry is bundled into the dashboard, so the sync version getter
 * below runs in the browser too. Its guard checked `typeof process === "undefined"`,
 * but Next.js gives browser code a `process` object, so every full page load fired
 * anonymous lookups against the npm registry, and surfaced as errors in the
 * dashboard console once the budget ran out.
 *
 * The getter is checked twice: with a browser `window` present no fetch may start,
 * and without one the same getter must still start its refresh (so the browser case
 * is not passing just because the refresh is skipped for another reason).
 */
import test from "node:test";
import assert from "node:assert/strict";

// Installed before any import: some modules capture `fetch` at load time.
const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  fetchCalls.push(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  );
  return new Response("{}", { status: 503 });
}) as typeof fetch;

const claude = await import("../../src/shared/constants/claudeCodeClient.ts");

type Getter = {
  name: string;
  host: RegExp;
  call: () => unknown;
  reset: () => void;
};

const GETTERS: Getter[] = [
  {
    name: "Claude Code (npm)",
    host: /registry\.npmjs\.org\/@anthropic-ai\/claude-code/,
    call: () => claude.getClaudeCodeClientVersion(),
    reset: () => claude.resetClaudeCodeClientVersionCache(),
  },
];

// The getters skip their refresh under a test runner; clear those markers for the
// duration of each check so the production path is the one exercised.
const RUNNER_ENV = ["NODE_TEST_CONTEXT", "VITEST", "NODE_ENV"] as const;

async function outsideTestRunner<T>(fn: () => Promise<T>): Promise<T> {
  const saved = RUNNER_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of RUNNER_ENV) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withBrowserWindow<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { window?: unknown };
  g.window = {};
  try {
    return await fn();
  } finally {
    delete g.window;
  }
}

/** Runs the getter and lets any started refresh reach its fetch and settle. */
async function fetchesStartedBy(getter: Getter): Promise<number> {
  const before = fetchCalls.filter((url) => getter.host.test(url)).length;
  getter.call();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return fetchCalls.filter((url) => getter.host.test(url)).length - before;
}

test.after(() => {
  globalThis.fetch = realFetch;
});

for (const getter of GETTERS) {
  test(`${getter.name}: no background lookup from a browser bundle`, async () => {
    getter.reset();
    const fromBrowser = await outsideTestRunner(() =>
      withBrowserWindow(() => fetchesStartedBy(getter))
    );
    assert.equal(fromBrowser, 0, `${getter.name} fetched from a browser runtime`);

    // Control: the same getter on the server still starts its refresh.
    getter.reset();
    const fromServer = await outsideTestRunner(() => fetchesStartedBy(getter));
    assert.ok(fromServer >= 1, `${getter.name} did not refresh on the server either`);
    getter.reset();
  });
}
