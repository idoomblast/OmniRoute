/**
 * The CLI version override must reach the wire on the interactive
 * `/v1/messages` path, not only on bootstrap/usage calls.
 *
 * Regression for the P0 gate finding B1: `base.ts` built the billing header and
 * the User-Agent from import-time constants (`CLAUDE_CLI_BILLING_VERSION`,
 * `CLAUDE_CODE_VERSION`), so an operator override changed health-check traffic
 * but not the requests Anthropic actually gates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";

const ENV_VERSION = "CLAUDE_CODE_CLIENT_VERSION";
const ENV_REVISION = "CLAUDE_CODE_CLIENT_BUILD_REVISION";

async function captureClaudeWireRequest(): Promise<{
  headers: Record<string, string>;
  body: { system?: Array<{ text?: string }> };
}> {
  const executor = new DefaultExecutor("claude");
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";

  globalThis.fetch = async (_url, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await executor.execute({
      model: "claude-sonnet-4-6",
      body: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      },
      stream: false,
      credentials: { accessToken: "oauth-token" },
      clientHeaders: { "x-app": "cli" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  return { headers: capturedHeaders, body: JSON.parse(capturedBody) };
}

async function withEnv<T>(
  entries: Record<string, string | undefined>,
  fn: () => Promise<T>
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

test("the CLI version override reaches the User-Agent on /v1/messages", async () => {
  await withEnv({ [ENV_VERSION]: "2.1.299", [ENV_REVISION]: "abc" }, async () => {
    const { headers } = await captureClaudeWireRequest();
    assert.equal(headers["User-Agent"], "claude-cli/2.1.299 (external, cli)");
  });
});

test("the build-revision override reaches the cc_version billing header", async () => {
  await withEnv({ [ENV_VERSION]: "2.1.299", [ENV_REVISION]: "abc" }, async () => {
    const { body } = await captureClaudeWireRequest();
    assert.match(
      body.system?.[0]?.text ?? "",
      /^x-anthropic-billing-header: cc_version=2\.1\.299\.abc; cc_entrypoint=cli; cch=[0-9a-f]{5};$/
    );
  });
});

test("without an override the captured pin stays on the wire", async () => {
  await withEnv({ [ENV_VERSION]: undefined, [ENV_REVISION]: undefined }, async () => {
    const { headers, body } = await captureClaudeWireRequest();
    assert.equal(headers["User-Agent"], "claude-cli/2.1.280 (external, cli)");
    assert.match(body.system?.[0]?.text ?? "", /cc_version=2\.1\.280\.1e2;/);
  });
});
