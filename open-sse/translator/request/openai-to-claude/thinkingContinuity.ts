/**
 * Signed-thinking continuity for an OpenAI-shaped assistant turn that is being
 * translated to Claude. Extracted from openai-to-claude.ts to keep that file
 * inside its frozen line budget; behaviour unchanged (#5312, #18607, #17324).
 *
 * The client (OpenAI Chat / Responses) never held the signed blocks Claude
 * produced for this tool turn, but claude-to-openai stored them keyed by the
 * tool_use ids. Put each run back where Claude emitted it, only for MANUAL
 * extended thinking (`type:"enabled"`), for the same provider + model +
 * connection, only when the client sent no thinking block of its own, and never
 * for a video-derived request. A fragment that does not carry a run's tool_use
 * skips that run, so a turn the client split into several messages replays every
 * block once. A miss injects nothing.
 *
 * Adaptive-only models (Opus 4.7+/5.x, Fable 5) accept a tool_use turn with NO
 * thinking block at all, but replaying stored signed blocks there breaks
 * Anthropic's warm-cache block-equality whenever the restore hits/misses
 * differently than the turn that warmed the cache (TTL, eviction, completed-turn
 * rewrite) -> 400 "latest assistant message cannot be modified".
 */

import { restoreClaudeThinkingBlocks } from "../../../services/claudeThinkingStore.ts";

type ThinkingBinding = {
  provider?: unknown;
  model?: unknown;
  connectionId?: unknown;
  disabled?: boolean;
  ambiguousToolUseIds?: Set<string>;
};

export function applyAssistantThinkingContinuity(args: {
  blocks: Array<Record<string, unknown>>;
  msg: { reasoning_content?: unknown };
  isKimiCoding: boolean;
  thinkingEnabledForRequest: boolean;
  thinkingTypeForRequest: string;
  binding: ThinkingBinding;
}): void {
  const { blocks, msg, isKimiCoding, thinkingEnabledForRequest, thinkingTypeForRequest, binding } =
    args;
  let hasThinkingBlock = blocks.some(
    (b) => b.type === "thinking" || b.type === "redacted_thinking"
  );
  const hasToolUseBlock = blocks.some((b) => b.type === "tool_use");
  const ownToolUseIds = blocks.filter((b) => b.type === "tool_use").map((b) => String(b.id));
  // A duplicated tool_call id makes the store's entry ambiguous (it may belong to a
  // different generation of this turn); restoring it replays a block the upstream did
  // not see here and it answers 400 "cannot be modified". Skip instead.
  const hasAmbiguousToolUseId = ownToolUseIds.some((id) => binding.ambiguousToolUseIds?.has(id));
  if (
    !isKimiCoding &&
    !binding.disabled &&
    thinkingEnabledForRequest &&
    thinkingTypeForRequest === "enabled" &&
    hasToolUseBlock &&
    !hasThinkingBlock &&
    !hasAmbiguousToolUseId
  ) {
    const restored = restoreClaudeThinkingBlocks({
      toolUseIds: ownToolUseIds,
      provider: binding.provider,
      model: binding.model,
      connectionId: binding.connectionId,
    });
    // Reinsert each stored block at its original distance from the tool_use
    // (counted in non-signed blocks), so [thinking, text, redacted, tool_use]
    // stays in that order instead of collapsing to [thinking, redacted, text, ...].
    // Exact-layout replay: when the store carries the ordering of signed blocks and
    // text lengths for every tool_use in this fragment, rebuild the original block
    // sequence (including text boundaries) instead of injecting at a cursor. Any
    // mismatch (client edited text, split fragments, non-text extras) falls back to
    // the cursor path below.
    const restoredSegments = restored ?? [];
    const segmentById = new Map(restoredSegments.map((segment) => [segment.toolUseId, segment]));
    const ownSegments = ownToolUseIds.map((id) => segmentById.get(id));
    const contentText = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");
    const expectedTextLength = ownSegments.reduce(
      (sum, segment) =>
        sum +
        (segment?.layout ?? []).reduce(
          (segmentSum, token) => segmentSum + (token.kind === "text" ? token.length : 0),
          0
        ),
      0
    );
    const canRebuildLayout =
      ownSegments.every((segment) => segment?.layout != null) &&
      blocks.every((b) => b.type === "text" || b.type === "tool_use") &&
      expectedTextLength === contentText.length;
    if (canRebuildLayout) {
      const rebuilt: Array<Record<string, unknown>> = [];
      let offset = 0;
      for (const block of blocks) {
        if (block.type === "text") continue;
        const segment = segmentById.get(String(block.id));
        for (const token of segment?.layout ?? []) {
          if (token.kind === "signed") {
            rebuilt.push({ ...token.block });
          } else if (token.length > 0) {
            rebuilt.push({ type: "text", text: contentText.slice(offset, offset + token.length) });
            offset += token.length;
          }
        }
        rebuilt.push(block);
      }
      if (offset === contentText.length) {
        blocks.length = 0;
        blocks.push(...rebuilt);
        hasThinkingBlock = true;
      }
    } else {
      let cursor = 0;
      for (const { toolUseId, blocks: signed, gaps } of restoredSegments) {
        const owner = blocks.findIndex(
          (b, i) => i >= cursor && b.type === "tool_use" && b.id === toolUseId
        );
        if (owner < 0) continue;
        for (let i = 0; i < signed.length; i++) {
          const gap = typeof gaps?.[i] === "number" && gaps[i] >= 0 ? gaps[i] : 0;
          const at = Math.min(blocks.length, cursor + gap);
          blocks.splice(at, 0, signed[i]);
          cursor = at + 1;
          hasThinkingBlock = true;
        }
        cursor = Math.max(cursor, owner + signed.length + 1);
      }
    }
  }
  if (isKimiCoding && typeof msg.reasoning_content === "string" && !hasThinkingBlock) {
    blocks.unshift({ type: "thinking", thinking: msg.reasoning_content });
  }
}
