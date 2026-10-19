/**
 * DSML tool-call parser for DeepSeek V4.1-flash.
 *
 * DeepSeek V4.1-flash occasionally emits tool calls in its native DSML XML format
 * instead of the OpenAI `tool_calls` JSON array. The format uses fullwidth
 * vertical bars (U+FF5C) around "DSML":
 *
 * ```xml
 * <｜DSML｜tool_calls>
 * <｜DSML｜invoke name="function_name">
 * <｜DSML｜parameter name="param1">value1</｜DSML｜parameter>
 * <｜DSML｜parameter name="param2">{"nested":"json"}</｜DSML｜parameter>
 * </｜DSML｜invoke>
 * </｜DSML｜tool_calls>
 * ```
 *
 * This module parses such blocks from text content and converts them to
 * standard OpenAI tool_calls. It is strictly opt-in per model — gated by the
 * `supportsDsmlToolCalls` flag in model specs — so a parser bug can only
 * affect the flagged model, never other providers.
 */

export interface DsmlToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Match the fullwidth vertical bar character used in DSML tags. */
const DSML_OPEN = "<\uFF5cDSML\uFF5c";
const DSML_CLOSE = "</\uFF5cDSML\uFF5c";

/**
 * Parse all DSML tool_call blocks from a string.
 *
 * Returns `null` when no complete, parseable DSML block is found so the caller
 * can fall through to the next parser without mutating the response.
 */
export function parseDsmlToolCalls(content: unknown): DsmlToolCall[] | null {
  if (typeof content !== "string" || !content.trim()) return null;

  // Strip zero-width characters before parsing.
  const normalized = content.replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (!normalized.includes(DSML_OPEN)) return null;

  const calls: DsmlToolCall[] = [];

  // Match complete <｜DSML｜tool_calls>…</｜DSML｜tool_calls> blocks.
  const blockRe = new RegExp(
    `${escapeRegExp(DSML_OPEN)}tool_calls\\s*>` +
      `([\\s\\S]*?)` +
      `${escapeRegExp(DSML_CLOSE)}tool_calls\\s*>`,
    "gi"
  );

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(normalized)) !== null) {
    const inner = blockMatch[1];
    const invokes = parseInvokes(inner);
    if (invokes.length > 0) {
      calls.push(...invokes);
    }
  }

  return calls.length > 0 ? calls : null;
}

/** Parse individual <｜DSML｜invoke>…</｜DSML｜invoke> blocks inside a tool_calls block. */
function parseInvokes(blockInner: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];

  const invokeRe = new RegExp(
    `${escapeRegExp(DSML_OPEN)}invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>` +
      `([\\s\\S]*?)` +
      `${escapeRegExp(DSML_CLOSE)}invoke\\s*>`,
    "gi"
  );

  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(blockInner)) !== null) {
    const name = m[1].trim();
    const body = m[2];
    if (!name) continue;

    const args = parseParameters(body);
    calls.push({ name, args });
  }

  return calls;
}

/** Parse <｜DSML｜parameter name="…">value</｜DSML｜parameter> pairs inside an invoke block. */
function parseParameters(invokeBody: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  const paramRe = new RegExp(
    `${escapeRegExp(DSML_OPEN)}parameter\\s+name\\s*=\\s*"([^"]+)"\\s*>` +
      `([\\s\\S]*?)` +
      `${escapeRegExp(DSML_CLOSE)}parameter\\s*>`,
    "gi"
  );

  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(invokeBody)) !== null) {
    const paramName = m[1].trim();
    const rawValue = m[2].trim();
    if (!paramName) continue;
    args[paramName] = parseParameterValue(rawValue);
  }

  return args;
}

/**
 * Parse a parameter value: JSON-decode when it looks like JSON, otherwise keep
 * as a plain string. Handles nested quotes and escaped characters.
 */
function parseParameterValue(raw: string): unknown {
  if (!raw) return "";

  // Attempt JSON parse — handles objects, arrays, numbers, booleans, quoted strings.
  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    raw === "true" ||
    raw === "false" ||
    raw === "null" ||
    /^-?\d+(\.\d+)?$/.test(raw)
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      // Not valid JSON — keep as string.
    }
  }

  return raw;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
