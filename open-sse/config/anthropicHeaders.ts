import {
  CLAUDE_CODE_CLIENT_BILLING_VERSION,
  CLAUDE_CODE_CLIENT_BUILD_REVISION,
  CLAUDE_CODE_CLIENT_VERSION,
  CLAUDE_CODE_RUNTIME_VERSION,
  CLAUDE_CODE_SDK_PACKAGE_VERSION,
  getClaudeCodeClientBillingVersion,
  getClaudeCodeClientVersion,
  getClaudeCodeUserAgent,
} from "@/shared/constants/claudeCodeClient";

export const ANTHROPIC_VERSION_HEADER = "2023-06-01";

const ANTHROPIC_BETA_BASE = Object.freeze([
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
  "advisor-tool-2026-03-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
  // Required by the code_execution tool; the skills beta next to it is
  // injected per-request only (see SKILLS_BETA_HEADER / #14200).
  "code-execution-2025-08-25",
]);

const CLAUDE_OAUTH_EXTRA_BETAS = Object.freeze(["fine-grained-tool-streaming-2025-05-14"]);

export const ANTHROPIC_BETA_FULL = ANTHROPIC_BETA_BASE.join(",");
export const ANTHROPIC_BETA_API_KEY = ANTHROPIC_BETA_BASE.filter(
  (beta) => beta !== "oauth-2025-04-20"
).join(",");
export const ANTHROPIC_BETA_CLAUDE_OAUTH = [
  ...ANTHROPIC_BETA_BASE.slice(0, 3),
  ...CLAUDE_OAUTH_EXTRA_BETAS,
  ...ANTHROPIC_BETA_BASE.slice(3),
].join(",");

/**
 * Anthropic Skills beta flag. Must only be emitted when a code_execution tool
 * is declared in the request body; sending it on tool-less requests makes
 * upstream Anthropic reject with HTTP 400 (#14200).
 */
export const SKILLS_BETA_HEADER = "skills-2025-10-02";

/** Append a beta token to an existing anthropic-beta header, deduplicating. */
export function appendAnthropicBetaHeader(
  headers: Record<string, string>,
  betaHeader: string
): void {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "anthropic-beta");
  if (!existingKey) {
    headers["anthropic-beta"] = betaHeader;
    return;
  }

  const existingValues = String(headers[existingKey] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!existingValues.includes(betaHeader)) {
    headers[existingKey] = [...existingValues, betaHeader].join(",");
  }
}

/** Remove a beta token from an existing anthropic-beta header. */
export function removeAnthropicBetaHeader(
  headers: Record<string, string>,
  betaHeader: string
): void {
  if (!headers || typeof headers !== "object") return;
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "anthropic-beta");
  if (!existingKey) return;

  const existingValues = String(headers[existingKey] || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== betaHeader);

  if (existingValues.length > 0) {
    headers[existingKey] = existingValues.join(",");
  } else {
    delete headers[existingKey];
  }
}

/** Detect whether a request body declares an Anthropic code_execution tool. */
export function hasCodeExecutionTool(body: unknown): boolean {
  if (!body) return false;
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== "object") return false;
  const tools = (parsed as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const t = tool as { type?: unknown; name?: unknown; function?: { name?: unknown } };
    if (
      typeof t.type === "string" &&
      (t.type === "code_execution" || t.type.startsWith("code_execution_"))
    ) {
      return true;
    }
    if (t.name === "code_execution") return true;
    if (t.type === "function" && t.function && t.function.name === "code_execution") return true;
    return false;
  });
}

function isAnthropicFamilyProvider(
  provider: string | undefined | null,
  extraCondition: boolean
): boolean {
  const p = typeof provider === "string" ? provider : "";
  return (
    p === "anthropic" || p === "claude" || p.startsWith("anthropic-compatible-") || extraCondition
  );
}

/** Append the Skills beta only when the body actually declares code_execution. */
export function maybeAppendSkillsBeta(
  headers: Record<string, string>,
  provider: string | undefined | null,
  body: unknown,
  extraCondition = false
): void {
  if (!headers || typeof headers !== "object") return;
  if (!hasCodeExecutionTool(body)) return;
  if (isAnthropicFamilyProvider(provider, extraCondition)) {
    appendAnthropicBetaHeader(headers, SKILLS_BETA_HEADER);
  }
}

/**
 * Synchronize the Skills beta with the finalized request body: add it when a
 * code_execution tool survived transformation, strip it when tools were
 * stripped or rewritten away (#14200).
 */
export function syncSkillsBeta(
  headers: Record<string, string>,
  provider: string | undefined | null,
  body: unknown,
  extraCondition = false
): void {
  if (!headers || typeof headers !== "object") return;
  if (!isAnthropicFamilyProvider(provider, extraCondition)) return;

  if (hasCodeExecutionTool(body)) {
    appendAnthropicBetaHeader(headers, SKILLS_BETA_HEADER);
  } else {
    removeAnthropicBetaHeader(headers, SKILLS_BETA_HEADER);
  }
}

/**
 * Client-negotiated `anthropic-beta` values that are safe to forward to the
 * claude.ai backend on top of OmniRoute's own set. Kept to betas the backend
 * actually accepts and that OmniRoute does not otherwise emit — so a blind
 * passthrough cannot reintroduce the over-sending fingerprint/rejection bugs
 * (#3415, #2454). Currently: deferred-tool negotiation (#3974) and the
 * client's own `[1m]` long-context negotiation (context-1m). selectBetaFlags
 * deliberately emits context-1m only for Opus (never FORCE it — long-context
 * credit gate); forwarding it when the CLIENT negotiated it matches what real
 * Claude Code sends for `/model <id>[1m]` and is required for >200K-context
 * requests on models/accounts where the beta is enforced.
 */
export const FORWARDABLE_CLIENT_BETAS = Object.freeze([
  "tool-search-tool-2025-10-19",
  "context-1m-2025-08-07",
  "per-turn-control-2026-07-01",
  "effort-2025-11-24",
  "mid-conversation-output-config-2026-07-01",
  "fast-mode-2026-02-01",
  "server-side-fallback-2026-06-01",
  "server-side-fallback-2026-07-01",
  "timing-2026-09-09",
  "inline-tools-2026-09-15",
  "thinking-binding-controls-2026-08-01",
  "thinking-display-updates-2026-08-18",
  "skills-2025-10-02",
]);

/** Anthropic beta that admits `role: "system"` turns inside `messages[]`. */
export const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";

/** Whether a Claude body still carries a system-role turn inside `messages[]`. */
export function hasMidConversationSystemTurn(body: unknown): boolean {
  const messages = (body as Record<string, unknown> | null | undefined)?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    const role = (message as Record<string, unknown> | null)?.role;
    return typeof role === "string" && role.toLowerCase() === "system";
  });
}

/**
 * Union an `anthropic-beta` comma-list with the allowlisted client-negotiated
 * betas, preserving base order and appending only NEW tokens (deduped,
 * case-insensitive). The client beta is added only if it is on `allow`, so this
 * never forces betas the client did not request nor leaks betas the backend
 * rejects. See #3974 (tool-search-tool dropped on the Claude OAuth path).
 */
export function mergeClientAnthropicBeta(
  base: string,
  clientBeta: string | null | undefined,
  allow: readonly string[] = FORWARDABLE_CLIENT_BETAS,
  _model?: string | null,
  body?: unknown
): string {
  const baseList = base
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (typeof clientBeta !== "string" || !clientBeta.trim()) return baseList.join(",");
  const seen = new Set(baseList.map((s) => s.toLowerCase()));
  const allowSet = new Set(allow.map((s) => s.toLowerCase()));
  for (const token of clientBeta
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const lower = token.toLowerCase();
    // Skills beta is passthrough-inert unless the body still declares a
    // code_execution tool; forwarding it on tool-less requests 400s upstream (#14200).
    if (
      lower === SKILLS_BETA_HEADER &&
      body !== undefined &&
      body !== null &&
      !hasCodeExecutionTool(body)
    ) {
      continue;
    }
    if (allowSet.has(lower) && !seen.has(lower)) {
      baseList.push(token);
      seen.add(lower);
    }
  }
  return baseList.join(",");
}

/**
 * Collapse a list of comma-list header values into a deduped, trimmed token
 * array. Empty/undefined/null entries are dropped. Used to reconcile the
 * case-variant `anthropic-version` / `anthropic-beta` headers below.
 */
function uniqueCommaValues(values: Array<string | undefined | null>): string[] {
  return [
    ...new Set(
      values
        .filter((value) => value !== undefined && value !== null && value !== "")
        .flatMap((value) => String(value).split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Dedupe case-variant Anthropic headers in-place. Node/undici's fetch merges
 * `anthropic-version` and `Anthropic-Version` into a single `"v, v"` value,
 * which the Anthropic API rejects (#1475). Collapse both case variants down to
 * one canonical lowercase header carrying a single value. Same for
 * `anthropic-beta` (joined comma-list, deduped). Mutates `headers`.
 */
export function normalizeAnthropicHeaderVariants(headers: Record<string, string>): void {
  // Only collapse when BOTH case variants are present simultaneously — that is the
  // only situation undici merges into a rejected `"v, v"` value. A lone variant is
  // sent fine on its own, so leave it untouched (preserving the caller's casing
  // instead of silently rewriting it to lowercase).
  if ("anthropic-version" in headers && "Anthropic-Version" in headers) {
    const versionValues = uniqueCommaValues([
      headers["anthropic-version"],
      headers["Anthropic-Version"],
    ]);
    delete headers["Anthropic-Version"];
    delete headers["anthropic-version"];
    if (versionValues.length > 0) {
      headers["anthropic-version"] = versionValues[0];
    }
  }

  if ("anthropic-beta" in headers && "Anthropic-Beta" in headers) {
    const betaValues = uniqueCommaValues([headers["anthropic-beta"], headers["Anthropic-Beta"]]);
    delete headers["Anthropic-Beta"];
    delete headers["anthropic-beta"];
    if (betaValues.length > 0) {
      headers["anthropic-beta"] = betaValues.join(",");
    }
  }
}

export const CLAUDE_CLI_VERSION = CLAUDE_CODE_CLIENT_VERSION;
export function getClaudeCliVersion(): string {
  return getClaudeCodeClientVersion();
}
export const CLAUDE_CLI_BUILD_REVISION = CLAUDE_CODE_CLIENT_BUILD_REVISION;
/** Captured-pin snapshot. Wire billing uses getClaudeCliBillingVersion(). */
export const CLAUDE_CLI_BILLING_VERSION = CLAUDE_CODE_CLIENT_BILLING_VERSION;
export function getClaudeCliBillingVersion(): string {
  return getClaudeCodeClientBillingVersion();
}
/** Module-load snapshot of the pin (or env if set before import). Wire UA uses getClaudeCodeUserAgent(). */
export const CLAUDE_CLI_USER_AGENT = getClaudeCodeUserAgent("cli");
export { getClaudeCodeUserAgent };
export const CLAUDE_CLI_STAINLESS_PACKAGE_VERSION = CLAUDE_CODE_SDK_PACKAGE_VERSION;
export const CLAUDE_CLI_STAINLESS_RUNTIME_VERSION = CLAUDE_CODE_RUNTIME_VERSION;
