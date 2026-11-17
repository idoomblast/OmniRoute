/**
 * Antigravity system-transforms bridge.
 *
 * The generic `systemTransforms` DSL (open-sse/services/systemTransforms.ts) is
 * wired for the native `claude` OAuth path (executors/base.ts) and the
 * `anthropic-compatible-cc-*` bridge (services/claudeCodeCompatible.ts) only.
 * Antigravity request bodies are already translated to the Gemini/Cloud Code
 * shape (`request.systemInstruction`, `request.contents`) by the time the
 * executor runs, so the base pipeline — which operates on Anthropic-shaped
 * `body.system` blocks — never reaches them.
 *
 * This module applies the same operator-configured, per-provider pipeline to
 * the Gemini-shaped envelope text. It is deliberately narrow:
 *   - text-only ops: `replace_text`, `replace_regex`, `obfuscate_words`
 *   - default target is the system instruction (where third-party-agent
 *     fingerprints live); `messages` must be opted into via `op.targets`
 *   - function-call/response/inline-data parts are never rewritten, so tool
 *     payloads survive byte-for-byte
 *   - clone-on-write: the caller's shared text objects are never mutated, so
 *     executor retries and internal model fallback re-derive the same payload
 *     instead of compounding the transform
 *
 * Why this exists: Google slow-walks Antigravity requests whose system prompt
 * carries a literal third-party product name (e.g. "Hermes"), surfacing as a
 * 60-70s stall or a relayed 429. Verified A/B: identical 135KB payload,
 * `Hermes` -> 67-72s, `H3rm3s` -> 7-11s. Only real character substitution
 * defeats it — ZWJ obfuscation (`obfuscate_words`) is stripped upstream and
 * does NOT help, so `replace_text`/`replace_regex` is the recommended op.
 */

import { getSystemTransformsConfig } from "./systemTransforms.ts";
import type { ProviderTransformsConfig, TransformOp } from "./systemTransforms.ts";

/** Provider key used by the settings UI / config for this executor. */
export const PROVIDER_ANTIGRAVITY = "antigravity";

type TextHolder = { text?: unknown; [key: string]: unknown };

interface TargetSelection {
  system: boolean;
  contents: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function resolveConfig(providerId: string): ProviderTransformsConfig | undefined {
  const config = getSystemTransformsConfig();
  if (!config || !config.providers) return undefined;
  return config.providers[providerId];
}

/**
 * Explicit `targets` are honoured verbatim, including an explicitly empty list
 * (which selects nothing). Only a missing/non-array value falls back to the
 * Antigravity default of system-only: rewriting conversation text is
 * destructive and was never the intent of this bridge.
 */
function resolveTargets(op: TransformOp): TargetSelection {
  const raw = (op as { targets?: unknown }).targets;
  if (raw === undefined || raw === null) {
    return { system: true, contents: false };
  }
  if (!Array.isArray(raw)) {
    // Malformed config: select nothing rather than guessing a scope.
    return { system: false, contents: false };
  }
  return { system: raw.includes("system"), contents: raw.includes("messages") };
}

/**
 * Clone-on-write over a parts array. Untouched (or non-text) parts keep their
 * original identity, and the input array is never mutated.
 */
function rewriteTextParts(
  parts: unknown[],
  transform: (text: string) => string
): { parts: unknown[]; changed: boolean } {
  let changed = false;
  const next = parts.map((part) => {
    const holder = asRecord(part) as TextHolder | null;
    if (!holder || typeof holder.text !== "string") return part;
    const text = transform(holder.text);
    if (text === holder.text) return part;
    changed = true;
    return { ...holder, text };
  });
  return { parts: changed ? next : parts, changed };
}

/**
 * Apply `transform` to the selected text holders. Returns true when at least one
 * text part changed. Assignments only happen on change, so an unconfigured or
 * no-match request stays byte- and reference-identical.
 */
function applyToRequest(
  request: Record<string, unknown>,
  selection: TargetSelection,
  transform: (text: string) => string
): boolean {
  let changed = false;

  if (selection.system) {
    const systemInstruction = asRecord(request.systemInstruction);
    const parts = systemInstruction?.parts;
    if (systemInstruction && Array.isArray(parts)) {
      const result = rewriteTextParts(parts, transform);
      if (result.changed) {
        request.systemInstruction = { ...systemInstruction, parts: result.parts };
        changed = true;
      }
    }
  }

  if (selection.contents && Array.isArray(request.contents)) {
    let contentsChanged = false;
    const nextContents = (request.contents as unknown[]).map((content) => {
      const holder = asRecord(content);
      if (!holder || !Array.isArray(holder.parts)) return content;
      const result = rewriteTextParts(holder.parts, transform);
      if (!result.changed) return content;
      contentsChanged = true;
      return { ...holder, parts: result.parts };
    });
    if (contentsChanged) {
      request.contents = nextContents;
      changed = true;
    }
  }

  return changed;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ZWJ = "\u200d";

/** Mirrors the base DSL's ZWJ insertion (kept for config parity; ineffective upstream). */
function obfuscateWord(word: string): string {
  if (word.length <= 1) return word;
  return word[0] + ZWJ + word.slice(1);
}

/**
 * Replacement strings are interpolated, not just compared: a non-string value
 * (e.g. an object whose `toString` is null) throws from `String.prototype.replace`
 * and would abort the whole request. Reject anything that is not a string.
 * An omitted replacement keeps the DSL's empty-string default.
 */
function readReplacement(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}

function buildTextTransform(op: TransformOp): ((text: string) => string) | null {
  switch (op.kind) {
    case "replace_text": {
      const match = op.match;
      if (typeof match !== "string" || match.length === 0) return null;
      const replacement = readReplacement(op.replacement);
      if (replacement === null) return null;
      const all = op.allOccurrences === true;
      return (text) =>
        all ? text.split(match).join(replacement) : text.replace(match, replacement);
    }
    case "replace_regex": {
      const pattern = op.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) return null;
      const flags = op.flags === undefined ? "u" : op.flags;
      if (typeof flags !== "string") return null;
      const replacement = readReplacement(op.replacement);
      if (replacement === null) return null;
      // Parity with the generic DSL (ccBridgeTransforms.ts applyReplaceRegex):
      // supplied flags are used verbatim and `u` is the default. Never inject
      // `g` — that would turn a first-occurrence rule into a global rewrite.
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags);
      } catch {
        return null;
      }
      return (text) => text.replace(regex, replacement);
    }
    case "obfuscate_words": {
      if (!Array.isArray(op.words)) return null;
      const words = op.words.filter(
        (word): word is string => typeof word === "string" && word.length > 0
      );
      if (words.length === 0) return null;
      const regexes = words.map((word) => new RegExp(escapeRegex(word), "gi"));
      return (text) => regexes.reduce((acc, re) => acc.replace(re, obfuscateWord), text);
    }
    default:
      // Structural ops (paragraph drops, billing injection, …) are meaningless
      // on the Gemini envelope; ignore rather than corrupt the payload.
      return null;
  }
}

export interface AntigravitySystemTransformResult {
  /** Op kinds that actually changed at least one text part. */
  appliedOpKinds: string[];
  /** True when an op explicitly targeted conversation contents. */
  targetedMessages: boolean;
}

/**
 * Apply the operator-configured pipeline for `providerId` (default
 * `antigravity`) to a Gemini/Cloud Code request. Returns what changed. The
 * caller's input objects are never mutated — only the `request` passed in, and
 * only where a text part actually changed. No-op when the provider entry is
 * missing or disabled.
 */
export function applyAntigravitySystemTransforms(
  request: Record<string, unknown> | null | undefined,
  providerId: string = PROVIDER_ANTIGRAVITY
): AntigravitySystemTransformResult {
  const result: AntigravitySystemTransformResult = { appliedOpKinds: [], targetedMessages: false };
  if (!request || typeof request !== "object") return result;

  const providerConfig = resolveConfig(providerId);
  if (!providerConfig || !providerConfig.enabled) return result;
  if (!Array.isArray(providerConfig.pipeline)) return result;

  for (const op of providerConfig.pipeline) {
    if (!op || typeof op !== "object") continue;
    const transform = buildTextTransform(op);
    if (!transform) continue;
    const selection = resolveTargets(op);
    if (selection.contents) result.targetedMessages = true;
    if (!selection.system && !selection.contents) continue;
    // Config can arrive through the runtime setter, not only the validated
    // settings API. A single bad op must never abort the request.
    try {
      if (applyToRequest(request, selection, transform)) result.appliedOpKinds.push(op.kind);
    } catch {
      continue;
    }
  }

  return result;
}
