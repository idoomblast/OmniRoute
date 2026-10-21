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
 *
 * Implementation notes:
 * - Purely iterative index-based scanning (no global regex over the whole
 *   payload) so a 130k-invoke payload cannot trigger regex backtracking or
 *   stack overflow.
 * - An invoke whose parameter section is malformed (e.g. an unclosed
 *   `<｜DSML｜parameter>` before `</｜DSML｜invoke>`) REJECTS the whole block
 *   (returns null) rather than yielding a tool call with silently-truncated
 *   arguments — a half-parsed call is worse than no call.
 * - `__proto__` parameters are stored via Object.defineProperty so they land
 *   as own properties (prototype-pollution safe).
 */

export interface DsmlToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Match the fullwidth vertical bar character used in DSML tags. */
const DSML_OPEN = "<\uFF5cDSML\uFF5c";
const DSML_ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/**
 * Opening marker of a DSML `tool_calls` block. Exported for the streaming
 * guard in `stream.ts`, which must detect (partial) blocks in content deltas.
 */
export const DSML_OPEN_TAG = "<\uFF5cDSML\uFF5ctool_calls";
/** Closing marker of a DSML `tool_calls` block, including the trailing `>`. */
export const DSML_CLOSE_TAG = "</\uFF5cDSML\uFF5ctool_calls>";

/** Find the end of a tag of the form `<｜DSML｜name ...>` starting at `from`. */
function findTagEnd(text: string, from: number, tagName: string, closing = false): number {
  const prefix = (closing ? "</｜DSML｜" : DSML_OPEN) + tagName;
  if (!text.startsWith(prefix, from)) return -1;
  const boundary = text[from + prefix.length];
  if (boundary !== ">" && !/\s/.test(boundary || "")) return -1;
  const gt = text.indexOf(">", from + prefix.length);
  if (gt === -1) return -1;
  const attributes = text.slice(from + prefix.length, gt);
  if (attributes.includes("<") || (closing && attributes.trim())) return -1;
  return gt;
}

/**
 * Parse all DSML tool_call blocks from a string.
 *
 * Returns `null` when no complete, parseable DSML block is found so the caller
 * can fall through to the next parser without mutating the response.
 */
export function parseDsmlToolCalls(content: unknown): DsmlToolCall[] | null {
  if (typeof content !== "string" || !content.trim()) return null;
  const { calls } = extractDsmlBlocks(content);
  return calls.length > 0 ? calls : null;
}

/**
 * Parse `<｜DSML｜invoke name="…">…</｜DSML｜invoke>` blocks inside a
 * tool_calls block. Returns null when an invoke is structurally malformed
 * (unclosed parameter tag inside a closed invoke) so the caller can reject
 * the block.
 */
function parseInvokes(blockInner: string): DsmlToolCall[] | null {
  const calls: DsmlToolCall[] = [];
  const OPEN_INVOKE = DSML_OPEN + "invoke";
  const CLOSE_INVOKE = "</｜DSML｜invoke";

  let cursor = 0;
  while (true) {
    const invokeStart = blockInner.indexOf(OPEN_INVOKE, cursor);
    if (invokeStart === -1) break;

    const openGt = findTagEnd(blockInner, invokeStart, "invoke");
    if (openGt === -1) return null;
    const openTag = blockInner.slice(invokeStart, openGt + 1);
    const nameMatch = openTag.match(/\bname\s*=\s*"([^"]*)"/);
    if (!nameMatch) return null;
    const name = nameMatch[1].trim();
    if (!name) return null;

    const closeStart = blockInner.indexOf(CLOSE_INVOKE, openGt + 1);
    if (closeStart === -1) return null;
    const closeGt = findTagEnd(blockInner, closeStart, "invoke", true);
    if (closeGt === -1) return null;
    const nestedOpen = blockInner.indexOf(OPEN_INVOKE, openGt + 1);
    if (nestedOpen !== -1 && nestedOpen < closeStart) return null;
    const body = blockInner.slice(openGt + 1, closeStart);
    cursor = closeGt + 1;

    // Self-closing invoke (no parameters): `<｜DSML｜invoke name="x"></｜DSML｜invoke>`
    const args = body.trim() === "" ? {} : parseParameters(body);
    if (args === null) {
      // Malformed parameter section inside a closed invoke → reject the block.
      return null;
    }
    calls.push({ name, args });
  }

  return calls;
}

/**
 * Parse `<｜DSML｜parameter name="…">value</｜DSML｜parameter>` pairs inside
 * an invoke body. Returns null on a malformed parameter (an invoke open tag
 * with a `name` attribute and no closing parameter tag before the invoke
 * close) — the caller rejects the whole block.
 */
function parseParameters(invokeBody: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const OPEN_PARAM = DSML_OPEN + "parameter";
  const CLOSE_PARAM = "</｜DSML｜parameter";

  let cursor = 0;
  while (cursor < invokeBody.length) {
    const paramStart = invokeBody.indexOf(OPEN_PARAM, cursor);
    if (paramStart === -1) {
      // Remaining text is whitespace between parameters — anything else is
      // stray non-tag content, which we ignore (tolerant).
      break;
    }
    const openGt = findTagEnd(invokeBody, paramStart, "parameter");
    if (openGt === -1) return null;
    const openTag = invokeBody.slice(paramStart, openGt + 1);
    const nameMatch = openTag.match(/\bname\s*=\s*"([^"]*)"/);
    if (!nameMatch) return null;

    // Find the matching close tag. A nested OPEN_PARAM before the close (a
    // parameter inside a parameter — impossible in the format) means the
    // outer one was left unclosed → malformed.
    const closeStart = invokeBody.indexOf(CLOSE_PARAM, openGt + 1);
    const nestedOpen = invokeBody.indexOf(OPEN_PARAM, openGt + 1);
    if (closeStart === -1 || (nestedOpen !== -1 && nestedOpen < closeStart)) {
      return null;
    }
    const closeGt = findTagEnd(invokeBody, closeStart, "parameter", true);
    if (closeGt === -1) return null;
    const paramName = nameMatch[1].trim();
    const rawValue = invokeBody.slice(openGt + 1, closeStart);
    if (!paramName) {
      cursor = closeGt + 1;
      continue;
    }
    defineArg(args, paramName, parseParameterValue(rawValue));
    cursor = closeGt + 1;
  }

  return args;
}

/**
 * Parse a parameter value: JSON-decode when it looks like JSON, otherwise keep
 * as a plain string. Handles nested quotes, escaped characters, and preserves
 * indentation/newlines for plain-string values.
 */
function parseParameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";

  // JSON candidates: objects, arrays, numbers (incl. exponent form), booleans,
  // null, and double-quoted strings (decode escape sequences like \n).
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    /^-?(?:\d+(?:\.\d+)?|\d+(?:\.\d+)?[eE][+-]?\d+|\.\d+)$/.test(trimmed) ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed;
    } catch {
      // Not valid JSON — keep as string below.
    }
  }

  // Plain string values preserve the original indentation/newlines — only the
  // exact raw slice is kept (no trim on the value itself).
  return raw;
}

/** Build args with `__proto__`-safe own properties. */
function defineArg(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/**
 * Extract complete, valid DSML tool_call blocks from a string, returning the
 * parsed calls and the non-DSML remainder (prose before/after + any partial
 * or malformed block text, preserved verbatim).
 *
 * Malformed blocks (unclosed tags, bad parameter structure) are NOT silently
 * promoted to calls — they stay in the remainder as plain text so nothing is
 * ever lost.  This replaces the older parse+strip pair which could drop
 * malformed content and reject a whole batch when only one block was bad.
 */
export interface DsmlExtraction {
  calls: DsmlToolCall[];
  remainder: string;
  /** Original-source offset of a trailing incomplete block or opening prefix. */
  pendingStart?: number;
}

export function extractDsmlBlocks(content: string): DsmlExtraction {
  const empty: DsmlExtraction = { calls: [], remainder: content };
  if (!content || !content.includes("<")) return empty;

  const normalized = content.replace(DSML_ZERO_WIDTH, "");
  // Recognition uses normalized text; unconverted text uses source slices.
  const offsets: number[] | null = normalized.length === content.length ? null : [];
  if (offsets) {
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      if ((code >= 0x200b && code <= 0x200d) || code === 0xfeff) continue;
      offsets.push(i);
    }
  }
  const sourceOffset = (index: number) => offsets?.[index] ?? index;
  const sourceEnd = (index: number) => sourceOffset(index - 1) + 1;
  const CLOSE_BLOCK = DSML_CLOSE_TAG.slice(0, -1);

  const calls: DsmlToolCall[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let preserved = 0;
  let pendingStart: number | undefined;

  while (true) {
    const blockStart = normalized.indexOf(DSML_OPEN_TAG, cursor);
    if (blockStart === -1) break;
    const afterPrefix = blockStart + DSML_OPEN_TAG.length;
    const boundaryChar = normalized[afterPrefix];
    if (boundaryChar !== undefined && boundaryChar !== ">" && !/\s/.test(boundaryChar)) {
      cursor = afterPrefix;
      continue;
    }
    const openGt = findTagEnd(normalized, blockStart, "tool_calls");
    if (openGt === -1) {
      if (normalized.indexOf(">", afterPrefix) === -1) {
        pendingStart = sourceOffset(blockStart);
        break;
      }
      cursor = afterPrefix;
      continue;
    }
    const blockEnd = normalized.indexOf(CLOSE_BLOCK, openGt + 1);
    if (blockEnd === -1) {
      pendingStart = sourceOffset(blockStart);
      break;
    }
    const blockCloseGt = findTagEnd(normalized, blockEnd, "tool_calls", true);
    if (blockCloseGt === -1) {
      if (normalized.indexOf(">", blockEnd) === -1) {
        pendingStart = sourceOffset(blockStart);
        break;
      }
      cursor = blockEnd + CLOSE_BLOCK.length;
      continue;
    }
    const inner = normalized.slice(openGt + 1, blockEnd);
    const invokes = parseInvokes(inner);
    cursor = blockCloseGt + 1;
    if (invokes === null || invokes.length === 0) {
      continue;
    }
    parts.push(content.slice(preserved, sourceOffset(blockStart)));
    for (const invoke of invokes) calls.push(invoke);
    preserved = sourceEnd(cursor);
  }
  if (pendingStart === undefined) {
    // A bare '<' is held only until the next delta disambiguates it.
    for (let size = Math.min(DSML_OPEN_TAG.length, normalized.length - cursor); size > 0; size--) {
      if (DSML_OPEN_TAG.startsWith(normalized.slice(-size))) {
        pendingStart = sourceOffset(normalized.length - size);
        break;
      }
    }
  }
  parts.push(content.slice(preserved));
  return { calls, remainder: parts.join(""), pendingStart };
}
