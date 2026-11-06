import { sanitizeToolId } from "../translator/helpers/schemaCoercion.ts";
import { sanitizeToolResultId } from "../translator/request/openai-to-claude/sanitizeToolResultId.ts";
import { collectClaudeMediaBlocks } from "./ccOpenAiMediaBlocks.ts";

export type CompatibleMessageLike = {
  role?: string;
  content?: unknown;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          return record.text.trim();
        }
        if (typeof record.text === "string") {
          return record.text.trim();
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
  }

  return "";
}

// #15229: OpenAI tool loops carry the assistant's calls as `tool_calls` and the
// results as `role:"tool"` messages. The CC bridge used to drop both, so the
// upstream re-saw turn 1 on every turn and the loop never converged (silent
// 200-OK stall). Same shapes the openai-to-claude translator accepts.
export function collectToolUseBlocks(message: CompatibleMessageLike | null | undefined) {
  const rawCalls = (message as Record<string, unknown> | null | undefined)?.tool_calls;
  if (!Array.isArray(rawCalls)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const call of rawCalls) {
    const record = readRecord(call);
    if (!record) continue;
    const fn = readRecord(record.function);
    if (!fn) continue;
    const name = toNonEmptyString(fn.name);
    if (!name) continue;
    let input: unknown = {};
    const rawArguments = fn.arguments;
    if (typeof rawArguments === "string" && rawArguments.trim()) {
      try {
        input = JSON.parse(rawArguments);
      } catch {
        input = {};
      }
    } else if (readRecord(rawArguments)) {
      input = rawArguments;
    }
    blocks.push({
      type: "tool_use",
      id: sanitizeToolId(typeof record.id === "string" ? record.id : String(record.id ?? "")),
      name,
      input,
    });
  }
  return blocks;
}

export function convertClaudeCodeCompatibleMessage(
  message: CompatibleMessageLike | null | undefined
) {
  const rawRole = String(message?.role || "").toLowerCase();
  const role =
    rawRole === "user"
      ? "user"
      : rawRole === "assistant" || rawRole === "model"
        ? "assistant"
        : null;

  // #15229: a tool result becomes a user tool_result turn. Results without a
  // usable id are skipped (never fabricated — they could never pair with a
  // tool_use and Anthropic would refuse the orphan).
  if (!role && rawRole === "tool") {
    const toolUseId = sanitizeToolResultId(
      (message as Record<string, unknown> | null | undefined)?.tool_call_id
    );
    if (!toolUseId) return null;
    const text = contentToText(message?.content);
    return {
      role: "user" as const,
      content: [
        { type: "tool_result", tool_use_id: toolUseId, ...(text ? { content: text } : {}) },
      ],
    };
  }

  if (!role) return null;

  const text = contentToText(message?.content);
  // #7777: keep the user-turn media parts that contentToText() above drops.
  const media = role === "user" ? collectClaudeMediaBlocks(message?.content) : [];
  const toolUses = role === "assistant" ? collectToolUseBlocks(message) : [];
  const content = [...(text ? [{ type: "text", text }] : []), ...toolUses, ...media];
  if (content.length === 0) return null;

  return { role, content };
}
