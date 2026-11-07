/**
 * Tail normalisation for the outbound message array, extracted from
 * executors/base.ts to keep that file inside its frozen line budget.
 *
 * Order matters: fixToolPairs → (Claude) fixToolAdjacency → re-run fixToolPairs
 * to drop tool_result blocks orphaned by the adjacency strip → strip trailing
 * orphan tool_use → provider-specific trailing strip → per-connection
 * requireUserLastMessage opt-in.
 */

import { isClaudeCodeCompatible } from "./provider.ts";
import {
  fixToolPairs,
  fixToolAdjacency,
  stripTrailingAssistantOrphanToolUse,
  stripTrailingAssistantForProvider,
} from "./contextManager.ts";
import { requiresUserLastMessage, stripTrailingAssistantTurns } from "./assistantPrefill.ts";

type Message = Record<string, unknown>;
type Log = { info?: (tag: string, message: string) => void } | null;

export function normalizeMessageTail(args: {
  messages: Message[];
  provider: string;
  providerSpecificData?: Record<string, unknown>;
  log?: Log;
}): Message[] {
  const { provider, providerSpecificData, log } = args;
  const fixed = fixToolPairs(args.messages);
  // fixToolAdjacency enforces Claude's strict adjacency rule (tool_result must
  // be in immediately next message). Only apply for Claude/Claude-compatible —
  // OpenAI allows results spread across multiple subsequent messages.
  const isClaude = provider === "claude" || isClaudeCodeCompatible(provider);
  // For Claude, fixToolAdjacency may strip tool_use blocks whose tool_result
  // isn't in the next message; re-run fixToolPairs to drop any tool_result
  // orphaned by that strip (discussion #2410).
  const adjacent = isClaude ? fixToolPairs(fixToolAdjacency(fixed)) : fixed;
  const stripped = stripTrailingAssistantOrphanToolUse(adjacent);
  // Some providers (e.g. Mistral) require the last message to be user or tool
  // and reject trailing assistant text messages with 400 (#3396).
  const messages = stripTrailingAssistantForProvider(stripped, provider);
  // Per-connection opt-in for relays that ban assistant prefill.
  if (!requiresUserLastMessage(providerSpecificData)) return messages;
  const userLast = stripTrailingAssistantTurns(messages);
  if (userLast.removedTurns > 0 || userLast.noUserTurn) {
    log?.info?.(
      "PREFILL",
      userLast.noUserTurn
        ? "requireUserLastMessage: no user turn to end on - forwarded unchanged"
        : `requireUserLastMessage: dropped ${userLast.removedTurns} trailing assistant turn(s)`
    );
  }
  return userLast.messages;
}
