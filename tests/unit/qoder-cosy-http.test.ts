import test from "node:test";
import assert from "node:assert/strict";

// Pure-HTTP (COSY) Qoder path, ported from 9router (decolua/9router, MIT).
// PAT (pt-*) connections are exchanged for a short-lived job token (jt-*),
// the request body is WAF-encoded, COSY-signed, and sent to api2.qoder.sh
// (job-token traffic). qodercli remains the fallback when the HTTP path
// cannot be built.

const { qoderEncodeBody } = await import("../../open-sse/shared/qoder/encoding.ts");
const { buildCosyHeaders } = await import("../../open-sse/shared/qoder/cosy.ts");
const { QoderExecutor, __test__ } = await import("../../open-sse/executors/qoder.ts");
const { clearQoderCatalog, __clearQoderPatJobCache } =
  await import("../../open-sse/services/qoderModels.ts");
const { __clearQoderJobTokenCache } = await import("../../open-sse/services/qoderCli.ts");

type FetchRoute = {
  match: (url: string, init?: RequestInit) => boolean;
  response: () => Response | Promise<Response>;
};

const originalFetch = globalThis.fetch;

function installFetchRoutes(routes: FetchRoute[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const route of routes) {
      if (route.match(url, init)) return route.response();
    }
    return new Response("unmocked", { status: 404 });
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const MODEL_LIST_BODY = JSON.stringify({
  chat: [
    {
      key: "qmodel_38max",
      display_name: "Qwen3.8-Max",
      enable: true,
      is_reasoning: true,
      max_output_tokens: 8192,
      max_input_tokens: 131072,
      source: "system",
    },
    {
      key: "qmodel",
      display_name: "Qwen3.7-Plus",
      enable: false,
      is_reasoning: false,
      max_output_tokens: 16384,
      max_input_tokens: 131072,
      source: "system",
    },
    {
      key: "dfmodel",
      display_name: "DeepSeek-V4-Flash",
      enable: false,
      is_reasoning: true,
      max_output_tokens: 32768,
      max_input_tokens: 131072,
      source: "system",
    },
  ],
});

const CHAT_SSE = [
  `data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"Hel\\"}}]}"}`,
  ``,
  `data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"lo\\"}}]}"}`,
  ``,
  `data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{},\\"finish_reason\\":\\"stop\\"}]}"}`,
  ``,
  `data: [DONE]`,
  ``,
].join("\n");

function happyPathRoutes(): FetchRoute[] {
  return [
    {
      match: (url) => url.includes("/jobToken/exchange"),
      response: () => new Response(JSON.stringify({ token: "jt-EXCHANGED", expires_in: 82800 })),
    },
    {
      match: (url) => url.includes("/userinfo"),
      response: () => new Response(JSON.stringify({ id: "u-123" })),
    },
    {
      match: (url) => url.includes("/model/list"),
      response: () => new Response(MODEL_LIST_BODY),
    },
    {
      match: (url) => url.includes("agent_chat_generation"),
      response: () => new Response(CHAT_SSE),
    },
  ];
}

async function streamText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

test.afterEach(() => {
  restoreFetch();
  __clearQoderJobTokenCache();
  __clearQoderPatJobCache();
  clearQoderCatalog();
});

// ---------------------------------------------------------------- encoding

test("qoderEncodeBody is deterministic and uses the custom alphabet", () => {
  const input = Buffer.from('{"messages":[{"role":"user","content":"hi"}]}', "utf8");
  const first = qoderEncodeBody(input);
  const second = qoderEncodeBody(input);
  assert.equal(first, second);
  assert.equal(first.length, input.toString("base64").length);
  // '=' padding maps to '$'
  const padded = qoderEncodeBody(Buffer.from("a", "utf8"));
  assert.ok(padded.includes("$"), "padding should map to $");
  // Only characters from the custom alphabet survive.
  for (const ch of first) {
    assert.ok(
      "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$".includes(ch),
      `unexpected char ${ch}`
    );
  }
});

test("qoderEncodeBody accepts string and Buffer inputs", () => {
  const fromString = qoderEncodeBody("hello");
  const fromBuffer = qoderEncodeBody(Buffer.from("hello", "utf8"));
  assert.equal(fromString, fromBuffer);
});

// ------------------------------------------------------------------- cosy

test("buildCosyHeaders emits the full header set with valid signature shape", () => {
  const headers = buildCosyHeaders(
    Buffer.from("encoded-body", "latin1"),
    "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
    { userId: "u-123", authToken: "jt-abc", machineId: "m-1" }
  );

  assert.match(headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.\b[0-9a-f]{32}\b$/);
  assert.ok(headers["Cosy-Key"], "Cosy-Key required");
  assert.equal(headers["Cosy-User"], "u-123");
  assert.match(headers["Cosy-Date"], /^\d{10}$/);
  assert.equal(headers["Cosy-Machineid"], "m-1");
  assert.equal(headers["Cosy-Machinetoken"], "m-1");
  assert.equal(headers["Cosy-Version"], "1.0.0");
  assert.equal(headers["Cosy-Clienttype"], "5");
  assert.equal(headers["Cosy-Clientip"], "127.0.0.1");
  // body hash/length of the *exact* body bytes
  assert.equal(headers["Cosy-Bodylength"], String(Buffer.byteLength("encoded-body", "latin1")));
  assert.match(headers["Cosy-Bodyhash"], /^[0-9a-f]{32}$/);
  // sigPath strips the leading /algo
  assert.equal(headers["Cosy-Sigpath"], "/api/v2/service/pro/sse/agent_chat_generation");
  assert.equal(headers["Login-Version"], "v2");
  assert.ok(headers["X-Request-Id"], "X-Request-Id required");
});

test("buildCosyHeaders throws without userId or authToken", () => {
  assert.throws(() =>
    buildCosyHeaders(Buffer.alloc(0), "https://api2.qoder.sh/x", { userId: "", authToken: "jt-x" })
  );
  assert.throws(() =>
    buildCosyHeaders(Buffer.alloc(0), "https://api2.qoder.sh/x", { userId: "u", authToken: "" })
  );
});

// ------------------------------------------------------------ normalize

test("normalizeQoderMessages hoists system and flattens multipart content", () => {
  const { normalizeQoderMessages } = __test__;
  const { messages, systemText } = normalizeQoderMessages({
    messages: [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "data:..." } },
        ],
      },
      { role: "assistant", content: "hi" },
    ],
  });
  assert.equal(systemText, "You are helpful.");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "hello");
  assert.equal(messages[1].role, "assistant");
});

// ----------------------------------------------------- model key resolve

test("resolveQoderModelKey maps OmniRoute ids to canonical catalog keys", async () => {
  installFetchRoutes([
    { match: (url) => url.includes("/model/list"), response: () => new Response(MODEL_LIST_BODY) },
  ]);
  const credentials = { accessToken: "jt-x", providerSpecificData: { userId: "u-123" } };

  // direct key match
  assert.equal(
    await __test__.resolveQoderModelKey("qmodel_38max", credentials as never),
    "qmodel_38max"
  );
  // static level map → key present in catalog
  assert.equal(await __test__.resolveQoderModelKey("qwen3.7-plus", credentials as never), "qmodel");
  // fuzzy display-name match (qwen3.8-max-preview → Qwen3.8-Max)
  assert.equal(
    await __test__.resolveQoderModelKey("qwen3.8-max-preview", credentials as never),
    "qmodel_38max"
  );
  // unknown id → first enabled model
  assert.equal(
    await __test__.resolveQoderModelKey("some-random-model", credentials as never),
    "qmodel_38max"
  );
});

test("resolveQoderModelKey throws when the catalog is unreachable", async () => {
  installFetchRoutes([
    { match: () => true, response: () => new Response("boom", { status: 500 }) },
  ]);
  const credentials = { accessToken: "jt-x", providerSpecificData: { userId: "u-123" } };
  await assert.rejects(
    () => __test__.resolveQoderModelKey("qwen3.8-max-preview", credentials as never),
    /model catalog unavailable/
  );
});

// ------------------------------------------------------------ wrap SSE

test("wrapQoderSse unwraps envelope frames into OpenAI SSE", async () => {
  const raw = new Response(CHAT_SSE, { status: 200 });
  const wrapped = __test__.wrapQoderSse(raw, "qoder/qmodel_38max");
  const text = await streamText(wrapped);
  assert.ok(text.includes('"content":"Hel"'));
  assert.ok(text.includes('"content":"lo"'));
  assert.ok(text.includes("data: [DONE]"));
  assert.ok(!text.includes("statusCodeValue"), "envelope must be unwrapped");
});

test("wrapQoderSse surfaces upstream error frames as an error chunk + [DONE]", async () => {
  const errorSse = `data: {"statusCodeValue":403,"body":"{\\"code\\":\\"112\\",\\"message\\":\\"pricing\\"}"}\n\n`;
  const wrapped = __test__.wrapQoderSse(
    new Response(errorSse, { status: 200 }),
    "qoder/qmodel_38max"
  );
  const text = await streamText(wrapped);
  assert.ok(text.includes("qoder error 403"));
  assert.ok(text.includes("data: [DONE]"));
});

// ------------------------------------------------------ collectSseText

test("collectQoderSseText joins delta content for non-streaming", async () => {
  const raw = new Response(CHAT_SSE, { status: 200 });
  const text = await __test__.collectQoderSseText(raw);
  assert.equal(text, "Hello");
});

// ------------------------------------------------------ request body

test("buildQoderRequestBody builds the Qoder payload shape", async () => {
  installFetchRoutes([
    { match: (url) => url.includes("/model/list"), response: () => new Response(MODEL_LIST_BODY) },
  ]);
  const credentials = {
    accessToken: "jt-x",
    displayName: "Tester",
    providerSpecificData: { userId: "u-123" },
  };
  const { qoderKey, payload } = await __test__.buildQoderRequestBody({
    model: "qmodel_38max",
    body: { messages: [{ role: "user", content: "ping" }], max_tokens: 123 },
    credentials: credentials as never,
  });
  assert.equal(qoderKey, "qmodel_38max");
  assert.equal(payload.stream, true);
  assert.equal(payload.chat_task, "FREE_INPUT");
  assert.equal((payload.messages as Array<Record<string, unknown>>)[0].content, "ping");
  assert.equal(
    (payload.parameters as Record<string, unknown>).max_tokens,
    123
  );
  assert.equal((payload.model_config as Record<string, unknown>).key, "qmodel_38max");
  assert.equal((payload.chat_context as Record<string, unknown>).text, "ping");
  assert.ok(payload.business, "business block required");
});

// -------------------------------------------------- executor dispatch

test("QoderExecutor PAT happy path streams through the COSY HTTP path", async () => {
  installFetchRoutes(happyPathRoutes());
  const executor = new QoderExecutor();
  const result = await executor.execute({
    model: "qwen3.8-max-preview",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: { apiKey: "pt-TESTPAT" },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("content-type"), "text/event-stream");
  const text = await streamText(result.response);
  assert.ok(text.includes('"content":"Hel"'), "stream should contain content deltas");
  assert.ok(text.includes('"content":"lo"'));
  assert.ok(text.includes("data: [DONE]"));
  // The request must have hit the COSY chat endpoint with job-token creds.
  const url = result.url;
  assert.ok(url.includes("api2.qoder.sh"), `expected api2 for jt- traffic, got ${url}`);
  assert.ok(url.includes("Encode=1"));
});

test("QoderExecutor PAT non-streaming collects text into a completion payload", async () => {
  installFetchRoutes(happyPathRoutes());
  const executor = new QoderExecutor();
  const result = await executor.execute({
    model: "qwen3.8-max-preview",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { apiKey: "pt-TESTPAT" },
  });
  assert.equal(result.response.status, 200);
  const json = (await result.response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  assert.equal(json.choices?.[0]?.message?.content, "Hello");
});

test("QoderExecutor falls back to qodercli when PAT exchange fails", async () => {
  installFetchRoutes([
    {
      match: (url) => url.includes("/jobToken/exchange"),
      response: () => new Response("denied", { status: 401 }),
    },
  ]);
  // Force qodercli to be "missing" regardless of the host PATH so the fallback
  // deterministically hits cli_not_found instead of running a real binary.
  const prevBin = process.env.CLI_QODER_BIN;
  process.env.CLI_QODER_BIN = "/nonexistent/qodercli-bin";
  try {
    const executor = new QoderExecutor();
    const result = await executor.execute({
      model: "qwen3.8-max-preview",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "pt-BADPAT" },
    });
    // qodercli is not installed in the test host → cli_not_found 502.
    assert.equal(result.response.status, 502);
    const body = (await result.response.json()) as { error?: { message?: string; code?: string } };
    assert.equal(body.error?.code, "cli_not_found");
    assert.match(body.error?.message || "", /was not found on the OmniRoute host/);
  } finally {
    if (prevBin === undefined) delete process.env.CLI_QODER_BIN;
    else process.env.CLI_QODER_BIN = prevBin;
  }
});

test("QoderExecutor passes upstream 403 billing errors through without CLI fallback", async () => {
  const billingSse = `data: {"statusCodeValue":403,"body":"{\\"code\\":\\"112\\",\\"message\\":\\"{\\\\\\"pricingUrl\\\\\\":\\\\\\"https://qoder.com/pricing\\\\\\"}\\"}"}\n\n`;
  installFetchRoutes([
    {
      match: (url) => url.includes("/jobToken/exchange"),
      response: () => new Response(JSON.stringify({ token: "jt-EXCHANGED", expires_in: 82800 })),
    },
    {
      match: (url) => url.includes("/userinfo"),
      response: () => new Response(JSON.stringify({ id: "u-123" })),
    },
    {
      match: (url) => url.includes("/model/list"),
      response: () => new Response(MODEL_LIST_BODY),
    },
    {
      match: (url) => url.includes("agent_chat_generation"),
      response: () => new Response(billingSse),
    },
  ]);
  const executor = new QoderExecutor();
  const result = await executor.execute({
    model: "qwen3.8-max-preview",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: { apiKey: "pt-TESTPAT" },
  });
  // Upstream answered (403 billing) — must NOT fall back to qodercli.
  assert.equal(result.response.status, 403);
  const body = (await result.response.json()) as { error?: { message?: string } };
  assert.match(body.error?.message || "", /qoder error 403/);
});
