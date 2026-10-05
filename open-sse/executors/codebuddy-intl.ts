import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { DefaultExecutor } from "./default.ts";
import type { ExecuteInput, ExecutorExecuteResult, ProviderCredentials } from "./base.ts";

const LARGE_TOOL_METADATA_BYTES = 64 * 1024;
const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
// Ported from OmniRoute release/v3.8.52's CN executor; scoped to International.
const AGENT_PATTERN =
  /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function neutralizeAgentPrompt(content: unknown): unknown {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
            .join("\n")
        : "";
  if (!text || (text.length <= 2000 && !AGENT_PATTERN.test(text))) return content;
  // Preserve string-vs-blocks shape for BOTH message and top-level system fields.
  return typeof content === "string" ? NEUTRAL_PROMPT : [{ type: "text", text: NEUTRAL_PROMPT }];
}

function compactToolDescriptions(body: unknown, onlyOversized: boolean): JsonRecord | null {
  if (!isRecord(body) || !Array.isArray(body.tools) || body.tools.length === 0) return null;
  if (onlyOversized) {
    try {
      if (
        new TextEncoder().encode(JSON.stringify(body.tools)).byteLength < LARGE_TOOL_METADATA_BYTES
      ) {
        return null;
      }
    } catch {
      // Leave malformed/circular inputs to the normal executor validation path.
      return null;
    }
  }
  let changed = false;
  const tools = body.tools.map((tool) => {
    if (
      !isRecord(tool) ||
      tool.type !== "function" ||
      !isRecord(tool.function) ||
      !Object.prototype.hasOwnProperty.call(tool.function, "description")
    )
      return tool;
    const compactFunction = { ...tool.function };
    delete compactFunction.description;
    changed = true;
    return { ...tool, function: compactFunction };
  });
  return changed ? { ...body, tools } : null;
}

function responseFromResult(result: ExecutorExecuteResult): Response {
  return result instanceof Response ? result : result.response;
}

function credentialsFromResult(
  result: ExecutorExecuteResult,
  fallback: ProviderCredentials
): ProviderCredentials {
  if (result instanceof Response || !result.headers) return fallback;
  const authorization = Object.entries(result.headers).find(
    ([name]) => name.toLowerCase() === "authorization"
  )?.[1];
  if (!authorization?.startsWith("Bearer ")) return fallback;
  // Keep any proactively refreshed bearer token for the one-shot retry.
  return { ...fallback, accessToken: authorization.slice("Bearer ".length), expiresAt: undefined };
}

function bodyFromResult(result: ExecutorExecuteResult, fallback: unknown): unknown {
  if (result instanceof Response || result.transformedBody === undefined) return fallback;
  if (typeof result.transformedBody !== "string") return result.transformedBody;
  try {
    return JSON.parse(result.transformedBody);
  } catch {
    return fallback;
  }
}

async function isSensitiveContentRejection(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  // More tolerant than the upstream CN literal: generic 400 "sensitive" phrasing
  // and Chinese sensitive-content wording also occur across gateway versions.
  return /sensitive|敏感内容/i.test(text);
}

/**
 * International gateway port from decolua/9router, with CN stream/reasoning
 * semantics and release/v3.8.52 prompt/tool robustness. Authenticated intl chat
 * is NOT live-verified yet: the implementation is covered by mocked wire tests.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (!isRecord(transformed)) return transformed;
    const out = { ...transformed };
    // Our CN semantics: gateway is stream-only; chatCore aggregates for JSON clients.
    out.stream = true;
    const effort = out.reasoning_effort;
    if (effort === "none" || effort === "off") {
      delete out.reasoning_effort;
    } else if (effort) {
      out.reasoning_summary = "auto";
    }

    // CN release/v3.8.52 agent identity neutralization, without changing CN behavior.
    if (out.system !== undefined) out.system = neutralizeAgentPrompt(out.system);
    const messages: unknown[] = Array.isArray(out.messages)
      ? out.messages.map((message) => {
          if (!isRecord(message)) return message;
          if (message.role === "system")
            return { ...message, content: neutralizeAgentPrompt(message.content) };
          if (message.role === "user" && typeof message.content === "string") {
            return { ...message, content: [{ type: "text", text: message.content }] };
          }
          return { ...message };
        })
      : [];

    // 9router intl normalization, but NOT its lossy system/developer filtering
    // (9router #3357/#4450). Move an existing system message to the front, keeping
    // all caller messages; synthesize the IDE default only if none was supplied.
    const systemIndex = messages.findIndex(
      (message) => isRecord(message) && message.role === "system"
    );
    if (systemIndex > 0) {
      messages.unshift(...messages.splice(systemIndex, 1));
    } else if (systemIndex < 0) {
      messages.unshift({ role: "system", content: out.system ?? "You are CodeBuddy Code." });
    }
    out.messages = messages;

    // CN release/v3.8.52: strip descriptions at >=64KB of UTF-8 tool metadata.
    return compactToolDescriptions(out, true) ?? out;
  }

  parseError(
    response: Response,
    bodyText: string
  ): { status: number; message: string; resetsAtMs?: number | null } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
    const data = isRecord(parsed) ? parsed : {};
    const error = isRecord(data.error) ? data.error : {};
    const code = data.code ?? error.code;
    const rawMessage = [data.msg, data.message, error.message].find(
      (message) => typeof message === "string"
    ) as string | undefined;
    const message = rawMessage ?? (response.ok ? "" : bodyText);
    // 9router International's 6004/frequency-limit classification and UTC+8 default.
    if (
      code === 6004 ||
      code === "6004" ||
      /超出频率限制|frequency.?limit|rate.?limit|限额/i.test(message)
    ) {
      let resetsAtMs: number | null = null;
      const match = message.match(
        /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*UTC([+-]?\d{1,2}(?::\d{2})?)|([+-]\d{2}:\d{2}|Z))?/i
      );
      if (match) {
        let zone = match[4] ?? "+08:00";
        if (match[3]) {
          const [hours, minutes = "00"] = match[3].replace(/^[+-]/, "").split(":");
          zone = `${match[3].startsWith("-") ? "-" : "+"}${hours.padStart(2, "0")}:${minutes}`;
        }
        const timestamp = Date.parse(`${match[1]}T${match[2]}${zone}`);
        if (Number.isFinite(timestamp)) resetsAtMs = timestamp;
      }
      return {
        status: 429,
        message: sanitizeErrorMessage(rawMessage || "CodeBuddy frequency limit (6004)"),
        resetsAtMs,
      };
    }
    const fallback = super.parseError(response, bodyText);
    return { ...fallback, message: sanitizeErrorMessage(fallback.message) };
  }

  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    let result = await super.execute(input);
    if (!input.signal?.aborted && (await isSensitiveContentRejection(responseFromResult(result)))) {
      // Proactive stripping already handles large payloads. Compact the ACTUAL
      // submitted tools for a single sensitive-content retry (also smaller tools)
      // so this never retries an identical, already-compacted body.
      const compactBody = compactToolDescriptions(bodyFromResult(result, input.body), false);
      if (compactBody) {
        input.log?.debug?.(
          "CODEBUDDY_INTL",
          "Sensitive-content rejection; retrying once with compact tool descriptions"
        );
        result = await super.execute({
          ...input,
          body: compactBody,
          credentials: credentialsFromResult(result, input.credentials),
        });
      }
    }
    const response = responseFromResult(result);
    // BaseExecutor.parseError is only used by countTokens; chatCore calls
    // parseUpstreamError instead. Normalize here, carrying the parsed reset via
    // Retry-After (the existing chatCore/account-fallback hook), without editing
    // shared error parsing. Never buffer a successful SSE stream.
    if (response.ok && !response.headers.get("content-type")?.includes("application/json"))
      return result;
    const text = await response
      .clone()
      .text()
      .catch(() => "");
    const parsedError = this.parseError(response, text);
    if (parsedError.status !== 429) return result;
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/json");
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (parsedError.resetsAtMs !== null && parsedError.resetsAtMs !== undefined) {
      headers.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((parsedError.resetsAtMs - Date.now()) / 1000)))
      );
    }
    const normalized = new Response(JSON.stringify(buildErrorBody(429, parsedError.message)), {
      status: 429,
      headers,
    });
    return result instanceof Response ? normalized : { ...result, response: normalized };
  }
}

export default CodeBuddyIntlExecutor;
