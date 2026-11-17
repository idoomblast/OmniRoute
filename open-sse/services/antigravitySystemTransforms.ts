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
 *   - function-call/response payloads are never rewritten, so tool arguments
 *     survive byte-for-byte
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

type TextHolder = { text?: unknown };

function resolveConfig(providerId: string): ProviderTransformsConfig | undefined {
  const config = getSystemTransformsConfig();
  if (!config || !config.providers) return undefined;
  return config.providers[providerId];
}

function collectTextParts(request: Record<string, unknown>, includeContents: boolean): string[] {
  const out: string[] = [];
  const systemInstruction = request.systemInstruction as { parts?: unknown } | undefined;
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    for (const part of systemInstruction.parts as TextHolder[]) {
      if (typeof part?.text === "string") out.push(part.text);
    }
  }
  if (includeContents && Array.isArray(request.contents)) {
    for (const content of request.contents as Array<{ parts?: unknown }>) {
      if (!content || !Array.isArray(content.parts)) continue;
      for (const part of content.parts as TextHolder[]) {
        if (typeof part?.text === "string") out.push(part.text);
      }
    }
  }
  return out;
}

function replaceInParts(
  request: Record<string, unknown>,
  includeContents: boolean,
  transform: (text: string) => string
): void {
  const applyTo = (holder: TextHolder) => {
    if (typeof holder?.text === "string") holder.text = transform(holder.text);
  };

  const systemInstruction = request.systemInstruction as { parts?: unknown } | undefined;
  if (systemInstruction && Array.isArray(systemInstruction.parts)) {
    for (const part of systemInstruction.parts as TextHolder[]) applyTo(part);
  }

  if (includeContents && Array.isArray(request.contents)) {
    for (const content of request.contents as Array<{ parts?: unknown }>) {
      if (!content || !Array.isArray(content.parts)) continue;
      for (const part of content.parts as TextHolder[]) applyTo(part);
    }
  }
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

function buildTextTransform(op: TransformOp): ((text: string) => string) | null {
  switch (op.kind) {
    case "replace_text": {
      const match = (op as { match?: string }).match;
      if (!match) return null;
      const replacement = (op as { replacement?: string }).replacement ?? "";
      const all = (op as { allOccurrences?: boolean }).allOccurrences === true;
      return (text) =>
        all ? text.split(match).join(replacement) : text.replace(match, replacement);
    }
    case "replace_regex": {
      const pattern = (op as { pattern?: string }).pattern;
      if (!pattern) return null;
      const flags = (op as { flags?: string }).flags ?? "g";
      const replacement = (op as { replacement?: string }).replacement ?? "";
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
      } catch {
        return null;
      }
      return (text) => text.replace(regex, replacement);
    }
    case "obfuscate_words": {
      const words = ((op as { words?: string[] }).words ?? []).filter(
        (w): w is string => typeof w === "string" && w.length > 0
      );
      if (words.length === 0) return null;
      const regexes = words.map((w) => new RegExp(escapeRegex(w), "gi"));
      return (text) => regexes.reduce((acc, re) => acc.replace(re, obfuscateWord), text);
    }
    default:
      // Structural ops (paragraph drops, billing injection, …) are meaningless
      // on the Gemini envelope; ignore rather than corrupt the payload.
      return null;
  }
}

export interface AntigravitySystemTransformResult {
  appliedOpKinds: string[];
  targetedMessages: boolean;
}

/**
 * Apply the operator-configured pipeline for `providerId` (default
 * `antigravity`) to a Gemini/Cloud Code request. Mutates `request` in place.
 * No-op when the provider entry is missing or disabled.
 */
export function applyAntigravitySystemTransforms(
  request: Record<string, unknown> | null | undefined,
  providerId: string = PROVIDER_ANTIGRAVITY
): AntigravitySystemTransformResult {
  const result: AntigravitySystemTransformResult = { appliedOpKinds: [], targetedMessages: false };
  if (!request || typeof request !== "object") return result;

  const providerConfig = resolveConfig(providerId);
  if (!providerConfig || !providerConfig.enabled) return result;

  for (const op of providerConfig.pipeline ?? []) {
    const transform = buildTextTransform(op);
    if (!transform) continue;
    const targets = (op as { targets?: string[] }).targets;
    const includeContents = Array.isArray(targets) && targets.includes("messages");
    if (includeContents) result.targetedMessages = true;
    replaceInParts(request, includeContents, transform);
    result.appliedOpKinds.push(op.kind);
  }

  return result;
}

/** Test-only helper: expose how many text parts a request carries. */
export function countTextParts(request: Record<string, unknown>, includeContents = false): number {
  return collectTextParts(request, includeContents).length;
}
