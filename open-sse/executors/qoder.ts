import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  setUserAgentHeader,
  type ExecuteInput,
  type ProviderCredentials,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import {
  getQoderDashscopeCompatHeaders,
  QODER_DEFAULT_USER_AGENT,
} from "../config/providerHeaderProfiles.ts";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeQwenThinkingToolChoice } from "../services/qwenThinking.ts";
import {
  buildQoderChunk,
  buildQoderCompletionPayload,
  buildQoderPrompt,
  createQoderErrorResponse,
  parseQoderCliFailure,
  parseQoderCliResult,
  runQoderCli,
  QODER_MODEL_LEVELS,
} from "../services/qoderCli.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { buildCosyHeaders } from "../shared/qoder/cosy.ts";
import { qoderEncodeBody } from "../shared/qoder/encoding.ts";
import {
  QODER_CHAT_BASE,
  QODER_CHAT_BASE_ALT,
  QODER_CHAT_SIG_PATH,
} from "../shared/qoder/constants.ts";
import {
  getQoderModelConfig,
  resolveQoderCredentials,
  resolveQoderModels,
} from "../services/qoderModels.ts";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Wrap a full qodercli reply as an OpenAI-compatible SSE stream (role chunk →
 * content chunk → stop chunk → [DONE]). qodercli's `--print` mode returns the
 * whole answer at once, so there are no incremental deltas to forward.
 */
function buildQoderCliSseStream(model: string, text: string): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const send = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        send(buildQoderChunk({ id, model, created, delta: { role: "assistant", content: "" } }))
      );
      if (text) {
        controller.enqueue(send(buildQoderChunk({ id, model, created, delta: { content: text } })));
      }
      controller.enqueue(
        send(buildQoderChunk({ id, model, created, delta: {}, finishReason: "stop" }))
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/**
 * Peek at the first SSE event from a Qoder response to detect upstream errors
 * that Qoder wraps inside an HTTP 200 SSE envelope ({statusCodeValue, body}).
 * Returns a proper HTTP error Response when found, so downstream fallback
 * logic (combo routing, account fallback) can trigger. For success, re-creates
 * the stream with the first chunk prepended so the body passes through
 * transparently.
 */
async function unwrapQoderEnvelope(response: Response): Promise<Response> {
  if (!response.ok || !response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const { done, value } = await reader.read();
  if (done) {
    reader.cancel();
    return new Response(
      JSON.stringify({ error: { message: "[qoder] empty response", type: "provider_error" } }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const text = decoder.decode(value, { stream: true });

  let errorStatus: number | null = null;
  let errorMsg = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (jsonStr === "[DONE]") break;
    try {
      const envelope = JSON.parse(jsonStr) as Record<string, unknown>;
      const statusVal =
        typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
      if (statusVal !== 200) {
        errorStatus = statusVal >= 400 ? statusVal : 502;
        errorMsg =
          typeof envelope.body === "string" ? envelope.body : `upstream status ${statusVal}`;
      }
    } catch {
      // Malformed JSON — treat as non-error; downstream handling parses it.
    }
    break;
  }

  if (errorStatus) {
    reader.cancel();
    const errType =
      errorStatus === 401 || errorStatus === 403 ? "authentication_error" : "provider_error";
    return new Response(
      JSON.stringify({
        error: {
          message: `[qoder error ${errorStatus}: ${sanitizeErrorMessage(truncate(errorMsg, 200))}]`,
          type: errType,
        },
      }),
      { status: errorStatus, headers: { "Content-Type": "application/json" } }
    );
  }

  // Re-create the stream with the first chunk prepended so the success body
  // passes through unchanged.
  const restStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value);
    },
    pull(controller) {
      return reader.read().then(({ done, value }) => {
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      });
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(restStream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system inside messages) and flatten multipart content arrays. Ported from
 * 9router (decolua/9router, MIT).
 */
function normalizeQoderMessages(body: unknown): {
  messages: Array<Record<string, unknown>>;
  systemText: string;
} {
  const requestBody = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  if (messages.length === 0) return { messages: [], systemText: "" };

  const systemParts: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    const text = extractQoderText(record.content);
    if (record.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    out.push({ ...record, content: text });
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

function extractQoderText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if ((record.type === "text" || !record.type) && typeof record.text === "string") {
          parts.push(record.text);
        } else if (typeof record.text === "string") {
          parts.push(record.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastQoderUserText(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function stableQoderHash(prefix: string, ...parts: Array<unknown>): string {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableQoderChatRecordId(
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown,
  maxTokens: number
): string {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) {
      h.update("\0");
      h.update(String(m.role));
    }
    if (typeof m.content === "string" && m.content) {
      h.update("\0");
      h.update(m.content);
    }
  }
  if (tools) {
    h.update("\0");
    try {
      h.update(JSON.stringify(tools));
    } catch {
      // non-serializable tools — ignore
    }
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects, with
 * the model_config fetched live from the COSY-signed model catalog. Sending a
 * stale/wrong model_config silently downgrades to a different model upstream,
 * so a missing entry is a hard error.
 */
async function buildQoderRequestBody({
  model,
  body,
  credentials,
  signal,
}: {
  model: string;
  body: unknown;
  credentials: ProviderCredentials;
  signal?: AbortSignal | null;
}): Promise<{ qoderKey: string; payload: Record<string, unknown> }> {
  const qoderKey = String(model || "").replace(/^qoder\//, "");

  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { signal });
  if (!modelConfig) {
    // Forced refresh once before giving up — the cache may simply not be
    // populated yet on the first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeQoderMessages(body);
  const requestBody = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const tools = requestBody.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof requestBody.max_tokens === "number" && requestBody.max_tokens > 0) {
    maxTokens = Math.min(maxTokens, requestBody.max_tokens);
  }
  if (
    typeof requestBody.max_completion_tokens === "number" &&
    requestBody.max_completion_tokens > 0
  ) {
    maxTokens = Math.min(maxTokens, requestBody.max_completion_tokens);
  }

  const lastUser = lastQoderUserText(messages);
  const psd = (credentials?.providerSpecificData || {}) as Record<string, unknown>;
  const sessionId = stableQoderHash("qoder-session", String(psd.userId || ""), qoderKey);
  const recordId = stableQoderChatRecordId(qoderKey, messages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: randomUUID(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: randomUUID(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
  };
}

/**
 * Resolve an OmniRoute model id to a canonical Qoder catalog key:
 *   1. direct key match (e.g. "qmodel_38max")
 *   2. static level mapping (qwen3.8-max-preview → qmodel_preview, ...)
 *   3. fuzzy display-name match against the live catalog
 *   4. first enabled catalog model (best effort)
 * Throws when the catalog is unreachable or has no usable entry.
 */
async function resolveQoderModelKey(
  modelId: string,
  credentials: ProviderCredentials,
  signal?: AbortSignal | null
): Promise<string> {
  const catalog = await resolveQoderModels(credentials, { signal });
  if (!catalog) throw new Error("qoder: model catalog unavailable");
  const rawConfigs = catalog.rawConfigs;

  const qoderKey = String(modelId || "").replace(/^qoder\//, "");
  if (qoderKey && rawConfigs.has(qoderKey)) return qoderKey;

  const levelKey = QODER_MODEL_LEVELS[qoderKey as keyof typeof QODER_MODEL_LEVELS];
  if (levelKey && rawConfigs.has(levelKey)) return levelKey;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalize(qoderKey);
  if (target) {
    for (const [key, cfg] of rawConfigs.entries()) {
      const display = normalize(String((cfg as Record<string, unknown>).display_name || ""));
      if (
        display &&
        (display.startsWith(target) || target.startsWith(display) || display.includes(target))
      ) {
        return key;
      }
    }
  }

  for (const [key, cfg] of rawConfigs.entries()) {
    if ((cfg as Record<string, unknown>).enable !== false) return key;
  }
  const first = rawConfigs.keys().next();
  if (!first.done) return first.value;
  throw new Error("qoder: model catalog is empty");
}

/**
 * Transform Qoder's `{statusCodeValue, body}` SSE envelope into plain OpenAI
 * SSE chunks. On terminal frames the upstream reader is cancelled so
 * non-streaming consumers (response.text()) don't hang on Qoder's keepalive.
 */
function wrapQoderSse(response: Response, model: string): Response {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sseDone = "data: [DONE]\n\n";
  let buffer = "";
  let doneEmitted = false;
  const reader = response.body.getReader();

  const processLine = (line: string, controller: ReadableStreamDefaultController<Uint8Array>) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed || doneEmitted) return;
    if (!trimmed.startsWith("data:")) return;

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode(sseDone));
      doneEmitted = true;
      return;
    }

    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` },
            finish_reason: "stop",
          },
        ],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode(sseDone));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode(sseDone));
      doneEmitted = true;
      return;
    }
    // Strip embedded newlines so the SSE frame stays a single event.
    controller.enqueue(encoder.encode(`data: ${inner.replace(/\r?\n/g, "")}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!doneEmitted) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              processLine(buffer, controller);
              buffer = "";
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
            if (doneEmitted) {
              // Terminal frame received — drop upstream keepalive and end.
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
          }
        }
      } catch {
        // fall through to terminal [DONE] + close
      } finally {
        if (!doneEmitted) {
          try {
            controller.enqueue(encoder.encode(sseDone));
            doneEmitted = true;
          } catch {
            // already closed
          }
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

/** Collect all assistant text from a Qoder envelope stream (non-streaming). */
async function collectQoderSseText(response: Response): Promise<string> {
  if (!response.ok || !response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  let doneEmitted = false;
  try {
    while (!doneEmitted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          doneEmitted = true;
          break;
        }
        try {
          const envelope = JSON.parse(data) as Record<string, unknown>;
          const statusVal =
            typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
          if (statusVal !== 200) {
            doneEmitted = true;
            break;
          }
          const inner = typeof envelope.body === "string" ? envelope.body : "";
          if (!inner) continue;
          if (inner === "[DONE]") {
            doneEmitted = true;
            break;
          }
          try {
            const chunk = JSON.parse(inner) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            };
            const content = chunk.choices?.[0]?.delta?.content || "";
            if (content) out += content;
            if (chunk.choices?.[0]?.finish_reason === "stop") doneEmitted = true;
          } catch {
            // non-JSON inner frame
          }
        } catch {
          // non-JSON envelope
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

function getAuthToken(credentials: ProviderCredentials): string {
  if (typeof credentials.apiKey === "string" && credentials.apiKey.trim()) {
    return credentials.apiKey.trim();
  }
  if (typeof credentials.accessToken === "string" && credentials.accessToken.trim()) {
    return credentials.accessToken.trim();
  }
  if (typeof credentials.refreshToken === "string" && credentials.refreshToken.trim()) {
    return credentials.refreshToken.trim();
  }
  // Fallback: QODER_PERSONAL_ACCESS_TOKEN env var (#966)
  const envToken = String(process.env.QODER_PERSONAL_ACCESS_TOKEN || "").trim();
  if (envToken) return envToken;
  return "";
}

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  buildHeaders(
    credentials: ProviderCredentials,
    stream = true,
    clientHeaders?: Record<string, string> | null,
    model?: string
  ): Record<string, string> {
    const headers = super.buildHeaders(credentials, stream, clientHeaders, model);
    setUserAgentHeader(headers, QODER_DEFAULT_USER_AGENT);
    return headers;
  }

  transformRequest(model: string, body: unknown): Record<string, unknown> {
    const payload = {
      ...(typeof body === "object" && body !== null ? body : {}),
      model,
    };

    return sanitizeQwenThinkingToolChoice(payload, "QoderExecutor");
  }

  async execute({ model, body, stream, credentials, signal, upstreamExtraHeaders }: ExecuteInput) {
    const token = getAuthToken(credentials);

    if (!token) {
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: "Qoder access token or API Key is required. Please sign in or set a PAT.",
              type: "authentication_error",
              code: "token_required",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
        url: "https://dashscope.aliyuncs.com",
        headers: { "Content-Type": "application/json" },
        transformedBody: body,
      };
    }

    const resolvedModel = model || "qwen3.8-max-preview";

    // Detect token type: PAT (Personal Access Token) starts with "pt-".
    // PATs prefer the pure-HTTP COSY path (see executeViaCosyHttp); the local
    // qodercli binary remains the fallback when the HTTP path cannot be built
    // (exchange failure, unreachable model catalog, missing userId).
    const isPatToken = token.startsWith("pt-");
    if (isPatToken) {
      try {
        return await this.executeViaCosyHttp({
          model: resolvedModel,
          body,
          stream,
          credentials,
          token,
          signal,
        });
      } catch (cosyErr) {
        return this.executeViaQoderCli({ model: resolvedModel, body, stream, token, signal });
      }
    }

    // Non-PAT tokens (OAuth apiKey / DashScope key) → DashScope OpenAI-compatible API.
    let mappedModel = resolvedModel;
    if (resolvedModel === "qwen3.5-plus" || resolvedModel === "qwen3.6-plus") {
      mappedModel = "coder-model";
    } else if (resolvedModel === "vision-model") {
      mappedModel = "qwen3-vl-plus";
    }
    let endpointUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

    // Check for custom API base via credentials (overrides the default)
    let credentialsApiBase: unknown;
    if (typeof credentials === "object" && credentials !== null) {
      const credsObj = credentials as Record<string, unknown>;
      credentialsApiBase = credsObj.customApiBase || credsObj.resourceUrl;
    }
    if (typeof credentialsApiBase === "string" && credentialsApiBase.trim()) {
      let base = credentialsApiBase.trim();
      if (!base.startsWith("http")) base = `https://${base}`;
      if (!base.endsWith("/v1")) base = base.endsWith("/") ? `${base}v1` : `${base}/v1`;
      endpointUrl = `${base}/chat/completions`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...getQoderDashscopeCompatHeaders(),
    };

    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);

    const payload = this.transformRequest(mappedModel, body);

    const bodyStr = JSON.stringify(payload);

    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers,
        body: bodyStr,
        signal,
      });

      if (!response.ok) {
        let errText = await response.text();
        return {
          response: new Response(
            JSON.stringify({
              error: {
                message: `Qoder API failed with status ${response.status}: ${errText}`,
                type: response.status === 401 ? "authentication_error" : "provider_error",
              },
            }),
            { status: response.status, headers: { "Content-Type": "application/json" } }
          ),
          url: endpointUrl,
          headers,
          transformedBody: payload,
        };
      }

      // Qoder wraps upstream errors inside an HTTP 200 SSE envelope
      // ({statusCodeValue}). Peek at the first event to detect this and return
      // a proper HTTP error so combo/account fallback logic can trigger.
      const unwrapped = await unwrapQoderEnvelope(response);
      return {
        response: unwrapped,
        url: endpointUrl,
        headers,
        transformedBody: payload,
      };
    } catch (e: unknown) {
      const error = e as Error;
      if (error.name === "AbortError") {
        throw error;
      }
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: `Qoder fetch error: ${sanitizeErrorMessage(error.message)}`,
              type: "provider_error",
            },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        ),
        url: endpointUrl,
        headers,
        transformedBody: payload,
      };
    }
  }

  /**
   * Drive a PAT (`pt-*`) completion through Qoder's pure-HTTP COSY protocol:
   *   PAT → job-token exchange → userId resolve → live model catalog →
   *   WAF-encoded body + COSY-signed request → api2.qoder.sh (jt- traffic).
   * Throws when the path cannot be built (exchange failure, catalog
   * unreachable, missing userId) so the caller can fall back to qodercli;
   * upstream error Responses are returned as-is (no fallback).
   */
  private async executeViaCosyHttp({
    model,
    body,
    stream,
    credentials,
    token,
    signal,
  }: {
    model: string;
    body: unknown;
    stream: boolean;
    credentials: ProviderCredentials;
    token: string;
    signal?: AbortSignal | null;
  }): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    // 1. Resolve credentials: PAT → short-lived job token + userId.
    let resolved: ProviderCredentials;
    try {
      resolved = (await resolveQoderCredentials(credentials, signal)) as ProviderCredentials;
    } catch (err) {
      const error = err as Error;
      throw new Error(`qoder PAT exchange failed: ${error.message}`);
    }
    const psd = (resolved?.providerSpecificData || {}) as Record<string, unknown>;
    const userId = String(psd.userId || "");
    const accessToken =
      typeof resolved?.accessToken === "string" && resolved.accessToken.trim()
        ? resolved.accessToken
        : token;
    if (!userId || !accessToken) {
      throw new Error(
        "qoder cosy: credential is missing userId/accessToken; reconnect the account"
      );
    }

    // 2. Resolve OmniRoute model id → canonical Qoder catalog key + config.
    const qoderKey = await resolveQoderModelKey(model, resolved, signal);
    const { payload } = await buildQoderRequestBody({
      model: qoderKey,
      body,
      credentials: resolved,
      signal,
    });

    // 3. Encode body (WAF bypass) then COSY-sign the *encoded* bytes.
    const endpointUrl = accessToken.startsWith("jt-")
      ? `${QODER_CHAT_BASE_ALT}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
      : `${QODER_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

    const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
    const encodedBodyBuf = Buffer.from(qoderEncodeBody(plainBody), "latin1");

    let cosyHeaders: Record<string, string>;
    try {
      cosyHeaders = buildCosyHeaders(encodedBodyBuf, endpointUrl, {
        userId,
        authToken: accessToken,
        name: String(psd.displayName || resolved?.providerSpecificData?.displayName || ""),
        email: String(psd.email || resolved?.providerSpecificData?.email || ""),
        machineId: String(psd.machineId || ""),
      });
    } catch (err) {
      const error = err as Error;
      throw new Error(`qoder cosy signing failed: ${error.message}`);
    }

    const modelSource =
      (payload.model_config && (payload.model_config as Record<string, unknown>).source) ||
      "system";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Model-Key": qoderKey,
      "X-Model-Source": String(modelSource),
      // gzip triggers signature validation on Qoder's CDN; force identity.
      "Accept-Encoding": "identity",
      ...cosyHeaders,
    };

    // 4. POST.
    let response: Response;
    try {
      response = await fetch(endpointUrl, {
        method: "POST",
        headers,
        body: encodedBodyBuf,
        signal,
      });
    } catch (e: unknown) {
      const error = e as Error;
      if (error.name === "AbortError") {
        throw error;
      }
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: `Qoder COSY fetch error: ${sanitizeErrorMessage(error.message)}`,
              type: "provider_error",
            },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        ),
        url: endpointUrl,
        headers,
        transformedBody: payload,
      };
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {
        // keep empty error text
      }
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: `Qoder COSY request failed with status ${response.status}: ${errText}`,
              type:
                response.status === 401 || response.status === 403
                  ? "authentication_error"
                  : "provider_error",
            },
          }),
          { status: response.status, headers: { "Content-Type": "application/json" } }
        ),
        url: endpointUrl,
        headers,
        transformedBody: payload,
      };
    }

    // 5. Qoder wraps upstream errors inside an HTTP 200 SSE envelope
    // ({statusCodeValue}). Peek the first event; if it's an error, surface a
    // proper HTTP error so combo/account fallback logic can trigger.
    const unwrapped = await unwrapQoderEnvelope(response);
    if (!unwrapped.ok) {
      return { response: unwrapped, url: endpointUrl, headers, transformedBody: payload };
    }

    if (stream) {
      return {
        response: wrapQoderSse(unwrapped, `qoder/${qoderKey}`),
        url: endpointUrl,
        headers,
        transformedBody: payload,
      };
    }

    const text = await collectQoderSseText(unwrapped);
    return {
      response: new Response(JSON.stringify(buildQoderCompletionPayload({ model, text })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: endpointUrl,
      headers,
      transformedBody: payload,
    };
  }

  /**
   * Drive a PAT (`pt-*`) completion through the local qodercli binary. The CLI
   * performs Qoder's WASM-signed Cosy auth internally, so this is the fallback
   * path for PATs when the pure-HTTP Cosy path cannot be built.
   */
  private async executeViaQoderCli({
    model,
    body,
    stream,
    token,
    signal,
  }: {
    model: string;
    body: unknown;
    stream: boolean;
    token: string;
    signal?: AbortSignal | null;
  }): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const url = "qodercli://stdio";
    const prompt = buildQoderPrompt(body);

    const run = await runQoderCli({ token, prompt, stream: false, model, signal });

    // Honor client cancellation the same way the HTTP path does.
    if (signal?.aborted) {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      throw abortError;
    }

    if (run.error && /enoent|not found|no such file|spawn/i.test(run.error)) {
      return {
        response: createQoderErrorResponse({
          status: 502,
          message:
            `Qoder CLI (qodercli) was not found on the OmniRoute host (${run.error}). ` +
            "Install it from https://qoder.com or set CLI_QODER_BIN to its path.",
          code: "cli_not_found",
        }),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    if (!run.ok) {
      return {
        response: createQoderErrorResponse(parseQoderCliFailure(run.stderr, run.stdout)),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    const { text, isError, errorMessage } = parseQoderCliResult(run.stdout);
    if (isError) {
      return {
        response: createQoderErrorResponse(parseQoderCliFailure(errorMessage)),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    if (stream) {
      return {
        response: new Response(buildQoderCliSseStream(model, text), {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    return {
      response: new Response(JSON.stringify(buildQoderCompletionPayload({ model, text })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url,
      headers: {},
      transformedBody: body,
    };
  }
}

export default QoderExecutor;

export const __test__ = {
  unwrapQoderEnvelope,
  truncate,
  normalizeQoderMessages,
  wrapQoderSse,
  buildQoderRequestBody,
  collectQoderSseText,
  resolveQoderModelKey,
};
