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

/** Find the end of a tag of the form `<｜DSML｜name ...>` starting at `from`. */
function findTagEnd(text: string, from: number, tagName: string): number {
  // text.slice(from) must start with the literal open prefix + tagName.
  const prefix = DSML_OPEN + tagName;
  if (!text.startsWith(prefix, from)) return -1;
  // For open tags with attributes we scan to the closing '>'.
  const gt = text.indexOf(">", from + prefix.length);
  return gt === -1 ? -1 : gt; // index of '>'
}

/**
 * Parse all DSML tool_call blocks from a string.
 *
 * Returns `null` when no complete, parseable DSML block is found so the caller
 * can fall through to the next parser without mutating the response.
 */
export function parseDsmlToolCalls(content: unknown): DsmlToolCall[] | null {
  if (typeof content !== "string" || !content.trim()) return null;

  const normalized = content.replace(DSML_ZERO_WIDTH, "");
  const OPEN_BLOCK = DSML_OPEN + "tool_calls";
  const CLOSE_BLOCK = "</｜DSML｜tool_calls";
  if (!normalized.includes(OPEN_BLOCK)) return null;

  const calls: DsmlToolCall[] = [];

  let cursor = 0;
  while (true) {
    const blockStart = normalized.indexOf(OPEN_BLOCK, cursor);
    if (blockStart === -1) break;

    // 'tool_calls' block open tag must terminate with '>' (attributes allowed).
    const openGt = normalized.indexOf(">", blockStart + OPEN_BLOCK.length);
    if (openGt === -1) {
      cursor = blockStart + OPEN_BLOCK.length;
      continue;
    }

    const blockEnd = normalized.indexOf(CLOSE_BLOCK, openGt + 1);
    if (blockEnd === -1) {
      // Unclosed block — skip past this open tag and keep scanning.
      cursor = openGt + 1;
      continue;
    }

    const blockCloseGt = normalized.indexOf(">", blockEnd + CLOSE_BLOCK.length);
    const blockInnerEnd = blockCloseGt === -1 ? normalized.length : blockCloseGt;
    const inner = normalized.slice(openGt + 1, blockEnd);

    const invokes = parseInvokes(inner);
    if (invokes === null) {
      // Malformed parameter section → reject the whole block (no half-parsed
      // tool call may leak). Continue scanning after this block.
      cursor = blockInnerEnd;
    } else if (invokes.length > 0) {
      // Loop push (not spread): a 130k-invoke block would overflow the call
      // stack through `push(...invokes)` argument limits.
      for (const invoke of invokes) calls.push(invoke);
      cursor = blockInnerEnd;
    } else {
      cursor = openGt + 1;
    }
  }

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

    // Extract name="..." from the open tag.
    const openGt = blockInner.indexOf(">", invokeStart + OPEN_INVOKE.length);
    if (openGt === -1) {
      cursor = invokeStart + OPEN_INVOKE.length;
      continue;
    }
    const openTag = blockInner.slice(invokeStart, openGt + 1);
    const nameMatch = openTag.match(/\bname\s*=\s*"([^"]*)"/);
    if (!nameMatch) {
      cursor = openGt + 1;
      continue;
    }
    const name = nameMatch[1].trim();
    if (!name) {
      cursor = openGt + 1;
      continue;
    }

    const closeStart = blockInner.indexOf(CLOSE_INVOKE, openGt + 1);
    if (closeStart === -1) {
      // Unclosed invoke — skip past the open tag.
      cursor = openGt + 1;
      continue;
    }
    const body = blockInner.slice(openGt + 1, closeStart);
    cursor = blockInner.indexOf(">", closeStart) + 1 || closeStart + CLOSE_INVOKE.length;

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
    const openGt = invokeBody.indexOf(">", paramStart + OPEN_PARAM.length);
    if (openGt === -1) {
      // Unclosed open tag with no close anywhere → malformed.
      const hasCloseLater = invokeBody.indexOf(CLOSE_PARAM, paramStart) !== -1;
      if (!hasCloseLater) return null;
      cursor = paramStart + OPEN_PARAM.length;
      continue;
    }
    const openTag = invokeBody.slice(paramStart, openGt + 1);
    const nameMatch = openTag.match(/\bname\s*=\s*"([^"]*)"/);
    if (!nameMatch) {
      cursor = openGt + 1;
      continue;
    }

    // Find the matching close tag. A nested OPEN_PARAM before the close (a
    // parameter inside a parameter — impossible in the format) means the
    // outer one was left unclosed → malformed.
    const closeStart = invokeBody.indexOf(CLOSE_PARAM, openGt + 1);
    const nestedOpen = invokeBody.indexOf(OPEN_PARAM, openGt + 1);
    if (closeStart === -1 || (nestedOpen !== -1 && nestedOpen < closeStart)) {
      return null;
    }
    const paramName = nameMatch[1].trim();
    const rawValue = invokeBody.slice(openGt + 1, closeStart);
    if (!paramName) {
      cursor = closeStart + CLOSE_PARAM.length;
      continue;
    }
    defineArg(args, paramName, parseParameterValue(rawValue));
    cursor = closeStart + CLOSE_PARAM.length;
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
}

export function extractDsmlBlocks(content: string): DsmlExtraction {
  const empty: DsmlExtraction = { calls: [], remainder: content };
  if (!content || !content.includes(DSML_OPEN)) return empty;

  const normalized = content.replace(DSML_ZERO_WIDTH, "");
  const OPEN_BLOCK = DSML_OPEN + "tool_calls";
  const CLOSE_BLOCK = "</\uFF5cDSML\uFF5ctool_calls";

  if (!normalized.includes(OPEN_BLOCK)) return empty;

  const calls: DsmlToolCall[] = [];
  const parts: string[] = [];
  let cursor = 0;

  while (true) {
    const blockStart = normalized.indexOf(OPEN_BLOCK, cursor);
    if (blockStart === -1) break;

    // Exact tag boundary check: the character immediately after the tag name
    // must be '>' or whitespace — a letter/underscore/digit means this is NOT
    // a real DSML tag (e.g. "<｜DSML｜tool_calls_BAD>") and must not parse.
    const afterPrefix = blockStart + OPEN_BLOCK.length;
    const boundaryChar = normalized[afterPrefix];
    if (boundaryChar !== undefined && boundaryChar !== ">" && !/\s/.test(boundaryChar)) {
      // Not a real DSML tag — advance past this prefix and keep scanning.
      cursor = afterPrefix;
      continue;
    }

    const openGt = normalized.indexOf(">", afterPrefix);
    if (openGt === -1) break; // partial open tag — keep in remainder

    const blockEnd = normalized.indexOf(CLOSE_BLOCK, openGt + 1);
    if (blockEnd === -1) break; // incomplete block — keep in remainder

    const blockCloseGt = normalized.indexOf(">", blockEnd + CLOSE_BLOCK.length);
    if (blockCloseGt === -1) break; // partial close tag

    const inner = normalized.slice(openGt + 1, blockEnd);
    const invokes = parseInvokes(inner);

    if (invokes === null || invokes.length === 0) {
      // Malformed or empty block — leave it in the remainder as plain text
      // (lossless), advance cursor past it so we don't re-scan.
      parts.push(normalized.slice(cursor, blockCloseGt + 1));
      cursor = blockCloseGt + 1;
      continue;
    }

    // Valid block: prose before it goes to remainder
    parts.push(normalized.slice(cursor, blockStart));
    for (const invoke of invokes) calls.push(invoke);
    cursor = blockCloseGt + 1;
  }

  // Remaining text (after last processed block) — includes any partial block
  parts.push(normalized.slice(cursor));

  return { calls, remainder: parts.join("") };
}
