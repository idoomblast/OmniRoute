import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CODEBUDDY_INTL_CONFIG,
  PROVIDERS as OAUTH_IDS,
} from "../../src/lib/oauth/constants/oauth.ts";
import { codebuddyIntl } from "../../src/lib/oauth/providers/codebuddy-intl.ts";
import OAUTH_PROVIDERS from "../../src/lib/oauth/providers/index.ts";
import { pollForToken } from "../../src/lib/oauth/providers.ts";
import { refreshCodebuddyIntlToken } from "../../open-sse/services/tokenRefresh/providers/codebuddyIntl.ts";
import { getAccessToken, supportsTokenRefresh } from "../../open-sse/services/tokenRefresh.ts";
import { REGISTRY, generateModels } from "../../open-sse/config/providerRegistry.ts";
import { PROVIDER_ID_TO_ALIAS } from "../../open-sse/config/providerModels.ts";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.ts";
import { parseUpstreamError } from "../../open-sse/utils/error.ts";
import { getCodeBuddyIntlUsage } from "../../open-sse/services/usage/codebuddy-intl.ts";
import { getUsageForProvider, USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage.ts";
import { isSupportedUsageConnection } from "../../src/lib/usage/providerLimits.ts";
import {
  OAUTH_PROVIDERS as DASHBOARD_OAUTH_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
  resolveProviderId,
  supportsApiKeyOnFreeProvider,
} from "../../src/shared/constants/providers.ts";
import { connectionMatchesProviderCard } from "../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts";

const originalFetch = globalThis.fetch;
const config = CODEBUDDY_INTL_CONFIG;
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const modelIds = [
  "default-model",
  "fast-model",
  "balanced-model",
  "primary-model",
  "deep-model",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-sg",
  "gpt-6-astra",
  "hy4-preview",
  "hy3",
  "kimi-k2.8-preview",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gemini-3.5-flash",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "kimi-k3",
  "kimi-k2.6",
];
// Verified 2026-10-07 against CodeBuddy CLI v2.161.4 (shipped product.json +
// authenticated GET /v3/config both report this exact 22-model International
// catalog; contextLength mirrors upstream maxInputTokens).
const expectedModels = [
  {
    id: "default-model",
    name: "Auto",
    contextLength: 176000,
    maxOutputTokens: 24000,
    supportsVision: true,
  },
  {
    id: "fast-model",
    name: "Fast",
    contextLength: 200000,
    maxOutputTokens: 32000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "balanced-model",
    name: "Balanced",
    contextLength: 256000,
    maxOutputTokens: 32000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "primary-model",
    name: "Primary",
    contextLength: 272000,
    maxOutputTokens: 72000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "deep-model",
    name: "Deep",
    contextLength: 176000,
    maxOutputTokens: 24000,
    supportsVision: true,
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek-V4.1-Flash",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "deepseek-v4.1-flash-sg",
    name: "DeepSeek-V4.1-Flash (SG)",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6-Astra",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "hy4-preview",
    name: "Hy4 Preview",
    contextLength: 1000000,
    maxOutputTokens: 64000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "hy3",
    name: "Hy3",
    contextLength: 192000,
    maxOutputTokens: 64000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "kimi-k2.8-preview",
    name: "Kimi-K2.8-Preview",
    contextLength: 1000000,
    maxOutputTokens: 32000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextLength: 1000000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextLength: 272000,
    maxOutputTokens: 72000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini-3.5-Flash",
    contextLength: 1000000,
    maxOutputTokens: 65536,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    contextLength: 1000000,
    maxOutputTokens: 32000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    contextLength: 1000000,
    maxOutputTokens: 48000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    contextLength: 1000000,
    maxOutputTokens: 48000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "kimi-k3",
    name: "Kimi-K3",
    contextLength: 1000000,
    maxOutputTokens: 32000,
    supportsReasoning: true,
    supportsVision: true,
  },
  {
    id: "kimi-k2.6",
    name: "Kimi-K2.6",
    contextLength: 256000,
    maxOutputTokens: 32000,
    supportsReasoning: true,
    supportsVision: true,
  },
];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("International registry exposes the .ai gateway, cbai alias, and the verified 22-model live catalog", () => {
  const provider = REGISTRY["codebuddy-intl"];
  assert.equal(provider.id, "codebuddy-intl");
  assert.equal(provider.alias, "cbai");
  assert.equal(provider.executor, "codebuddy-intl");
  assert.equal(provider.format, "openai");
  assert.equal(provider.authType, "oauth");
  assert.equal(provider.authHeader, "bearer");
  assert.equal(provider.forceStream, true);
  assert.equal(provider.baseUrl, "https://www.codebuddy.ai/v2/chat/completions");
  assert.deepEqual(provider.headers, {
    "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
    "X-Product": "SaaS",
    "X-IDE-Type": "IDE",
    "X-IDE-Name": "IDE",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
  });
  assert.equal(PROVIDER_ID_TO_ALIAS["codebuddy-intl"], "cbai");
  assert.deepEqual(
    generateModels().cbai.map((model) => model.id),
    modelIds
  );
  // Pins the full verified catalog (ids, names, context/output limits, and
  // capability flags) so drift from the live International lineup fails loudly.
  assert.deepEqual(provider.models, expectedModels);
});

test("International OAuth config and device-flow registrations use the .ai IDE endpoints", () => {
  assert.deepEqual(config, {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  });
  assert.equal(OAUTH_IDS.CODEBUDDY_INTL, "codebuddy-intl");
  assert.equal(OAUTH_PROVIDERS["codebuddy-intl"], codebuddyIntl);
  assert.equal(codebuddyIntl.flowType, "device_code");
  assert.equal(supportsTokenRefresh("codebuddy-intl"), true);
  assert.match(
    read("src/app/api/oauth/[provider]/[action]/route.ts"),
    /NO_PKCE_DEVICE_CODE_PROVIDERS = new Set\(\[[\s\S]*?"codebuddy-intl"[\s\S]*?\]\)/
  );
  assert.match(
    read("src/app/api/providers/[id]/test/oauthTestConfig.ts"),
    /"codebuddy-intl": \{[^}]*checkExpiry: true,[^}]*refreshable: true/
  );
});

test("International dashboard uses device login and counts OAuth and API-key connections on one card", () => {
  const provider = DASHBOARD_OAUTH_PROVIDERS["codebuddy-intl"];
  assert.deepEqual(provider, {
    id: "codebuddy-intl",
    alias: "cbai",
    name: "CodeBuddy International",
    icon: "smart_toy",
    color: "#006EFF",
    textIcon: "CB",
    website: "https://www.codebuddy.ai",
    subscriptionRisk: true,
    riskNoticeVariant: "oauth",
    authHint:
      "CodeBuddy International (www.codebuddy.ai). Sign in via the official IDE device-code flow, or paste a direct API key (sent as Authorization: Bearer). Catalog: GLM / Kimi / GPT / Gemini / DeepSeek / Hunyuan.",
  });
  assert.equal(resolveProviderId("cbai"), "codebuddy-intl");
  assert.equal(supportsApiKeyOnFreeProvider("codebuddy-intl"), true);
  for (const authType of ["oauth", "apikey", "api_key"]) {
    assert.equal(
      connectionMatchesProviderCard(
        { provider: "codebuddy-intl", authType },
        "codebuddy-intl",
        "oauth"
      ),
      true
    );
  }
  assert.equal(
    connectionMatchesProviderCard(
      { provider: "codebuddy-cn", authType: "oauth" },
      "codebuddy-intl",
      "oauth"
    ),
    false
  );
  assert.match(
    read("src/shared/components/OAuthModal.tsx"),
    /DEVICE_CODE_PROVIDERS = new Set\(\[[\s\S]*?"codebuddy-intl"/
  );
  assert.match(read("src/shared/components/lobeProviderIcons.ts"), /"codebuddy-intl": "Tencent"/);
});

test("International device state request returns the browser authUrl and CN-compatible shape", async () => {
  const state = "test-state";
  const authUrl = `https://www.codebuddy.ai/login?platform=ide&state=${state}`;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${config.stateUrl}?platform=ide`);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Domain"), "www.codebuddy.ai");
    assert.equal(headers.get("User-Agent"), config.userAgent);
    assert.equal(headers.get("X-No-Authorization"), "true");
    return jsonResponse({ code: 0, data: { state, authUrl } });
  };
  assert.deepEqual(await codebuddyIntl.requestDeviceCode(config), {
    device_code: state,
    user_code: state,
    verification_uri: authUrl,
    verification_uri_complete: authUrl,
    expires_in: 600,
    interval: 5,
  });
});

test("International poll preserves 11217 pending semantics and the helper marks it pending", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${config.tokenUrl}?state=state%20%26%20value`);
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Domain"), "www.codebuddy.ai");
    assert.equal(headers.get("X-No-Enterprise-Id"), "true");
    return jsonResponse({ code: 11217, msg: "11217:login ing..." });
  };
  assert.deepEqual(await codebuddyIntl.pollToken(config, "state & value"), {
    ok: false,
    data: { code: 11217, msg: "11217:login ing..." },
  });
  assert.deepEqual(await pollForToken("codebuddy-intl", "state & value", null, null), {
    success: false,
    error: "authorization_pending",
    pending: true,
  });
});

test("International poll success maps rotated tokens with the CN lifecycle defaults", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      code: 0,
      data: { accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 7200 },
    });
  const result = await codebuddyIntl.pollToken(config, "state");
  assert.deepEqual(result, {
    ok: true,
    data: {
      access_token: "test-access",
      refresh_token: "test-refresh",
      token_type: "Bearer",
      expires_in: 7200,
    },
  });
  assert.deepEqual(await pollForToken("codebuddy-intl", "state", null, null), {
    success: true,
    tokens: {
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresIn: 7200,
      providerSpecificData: {},
    },
  });
  assert.equal(
    codebuddyIntl.mapTokens({ access_token: "test", refresh_token: "", token_type: "Bearer" })
      .expiresIn,
    86400
  );
});

test("International device state failures are descriptive, sanitized, and reject missing authUrl", async () => {
  globalThis.fetch = async () => jsonResponse({}, 403);
  await assert.rejects(codebuddyIntl.requestDeviceCode(config), /state request failed \(403\)/);
  globalThis.fetch = async () => jsonResponse({ code: 0, data: { state: "state" } });
  await assert.rejects(codebuddyIntl.requestDeviceCode(config), /missing state\/authUrl/);
  globalThis.fetch = async () =>
    jsonResponse({ code: 1, msg: "denied /home/operator/private/file.ts" });
  await assert.rejects(codebuddyIntl.requestDeviceCode(config), (error: Error) => {
    assert.ok(!error.message.includes("/home/operator/private/file.ts"));
    return true;
  });
});

test("International refresh uses the .ai plugin headers and rotates or retains the refresh token", async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, config.refreshUrl);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Domain"), "www.codebuddy.ai");
    assert.equal(headers.get("X-Refresh-Token"), "test-refresh");
    assert.equal(headers.get("X-Auth-Refresh-Source"), "plugin");
    return jsonResponse({
      code: 0,
      data: {
        accessToken: "test-access",
        refreshToken: calls++ === 0 ? "rotated" : "",
        expiresIn: 3600,
      },
    });
  };
  assert.deepEqual(await refreshCodebuddyIntlToken("test-refresh"), {
    accessToken: "test-access",
    refreshToken: "rotated",
    expiresIn: 3600,
  });
  assert.deepEqual(await getAccessToken("codebuddy-intl", { refreshToken: "test-refresh" }, null), {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    expiresIn: 3600,
  });
});

test("International refresh returns null for missing, rejected, malformed, or failed tokens", async () => {
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch");
  };
  assert.equal(await refreshCodebuddyIntlToken(""), null);
  globalThis.fetch = async () => jsonResponse({ code: 12153 }, 401);
  assert.equal(await refreshCodebuddyIntlToken("bogus"), null);
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });
  assert.equal(await refreshCodebuddyIntlToken("bogus"), null);
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };
  assert.equal(await refreshCodebuddyIntlToken("bogus"), null);
});

const executor = new CodeBuddyIntlExecutor();
const neutralPrompt = "You are a helpful AI assistant that helps with software engineering tasks.";
const tool = (description: string) => ({
  type: "function",
  function: { name: "read_file", description, parameters: { type: "object", properties: {} } },
});
const transform = (body: Record<string, unknown>) =>
  executor.transformRequest("glm-5.2", body, false, {}) as Record<string, unknown>;

test("International executor is registered by id and cbai, forces SSE and uses IDE bearer headers", () => {
  for (const id of ["codebuddy-intl", "cbai"]) {
    assert.ok(getExecutor(id) instanceof CodeBuddyIntlExecutor);
    assert.equal(hasSpecializedExecutor(id), true);
  }
  assert.equal(executor.buildUrl("glm-5.2", false), REGISTRY["codebuddy-intl"].baseUrl);
  for (const credentials of [{ accessToken: "test-access" }, { apiKey: "test-api-key" }]) {
    const headers = new Headers(executor.buildHeaders(credentials, true));
    assert.equal(
      headers.get("Authorization"),
      `Bearer ${credentials.accessToken ?? credentials.apiKey}`
    );
    for (const [name, value] of Object.entries(REGISTRY["codebuddy-intl"].headers)) {
      assert.equal(headers.get(name), value);
    }
  }
  assert.equal(transform({ stream: false }).stream, true);
});

test("International reasoning is opt-in and none/off do not add a summary", () => {
  for (const effort of [undefined, "none", "off"]) {
    const out = transform({
      reasoning_effort: effort,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.reasoning_effort, undefined);
    assert.equal(out.reasoning_summary, undefined);
  }
  const out = transform({ reasoning_effort: "high" });
  assert.equal(out.reasoning_effort, "high");
  assert.equal(out.reasoning_summary, "auto");
});

test("International normalization supplies a leading system and typed user text without dropping messages", () => {
  const input = {
    messages: [
      { role: "user", content: "hello", name: "caller" },
      { role: "system", content: "Reply in Spanish." },
      { role: "developer", content: "Keep replies short." },
      { role: "system", content: [{ type: "text", text: "Use JSON." }] },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ],
  };
  const before = structuredClone(input);
  assert.deepEqual(transform(input).messages, [
    input.messages[1],
    { ...input.messages[0], content: [{ type: "text", text: "hello" }] },
    ...input.messages.slice(2),
  ]);
  assert.deepEqual(input, before, "caller-owned messages must not be mutated");
  assert.deepEqual(
    transform({
      messages: [
        { role: "developer", content: "Stay concise." },
        { role: "user", content: "" },
      ],
    }).messages,
    [
      { role: "system", content: "You are CodeBuddy Code." },
      { role: "developer", content: "Stay concise." },
      { role: "user", content: [{ type: "text", text: "" }] },
    ]
  );
  assert.deepEqual(transform({ messages: [] }).messages, [
    { role: "system", content: "You are CodeBuddy Code." },
  ]);
});

test("International neutralizes agent identities and >2000-char system prompts while preserving shape", () => {
  for (const text of [
    "You are Claude Code, Anthropic's official CLI.",
    "You are Cursor.",
    "You are an AI coding agent.",
    "OhMyOpenCode orchestration capabilities",
    "<Role>software agent</Role>",
    "x".repeat(2001),
  ]) {
    for (const content of [text, [{ type: "text", text }]]) {
      const expected =
        typeof content === "string" ? neutralPrompt : [{ type: "text", text: neutralPrompt }];
      const input = { system: content, messages: [{ role: "system", content }] };
      const before = structuredClone(input);
      const out = transform(input);
      assert.deepEqual(out.system, expected);
      assert.deepEqual(out.messages, [{ role: "system", content: expected }]);
      assert.deepEqual(input, before);
      const topOnly = transform({ system: content, messages: [{ role: "user", content: "hi" }] });
      assert.deepEqual((topOnly.messages as unknown[])[0], { role: "system", content: expected });
    }
  }
  for (const content of [
    "Legitimate system instruction",
    "x".repeat(2000),
    [{ type: "text", text: "Use JSON." }],
  ]) {
    const out = transform({ system: content, messages: [{ role: "system", content }] });
    assert.deepEqual(out.system, content);
    assert.deepEqual(out.messages, [{ role: "system", content }]);
  }
});

test("International strips only function descriptions at the >=64KB UTF-8 boundary", () => {
  const emptySize = new TextEncoder().encode(JSON.stringify([tool("")])).byteLength;
  for (const bytes of [64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1]) {
    const input = { tools: [tool("x".repeat(bytes - emptySize))] };
    const before = structuredClone(input);
    const out = transform(input);
    const result = (out.tools as ReturnType<typeof tool>[])[0].function;
    assert.equal(Object.hasOwn(result, "description"), bytes < 64 * 1024);
    assert.equal(result.name, "read_file");
    assert.deepEqual(result.parameters, input.tools[0].function.parameters);
    assert.deepEqual(input, before);
  }
  const mixed = {
    tools: [tool("界".repeat(22000)), { type: "web_search", description: "built-in" }, null],
  };
  const out = transform(mixed);
  assert.equal(
    Object.hasOwn((out.tools as ReturnType<typeof tool>[])[0].function, "description"),
    false
  );
  assert.deepEqual((out.tools as unknown[]).slice(1), mixed.tools.slice(1));
});

test("International maps 6004 and frequency limits to 429 with parsed reset timestamps", () => {
  for (const [message, reset] of [
    ["超出频率限制，请在2026-01-02 12:00:00 UTC+8重试", "2026-01-02T12:00:00+08:00"],
    ["Frequency limit until 2026-01-02 12:00:00 UTC+00:00", "2026-01-02T12:00:00Z"],
    ["frequency limit until 2026-01-02 12:00:00", "2026-01-02T12:00:00+08:00"],
    ["Rate limit until 2026-01-02T12:00:00Z", "2026-01-02T12:00:00Z"],
    ["frequency limit until 2026-01-02 12:00:00 UTC-5:30", "2026-01-02T12:00:00-05:30"],
  ]) {
    const parsed = executor.parseError(
      jsonResponse({}, 400),
      JSON.stringify({ code: 6004, msg: message })
    );
    assert.equal(parsed.status, 429);
    assert.equal(parsed.message, message);
    assert.equal(parsed.resetsAtMs, Date.parse(reset));
  }
  assert.deepEqual(executor.parseError(jsonResponse({}), '{"code":6004}'), {
    status: 429,
    message: "CodeBuddy frequency limit (6004)",
    resetsAtMs: null,
  });
  assert.equal(
    executor.parseError(jsonResponse({}, 400), '{"message":"frequency limit"}').status,
    429
  );
  assert.equal(
    executor.parseError(jsonResponse({}, 400), '{"error":{"code":"6004","message":"limited"}}')
      .status,
    429
  );
  assert.equal(executor.parseError(jsonResponse({}, 400), "invalid request").status, 400);
});

test("International sends normalized IDE wire requests and does not buffer successful SSE", async () => {
  const upstream = new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, REGISTRY["codebuddy-intl"].baseUrl);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("User-Agent"), "IDE/2.108.1 CodeBuddy/2.108.1");
    assert.equal(headers.get("Authorization"), "Bearer test-access");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [
      { role: "system", content: "You are CodeBuddy Code." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    return upstream;
  };
  const result = await executor.execute({
    model: "glm-5.2",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { accessToken: "test-access" },
    skipUpstreamRetry: true,
  });
  assert.ok(!(result instanceof Response));
  assert.equal(result.response, upstream);
  assert.equal(upstream.bodyUsed, false);
});

test("International retries sensitive-content once with compacted tools, including generic phrasing", async () => {
  for (const message of ["抱歉，系统检测到敏感内容", "Request rejected due to sensitive content"]) {
    const requests: Record<string, unknown>[] = [];
    const input = {
      tools: [tool("Read a local file.")],
      messages: [{ role: "user", content: "read file" }],
    };
    const before = structuredClone(input);
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse({ msg: message }, 400);
    };
    const result = await executor.execute({
      model: "glm-5.2",
      body: input,
      stream: true,
      credentials: { accessToken: "test-access" },
      skipUpstreamRetry: true,
    });
    assert.equal(requests.length, 2, "sensitive rejection must be retried at most once");
    assert.equal(
      Object.hasOwn((requests[0].tools as ReturnType<typeof tool>[])[0].function, "description"),
      true
    );
    assert.equal(
      Object.hasOwn((requests[1].tools as ReturnType<typeof tool>[])[0].function, "description"),
      false
    );
    assert.deepEqual(input, before);
    assert.equal(result instanceof Response ? result.status : result.response.status, 400);
  }
});

test("International does not retry unrelated or already-compacted sensitive rejections", async () => {
  for (const [description, message] of [
    ["x".repeat(70000), "sensitive content"],
    ["short", "invalid model"],
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse({ msg: message }, 400);
    };
    await executor.execute({
      model: "glm-5.2",
      body: { tools: [tool(description)] },
      stream: true,
      credentials: { accessToken: "test-access" },
      skipUpstreamRetry: true,
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ msg: "sensitive content" }, 400);
  };
  await executor.execute({
    model: "glm-5.2",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: { accessToken: "test-access" },
    skipUpstreamRetry: true,
  });
  assert.equal(calls, 1);
});

test("International one-shot retry preserves refreshed bearer and accepts bare Response results", async (t) => {
  let calls = 0;
  t.mock.method(DefaultExecutor.prototype, "execute", async (input) => {
    calls++;
    if (calls === 1)
      return {
        response: jsonResponse({ msg: "sensitive content" }, 400),
        headers: { authorization: "Bearer rotated-access" },
        transformedBody: JSON.stringify(input.body),
      };
    assert.equal(input.credentials.accessToken, "rotated-access");
    assert.equal(input.credentials.expiresAt, undefined);
    assert.equal(Object.hasOwn(input.body.tools[0].function, "description"), false);
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const result = await executor.execute({
    model: "glm-5.2",
    body: { tools: [tool("short")] },
    stream: true,
    credentials: { accessToken: "old-access", expiresAt: "2000-01-01" },
  });
  assert.ok(result instanceof Response);
  assert.equal(calls, 2);
});

test("International exposes 6004 reset to chatCore via HTTP 429 and Retry-After", async () => {
  const reset = new Date(Date.now() + 120000).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const status of [200, 400, 429]) {
    globalThis.fetch = async () =>
      jsonResponse({ code: 6004, msg: `Frequency limit until ${reset}` }, status);
    const result = await executor.execute({
      model: "glm-5.2",
      body: {},
      stream: false,
      credentials: { accessToken: "test-access" },
      skipUpstreamRetry: true,
    });
    const response = result instanceof Response ? result : result.response;
    assert.equal(response.status, 429);
    const retry = Number(response.headers.get("Retry-After"));
    assert.ok(retry >= 118 && retry <= 120);
    const details = await parseUpstreamError(response, "codebuddy-intl");
    assert.equal(details.statusCode, 429);
    assert.equal(details.retryAfterMs, retry * 1000);
    assert.match(details.message, /Frequency limit/);
  }
});

test("International leaves successful JSON answers mentioning frequency limits unchanged", async () => {
  const upstream = jsonResponse({
    choices: [{ message: { content: "A frequency limit prevents overload." } }],
  });
  globalThis.fetch = async () => upstream;
  const result = await executor.execute({
    model: "glm-5.2",
    body: {},
    stream: false,
    credentials: { accessToken: "test-access" },
    skipUpstreamRetry: true,
  });
  assert.equal(result instanceof Response ? result : result.response, upstream);
});

test("International usage is admitted for OAuth and both API-key auth spellings", () => {
  assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("codebuddy-intl"));
  assert.ok(USAGE_FETCHER_PROVIDERS.includes("codebuddy-intl"));
  for (const authType of ["oauth", "apikey", "api_key"]) {
    assert.equal(
      isSupportedUsageConnection({ id: "intl-usage", provider: "codebuddy-intl", authType }),
      true
    );
  }
  assert.equal(
    isSupportedUsageConnection({
      id: "intl-usage",
      provider: "codebuddy-intl",
      authType: "unknown",
    }),
    false
  );
});

test("International usage dispatches the IDE billing wire request and keeps refill and bonus balances separate", async () => {
  const monthlyEnd = "2026-11-01T00:00:00Z";
  const validityEnd = Date.parse("2027-01-01T00:00:00Z") / 1000;
  const bonusSoon = "2026-10-20T00:00:00Z";
  const bonusLater = "2026-10-25T00:00:00Z";
  const accounts = [
    {
      PackageName: "Monthly allowance",
      CycleStartTime: "2026-10-01T00:00:00Z",
      CycleEndTime: monthlyEnd,
      DeductionEndTime: validityEnd,
      CycleCapacitySize: 400,
      CycleCapacitySizePrecise: "500",
      CycleCapacityUsed: 10,
      CycleCapacityUsedPrecise: "12.34",
      CapacitySize: 9999,
      CapacityUsed: 999,
    },
    {
      PackageName: "Bonus later",
      CycleEndTime: bonusLater,
      DeductionEndTime: String(Date.parse(bonusLater) / 1000),
      CapacitySize: 50,
      CapacityUsed: 1,
    },
    {
      PackageName: "Bonus sooner",
      CycleEndTime: bonusSoon,
      DeductionEndTime: Date.parse(bonusSoon),
      CapacitySize: 20,
      CapacitySizePrecise: "25",
      CapacityUsed: 2,
      CapacityUsedPrecise: "5",
      CycleCapacitySize: 9999,
    },
  ];
  for (const credentials of [
    { accessToken: "test-access", apiKey: "unused-api-key" },
    { apiKey: "test-api-key" },
  ]) {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, "https://www.codebuddy.ai/v2/billing/meter/get-user-resource");
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "{}");
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("Authorization"),
        `Bearer ${credentials.accessToken ?? credentials.apiKey}`
      );
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(headers.get("Accept"), "application/json");
      for (const [name, value] of Object.entries(REGISTRY["codebuddy-intl"].headers)) {
        assert.equal(headers.get(name), value);
      }
      return jsonResponse({ code: 0, data: { Response: { Data: { Accounts: accounts } } } });
    };
    const result = await getUsageForProvider({ provider: "codebuddy-intl", ...credentials });
    assert.equal(calls, 1);
    assert.deepEqual(result, {
      plan: "Monthly allowance",
      quotas: {
        Monthly: {
          used: 12.34,
          total: 500,
          resetAt: new Date(monthlyEnd).toISOString(),
          unlimited: false,
        },
        "Bonus Pack 1": {
          used: 5,
          total: 25,
          resetAt: new Date(bonusSoon).toISOString(),
          unlimited: false,
        },
        "Bonus Pack 2": {
          used: 1,
          total: 50,
          resetAt: new Date(bonusLater).toISOString(),
          unlimited: false,
        },
      },
    });
  }
});

test("International usage distinguishes cadence, duplicate refills, reset encodings and default plan", async () => {
  const accounts = [
    {
      CycleStartTime: "2026-10-01T00:00:00Z",
      CycleEndTime: Date.parse("2026-10-02T00:00:00Z") / 1000,
      DeductionEndTime: "2027-01-01T00:00:00Z",
      CycleCapacitySize: 10,
    },
    {
      CycleStartTime: "2026-10-02T00:00:00Z",
      CycleEndTime: String(Date.parse("2026-10-03T00:00:00Z")),
      DeductionEndTime: "2027-01-01T00:00:00Z",
      CycleCapacitySize: 20,
    },
    {
      CycleStartTime: "2026-10-01T00:00:00Z",
      CycleEndTime: "2026-10-08T00:00:00Z",
      DeductionEndTime: "2027-01-01T00:00:00Z",
      CycleCapacitySize: 30,
    },
    {
      CapacitySizePrecise: "not-a-number",
      CapacityUsedPrecise: "not-a-number",
      CycleEndTime: "invalid",
    },
  ];
  globalThis.fetch = async () =>
    jsonResponse({ code: 0, data: { Response: { Data: { Accounts: accounts } } } });
  const result = await getCodeBuddyIntlUsage("test-access");
  assert.equal(result.plan, "CodeBuddy International");
  assert.deepEqual(result.quotas, {
    Daily: { used: 0, total: 10, resetAt: "2026-10-02T00:00:00.000Z", unlimited: false },
    "Daily 2": { used: 0, total: 20, resetAt: "2026-10-03T00:00:00.000Z", unlimited: false },
    Weekly: { used: 0, total: 30, resetAt: "2026-10-08T00:00:00.000Z", unlimited: false },
    "Bonus Pack 1": { used: 0, total: 0, resetAt: null, unlimited: false },
  });
});

test("International usage preserves CN's strict two-day refill boundary", async () => {
  const cycleEnd = Date.parse("2026-11-01T00:00:00Z");
  const twoDays = 2 * 24 * 60 * 60 * 1000;
  for (const [gap, name, used, total] of [
    [twoDays, "Bonus Pack 1", 1, 100],
    [twoDays + 1, "Monthly", 2, 200],
  ] as const) {
    globalThis.fetch = async () =>
      jsonResponse({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [
                {
                  CycleEndTime: cycleEnd,
                  DeductionEndTime: cycleEnd + gap,
                  CycleCapacitySize: 200,
                  CycleCapacityUsed: 2,
                  CapacitySize: 100,
                  CapacityUsed: 1,
                },
              ],
            },
          },
        },
      });
    assert.deepEqual((await getCodeBuddyIntlUsage("test-access")).quotas, {
      [name]: { used, total, resetAt: new Date(cycleEnd).toISOString(), unlimited: false },
    });
  }
});

test("International usage handles missing credentials, API errors, empty quotas, and sanitized failures", async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch should not run without credentials");
  };
  assert.deepEqual(await getCodeBuddyIntlUsage(), {
    message: "CodeBuddy International credential not available.",
  });
  for (const status of [401, 403, 500]) {
    globalThis.fetch = async () => jsonResponse({}, status);
    assert.deepEqual(await getCodeBuddyIntlUsage("test-access"), {
      message:
        status === 500
          ? "CodeBuddy International quota API error (500)."
          : "CodeBuddy International credential invalid or expired.",
    });
  }
  for (const data of [
    {},
    { Response: { Data: { Accounts: [] } } },
    { Response: { Data: { Accounts: {} } } },
  ]) {
    globalThis.fetch = async () => jsonResponse({ code: 0, data });
    assert.deepEqual(await getCodeBuddyIntlUsage("test-access"), {
      message: "CodeBuddy International connected. No credit package found.",
    });
  }
  globalThis.fetch = async () => jsonResponse({ code: 123, msg: "quota unavailable" });
  assert.deepEqual(await getCodeBuddyIntlUsage("test-access"), {
    message: "CodeBuddy International quota error: quota unavailable",
  });
  globalThis.fetch = async () =>
    jsonResponse({ code: 123, msg: "Error: failure at /home/private/provider.ts:23:1" });
  assert.doesNotMatch(
    (await getCodeBuddyIntlUsage("test-access")).message ?? "",
    /\/home\/private/
  );
  globalThis.fetch = async () =>
    jsonResponse({ code: 123, msg: "failure\n/home/private/provider.ts:23:1" });
  assert.doesNotMatch(
    (await getCodeBuddyIntlUsage("test-access")).message ?? "",
    /\n|\/home\/private/
  );
  globalThis.fetch = async () =>
    jsonResponse({ code: 123, msg: "invalid Bearer test-access-value" });
  assert.doesNotMatch(
    (await getCodeBuddyIntlUsage("test-access")).message ?? "",
    /test-access-value/
  );
  globalThis.fetch = async () =>
    jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [null] } } } });
  assert.deepEqual(await getCodeBuddyIntlUsage("test-access"), {
    message: "CodeBuddy International error: failed to fetch quota.",
  });
  globalThis.fetch = async () => {
    throw new Error("Error at /home/private/provider.ts:23:1");
  };
  assert.deepEqual(await getCodeBuddyIntlUsage("test-access"), {
    message: "CodeBuddy International error: failed to fetch quota.",
  });
  globalThis.fetch = async () =>
    new Response("not JSON", { headers: { "Content-Type": "application/json" } });
  assert.deepEqual(await getCodeBuddyIntlUsage("test-access"), {
    message: "CodeBuddy International error: failed to fetch quota.",
  });
});
