import { FORMATS } from "../../translator/formats.ts";
import { isClaudeCodeCompatibleProvider } from "../../services/claudeCodeCompatible.ts";
import { downgradeRestoredClaudeThinking } from "../../services/claudeThinkingStore.ts";
import {
  disableManualThinkingWithoutFinalBlock,
  type ClaudeRequestBody,
} from "../../translator/helpers/claudeHelper.ts";
import { getModelTargetFormat } from "../../config/providerModels.ts";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.ts";
import { isResponsesEndpointPath } from "../../utils/responsesEndpoint.ts";
import { mergeClientAnthropicBeta } from "../../config/anthropicHeaders.ts";
import { getHeaderValueCaseInsensitive } from "./headers.ts";

export function shouldUseNativeCodexPassthrough({
  provider,
  sourceFormat,
  endpointPath,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  endpointPath?: string | null;
}): boolean {
  if (provider !== "codex") return false;
  if (sourceFormat !== FORMATS.OPENAI_RESPONSES) return false;
  let normalizedEndpoint = String(endpointPath || "");
  while (normalizedEndpoint.endsWith("/")) normalizedEndpoint = normalizedEndpoint.slice(0, -1);
  const segments = normalizedEndpoint.split("/");
  return segments.includes("responses");
}

/**
 * Pass `thinking` / `redacted_thinking` blocks through UNCHANGED.
 *
 * This used to rewrite every assistant thinking block to `redacted_thinking`
 * carrying a synthetic signature, on the assumption that a thinking signature is
 * bound to the auth token that produced it and would be rejected after a token /
 * model switch with 400 "Invalid signature in thinking block" (issue #2454).
 *
 * That rewrite is the actual cause of a different, far more common failure on the
 * Anthropic-native Claude OAuth passthrough:
 *
 *   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
 *   latest assistant message cannot be modified. These blocks must remain as
 *   they were in the original response.
 *
 * The Messages API validates submitted thinking blocks against the original
 * response and rejects ANY modification — so converting them to
 * `redacted_thinking` makes every multi-turn request with thinking fail (most
 * visible on long Claude Code tool-loops). The thinking-block signature is
 * validated server-side by Anthropic and stays valid when the blocks are replayed,
 * including under a different OAuth token — verified by preserving the blocks
 * across a mid-conversation account switch with zero "Invalid signature"
 * responses. The redaction is therefore both unnecessary and the cause of the
 * regression, so the blocks are now returned verbatim. The `signature` parameter
 * is kept for call-site compatibility.
 */
export function redactPassthroughThinkingSignatures(
  messages: unknown,
  _signature?: string
): unknown {
  return messages;
}

type MessageLike = {
  role?: unknown;
  content?: unknown;
};

type ThinkingSignatureError = {
  provider?: string | null;
  model?: string | null;
  status?: number | null;
  message?: string | null;
};

function isThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function hasBlock(message: MessageLike | null | undefined, type: string): boolean {
  return (
    !!message &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) => !!block && typeof block === "object" && (block as { type?: unknown }).type === type
    )
  );
}

/**
 * Match only the Anthropic validation failure this recovery path understands.
 * Generic 400s and the separate "latest assistant message cannot be modified"
 * validation error must continue through the normal error path unchanged.
 */
export function isAnthropicThinkingSignatureError({
  provider,
  model,
  status,
  message,
}: ThinkingSignatureError): boolean {
  // Same upstream set that prepareClaudeRequest treats as signature-validating: Anthropic
  // itself, Vertex Claude, and any registry model whose targetFormat is "claude" (GitHub
  // Copilot claude-*, opencode-go claude-target models, ...).
  const isAnthropicTarget =
    provider === "claude" ||
    provider === "vertex" ||
    provider === "vertex-partner" ||
    (typeof provider === "string" && provider.startsWith("anthropic-compatible-")) ||
    (!!provider && !!model && getModelTargetFormat(provider, model) === "claude");
  if (!isAnthropicTarget || status !== 400 || typeof message !== "string") return false;

  return /invalid\s+[`'\"]?signature[`'\"]?\s+in\s+[`'\"]?thinking[`'\"]?\s+block/i.test(message);
}

/**
 * Match the other Anthropic thinking-block validation failure, which names
 * the LATEST assistant message specifically rather than a stale signature:
 *
 *   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in
 *   the latest assistant message cannot be modified. These blocks must
 *   remain as they were in the original response.
 *
 * This fires when the thinking/redacted_thinking block OmniRoute replayed
 * for the latest turn is not a faithful copy of what Anthropic actually
 * produced for it — most commonly because the upstream stream for that turn
 * was cut short (e.g. a `content_filter` stop mid-stream, #17324) before a
 * complete, replayable signed block could be captured, so the block OmniRoute
 * has on file (or the client resent) no longer matches. Unlike
 * {@link isAnthropicThinkingSignatureError}, stripping HISTORICAL thinking
 * cannot help here — the rejected block is in the message the error names,
 * not an earlier one — so this uses its own targeted recovery
 * ({@link stripLatestAssistantThinkingForModifiedRecovery}).
 */
export function isAnthropicThinkingModifiedError({
  provider,
  status,
  message,
}: ThinkingSignatureError): boolean {
  const isAnthropicTarget =
    provider === "claude" ||
    (typeof provider === "string" && provider.startsWith("anthropic-compatible-"));
  if (!isAnthropicTarget || status !== 400 || typeof message !== "string") return false;

  return /[`'\"]?thinking[`'\"]?\s+or\s+[`'\"]?redacted_thinking[`'\"]?\s+blocks\s+in\s+the\s+latest\s+assistant\s+message\s+cannot\s+be\s+modified/i.test(
    message
  );
}

function isManualExtendedThinking(record: Record<string, unknown>): boolean {
  const thinking = record.thinking as { type?: unknown } | null | undefined;
  return thinking?.type === "enabled";
}

function hasNoSafeThinkingRecovery(content: unknown[]): boolean {
  if (content.every(isThinkingBlock)) return true;
  if (!hasBlock({ content }, "tool_use")) return false;
  const first = content[0] as Record<string, unknown> | null;
  if (!first || typeof first !== "object" || Object.keys(first).length !== 2) return false;
  return (
    first.type === "redacted_thinking" &&
    first.data === DEFAULT_THINKING_CLAUDE_SIGNATURE &&
    content.slice(1).every((block) => !isThinkingBlock(block))
  );
}

/**
 * Build a one-shot recovery body after Anthropic rejected the thinking block
 * of the LATEST assistant message as modified (see
 * {@link isAnthropicThinkingModifiedError}). Only that one message is
 * touched: a block this store restored is dropped (forgotten); any other
 * thinking block left in that message — never restored by this store, so
 * either sent by the client or produced by a filtered/truncated upstream
 * turn OmniRoute could not capture faithfully — is dropped outright, since
 * it cannot be resent regardless of how it became unreplayable. A `tool_use`
 * left in the same message stays without a precursor thinking block: that is
 * a valid Anthropic request shape (#17324/#17344 — re-injecting the
 * fabricated placeholder re-triggers the same 400). Earlier assistant turns
 * also drop store-restored blocks: Anthropic flags the modified message by
 * cache warmth, not recency (#17324 recurrence 2026-10-27). Returns the
 * original body reference when there is nothing safe to recover.
 */
export function stripLatestAssistantThinkingForModifiedRecovery<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return body;

  const messages = record.messages as MessageLike[];
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role !== "assistant") index -= 1;
  if (index < 0) return body;

  // #17324 recurrence (2026-10-27): Anthropic flags the message by cache-warmth, not
  // recency — live 400s pointed at messages.1/messages.3 while the LATEST assistant
  // message was clean, so the strip no-oped and the request failed with
  // recoveryAttempted:false. Drop server-restored (store-provenance) thinking blocks
  // from EVERY assistant turn; they are blocks the client never sent, so removing
  // them is always a legal fallback shape on adaptive thinking. The latest assistant
  // message additionally drops any non-restored thinking block (unchanged behavior).
  const manualThinking = isManualExtendedThinking(record);
  let changed = false;
  const recoveredMessages = messages.map((message) => {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    const isLatestAssistant = message === messages[index];
    if (!message.content.some(isThinkingBlock)) return message;

    if (isLatestAssistant) {
      // Dropping every block would create an invalid empty assistant message.
      // Keep the original failure when there is no safe content to retry.
      if (hasNoSafeThinkingRecovery(message.content)) return message;
      // Manual extended thinking requires the latest assistant tool_use turn to open
      // with a thinking block: dropping it would trade this 400 for "expected thinking
      // ... found tool_use", and the fabricated placeholder re-triggers this same 400.
      // Keep the original failure instead of retrying (only adaptive verified live).
      if (manualThinking && hasBlock(message, "tool_use")) return message;
      const downgraded = downgradeRestoredClaudeThinking(message.content);
      const base = (downgraded ?? message.content) as unknown[];
      const content = base.filter((block) => !isThinkingBlock(block));
      if (content.length === base.length && base === message.content) return message;
      changed = true;
      return { ...message, content: content as typeof message.content };
    }

    // Inject nothing on earlier turns either (#18036): only the final tool_use turn needs
    // a precursor under manual thinking, and the guard above keeps that one intact.
    const downgraded = downgradeRestoredClaudeThinking(message.content);
    if (downgraded) {
      changed = true;
      return { ...message, content: downgraded as typeof message.content };
    }
    return message;
  });

  if (!changed) return body;
  const recovered = { ...record, messages: recoveredMessages } as ClaudeRequestBody;
  disableManualThinkingWithoutFinalBlock(recovered);
  return recovered as T;
}

/**
 * Build a one-shot recovery body after Anthropic has explicitly rejected a
 * thinking signature. Historical thinking blocks are omitted, but the complete
 * active tool-use cycle is preserved verbatim: when the request ends in one or
 * more `user[tool_result]` turns, every paired assistant `tool_use` turn in that
 * still-open cycle keeps its thinking blocks. A trailing unresolved assistant
 * `tool_use` turn is protected as well. The one exception inside that cycle is a
 * block OmniRoute itself restored from claudeThinkingStore (the client never sent
 * it): it is dropped and forgotten, so a rejected restored signature is still
 * recoverable. Manual thinking is disabled if that leaves the final tool turn bare.
 *
 * This helper is intentionally NOT used eagerly. Normal same-model requests must
 * retain their thinking history, cache shape, and current-model semantics.
 * Returns the original body reference when no safe recovery change is possible.
 */
export function stripHistoricalThinkingForSignatureRecovery<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return body;

  const messages = record.messages as MessageLike[];
  const protectedAssistantIndexes = new Set<number>();
  let cursor = messages.length - 1;

  // Some internal callers can resume from an unresolved assistant tool_use.
  if (
    cursor >= 0 &&
    messages[cursor]?.role === "assistant" &&
    hasBlock(messages[cursor], "tool_use")
  ) {
    protectedAssistantIndexes.add(cursor);
    cursor -= 1;
  }

  // Walk the complete trailing tool-result chain. Interleaved thinking can span
  // several assistant/tool_result pairs, so protecting only the latest assistant
  // message is insufficient.
  while (
    cursor >= 0 &&
    messages[cursor]?.role === "user" &&
    hasBlock(messages[cursor], "tool_result")
  ) {
    cursor -= 1;
    while (cursor >= 0 && messages[cursor]?.role !== "assistant") cursor -= 1;
    if (cursor < 0 || !hasBlock(messages[cursor], "tool_use")) break;
    protectedAssistantIndexes.add(cursor);
    cursor -= 1;
  }

  let changed = false;
  const recoveredMessages = messages.map((message, index) => {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    if (protectedAssistantIndexes.has(index)) {
      const downgraded = downgradeRestoredClaudeThinking(message.content);
      if (!downgraded) return message;
      changed = true;
      return { ...message, content: downgraded as typeof message.content };
    }

    const content = message.content.filter((block) => !isThinkingBlock(block));
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content };
  });

  if (!changed) return body;
  const recovered = { ...record, messages: recoveredMessages } as ClaudeRequestBody;
  disableManualThinkingWithoutFinalBlock(recovered);
  return recovered as T;
}

type SignatureRecoveryExecution<T> = {
  result: T;
  retried: boolean;
  recoveryBody: unknown | null;
};

/** Execute the normal body once, then perform at most one exact-error recovery. */
export async function executeWithAnthropicThinkingSignatureRecovery<T>(args: {
  provider?: string | null;
  model?: string | null;
  body: unknown;
  execute: (body: unknown) => Promise<T>;
  getError: (
    result: T
  ) =>
    | { status?: number | null; message?: string | null }
    | null
    | Promise<{ status?: number | null; message?: string | null } | null>;
}): Promise<SignatureRecoveryExecution<T>> {
  const first = await args.execute(args.body);
  const failure = await args.getError(first);
  if (!failure) {
    return { result: first, retried: false, recoveryBody: null };
  }

  const errorArgs = {
    provider: args.provider,
    model: args.model,
    status: failure.status,
    message: failure.message,
  };
  let recoveryBody: unknown;
  if (isAnthropicThinkingSignatureError(errorArgs)) {
    recoveryBody = stripHistoricalThinkingForSignatureRecovery(args.body);
  } else if (isAnthropicThinkingModifiedError(errorArgs)) {
    recoveryBody = stripLatestAssistantThinkingForModifiedRecovery(args.body);
  } else {
    return { result: first, retried: false, recoveryBody: null };
  }
  if (recoveryBody === args.body) {
    return { result: first, retried: false, recoveryBody: null };
  }

  return {
    result: await args.execute(recoveryBody),
    retried: true,
    recoveryBody,
  };
}

export function isClaudeCodeSemanticPassthroughRequest({
  provider,
  sourceFormat,
  targetFormat,
  headers,
  userAgent,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  headers?: Record<string, unknown> | Headers | null;
  userAgent?: string | null;
}): boolean {
  const isDirectClaudeCodeProvider =
    provider === "claude" || isClaudeCodeCompatibleProvider(provider);
  if (!isDirectClaudeCodeProvider) return false;
  if (sourceFormat !== FORMATS.CLAUDE) return false;
  if (targetFormat !== FORMATS.CLAUDE) return false;

  const headerUserAgent = getHeaderValueCaseInsensitive(headers, "user-agent");
  const ua = `${userAgent || ""} ${headerUserAgent || ""}`.toLowerCase();
  if (ua.includes("claude-code") || ua.includes("claude-cli")) return true;

  const appHeader = getHeaderValueCaseInsensitive(headers, "x-app");
  if (typeof appHeader === "string" && appHeader.trim().toLowerCase() === "cli") return true;

  const sessionId = getHeaderValueCaseInsensitive(headers, "x-claude-code-session-id");
  return typeof sessionId === "string" && sessionId.trim().length > 0;
}
