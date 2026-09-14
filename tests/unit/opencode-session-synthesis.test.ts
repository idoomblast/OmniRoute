import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const { OpencodeExecutor } = await import("../../open-sse/executors/opencode.ts");
const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.ts");

/**
 * Console Go (opencode.ai/zen/go) 400s when the upstream request lacks
 * x-opencode-session ("Request is missing x-opencode-session and cannot be
 * routed efficiently"). The real OpenCode CLI sends a stable per-conversation
 * session id; OmniRoute must synthesize one when the client did not supply
 * any session identity, using the same stability semantics (stable within a
 * conversation, unique across conversations).
 */

function createMockResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createInput(model: string, overrides: Record<string, unknown> = {}) {
  return {
    model,
    stream: true,
    credentials: { apiKey: "test-key" },
    body: {
      model,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
    ...overrides,
  };
}

describe("OpencodeExecutor – x-opencode-session synthesis (Console Go 400)", () => {
  let executor: InstanceType<typeof OpencodeExecutor>;
  let fetchCalls: Array<{ url: string; options: { headers: Record<string, string> } }>;
  let originalFetch: typeof globalThis.fetch;
  let originalModels: unknown[];

  beforeEach(() => {
    executor = new OpencodeExecutor("opencode-go");
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    originalModels = [...(PROVIDER_MODELS["opencode-go"] || [])];
    const registry = (PROVIDER_MODELS["opencode-go"] ??= []);
    if (!registry.some((m) => m.id === "deepseek-v4.1-flash")) {
      registry.push({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" });
    }
    globalThis.fetch = (async (url: unknown, options?: { headers?: Record<string, string> }) => {
      fetchCalls.push({ url: String(url), options: { headers: options?.headers ?? {} } });
      return createMockResponse();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    PROVIDER_MODELS["opencode-go"] = originalModels as never;
  });

  it("injects x-opencode-session when client sends no session headers", async () => {
    await executor.execute(createInput("deepseek-v4.1-flash"));
    const headers = fetchCalls[0].options.headers;
    assert.ok(
      headers["x-opencode-session"],
      "x-opencode-session must be present on the upstream request"
    );
    assert.ok(headers["x-opencode-session"].length >= 16, "session id must be a non-trivial id");
  });

  it("is stable across identical conversations (same body → same session id)", async () => {
    await executor.execute(createInput("deepseek-v4.1-flash"));
    await executor.execute(createInput("deepseek-v4.1-flash"));
    const first = fetchCalls[0].options.headers["x-opencode-session"];
    const second = fetchCalls[1].options.headers["x-opencode-session"];
    assert.equal(first, second, "identical conversation signatures must reuse the session id");
  });

  it("varies across distinct conversations (different first user message)", async () => {
    await executor.execute(createInput("deepseek-v4.1-flash"));
    await executor.execute(
      createInput("deepseek-v4.1-flash", {
        body: {
          model: "deepseek-v4.1-flash",
          stream: true,
          messages: [{ role: "user", content: "a completely different prompt" }],
        },
      })
    );
    const first = fetchCalls[0].options.headers["x-opencode-session"];
    const second = fetchCalls[1].options.headers["x-opencode-session"];
    assert.notEqual(first, second);
  });

  it("keeps a client-supplied x-opencode-session (client value wins)", async () => {
    await executor.execute(
      createInput("deepseek-v4.1-flash", {
        clientHeaders: { "x-opencode-session": "client-session-abc" },
      })
    );
    assert.equal(fetchCalls[0].options.headers["x-opencode-session"], "client-session-abc");
  });

  it("maps client x-session-id to x-opencode-session", async () => {
    await executor.execute(
      createInput("deepseek-v4.1-flash", {
        clientHeaders: { "x-session-id": "sid-123" },
      })
    );
    assert.equal(fetchCalls[0].options.headers["x-opencode-session"], "sid-123");
  });

  it("maps client x-omniroute-session-id to x-opencode-session", async () => {
    await executor.execute(
      createInput("deepseek-v4.1-flash", {
        clientHeaders: { "x-omniroute-session-id": "omni-sid-9" },
      })
    );
    assert.equal(fetchCalls[0].options.headers["x-opencode-session"], "omni-sid-9");
  });

  it("does not mutate the caller's clientHeaders object (read-only contract)", async () => {
    const clientHeaders = { "x-opencode-client": "tui" };
    await executor.execute(createInput("deepseek-v4.1-flash", { clientHeaders }));
    assert.deepEqual(clientHeaders, { "x-opencode-client": "tui" });
    // and the synthesized session still reached upstream
    assert.ok(fetchCalls[0].options.headers["x-opencode-session"]);
  });
});
