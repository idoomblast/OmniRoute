// Gemini 4 Hydrogen tiers on the Antigravity / Cloud Code surface.
//
// The authoritative source is the authenticated `:fetchAvailableModels` response.
// Fetched with the cli client profile (2026-11-26, consumer OAuth account):
//
//   groupedModels["gemini-4-hydrogen"] = {
//     displayName: "Gemini 4 Hydrogen",
//     supportedThinkingLevels: [
//       { thinkingSuffix: "low",    thinkingDisplayName: "Low" },
//       { thinkingSuffix: "medium", thinkingDisplayName: "Medium" },
//       { thinkingSuffix: "high",   thinkingDisplayName: "High" },
//       { thinkingSuffix: "xhigh",  thinkingDisplayName: "Extra High" },
//     ]
//   }
//
// So the four rungs are Low / Medium / High / Extra High, and **each rung is its
// own model id carrying its tier**, exactly like Gemini 3.7/3.8 — NOT a
// `thinkingLevel` rewrite on one shared id:
//
//   gemini-4-hydrogen-low      thinkingLevel 1     maxOutputTokens 262144
//   gemini-4-hydrogen-medium   thinkingLevel 2     maxOutputTokens 262144
//   gemini-4-hydrogen-high     thinkingLevel 3     maxOutputTokens 262144
//   gemini-4-hydrogen-xhigh    thinkingLevel 100   maxOutputTokens 262144  ← XHIGH sentinel
//   gemini-4-hydrogen-sonar    thinkingLevel 1     maxOutputTokens  65536  ← different model
//
// Two facts that are easy to get wrong:
//
//  1. `gemini-4-hydrogen-sonar` is NOT a shared family id. It is a separate,
//     smaller-output model (65536 vs 262144) that does NOT implement XHIGH. Asking
//     it for the fourth rung answers 400
//     "Thinking level is unsupported: THINKING_LEVEL_XHIGH". The tier ids do not
//     answer that — they return 200 and carry the tier themselves.
//  2. The tier ids are served by the **cli** client profile only. With the ide
//     profile — the repo default — all four ids answer 404 "Requested entity was
//     not found", and the catalog does not even list them (ide sees 17 models,
//     cli sees 26). `gemini-4-carbon-*`, `-argon-*`, `-neon-*` exist in the catalog
//     only as `*-disabled` entries, so they are not callable either.
//
// Consequences for the executor: a Gemini 4 tier id must reach the upstream with
// the cli profile, must keep its own model id (never resolve onto `-sonar`), and
// must not be handed a tier `thinkingLevel` that contradicts the id.

/** Client-facing tier suffix -> the upstream id that implements it. */
export const ANTIGRAVITY_GEMINI4_TIER_MODELS = Object.freeze({
  low: "gemini-4-hydrogen-low",
  medium: "gemini-4-hydrogen-medium",
  high: "gemini-4-hydrogen-high",
  xhigh: "gemini-4-hydrogen-xhigh",
} as const);

export type AntigravityGemini4Tier = keyof typeof ANTIGRAVITY_GEMINI4_TIER_MODELS;

/** Tier suffixes in ascending order, as advertised by the catalog. */
export const ANTIGRAVITY_GEMINI4_TIER_SUFFIXES = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
] as const);

/**
 * Model ids whose reasoning tier is baked into the id. These need the cli surface
 * and must not be rewritten onto another id or handed a contradicting level.
 */
const GEMINI4_TIER_MODEL = /^gemini-4-[a-z]+-(low|medium|high|xhigh)$/i;

export function isAntigravityGemini4TierModel(modelId: string | null | undefined): boolean {
  if (typeof modelId !== "string") return false;
  return GEMINI4_TIER_MODEL.test(modelId.trim().split("/").pop() ?? "");
}

/**
 * The tier a Gemini 4 tier id encodes, or null when the id does not encode one.
 * `gemini-4-hydrogen-sonar` and the `-tiered-*` variants return null.
 */
export function antigravityGemini4TierFromModelId(
  modelId: string | null | undefined
): AntigravityGemini4Tier | null {
  if (!isAntigravityGemini4TierModel(modelId)) return null;
  const bare = (modelId as string).trim().split("/").pop()!.toLowerCase();
  const match = bare.match(/^gemini-4-[a-z]+-(low|medium|high|xhigh)$/);
  return match ? (match[1] as AntigravityGemini4Tier) : null;
}

/**
 * Resolve a client tier request onto a real upstream id.
 *
 * `extra` / `extra-high` / `max` are accepted for client compatibility and mean the
 * fourth rung, which the catalog calls `xhigh` ("Extra High"). Unknown names return
 * null so the caller falls through to the model id the client actually sent.
 */
export function antigravityGemini4TierModelForTier(tier: string | null | undefined): string | null {
  if (typeof tier !== "string") return null;
  switch (tier.trim().toLowerCase()) {
    case "low":
    case "minimal":
      return ANTIGRAVITY_GEMINI4_TIER_MODELS.low;
    case "medium":
      return ANTIGRAVITY_GEMINI4_TIER_MODELS.medium;
    case "high":
      return ANTIGRAVITY_GEMINI4_TIER_MODELS.high;
    case "extra":
    case "extra-high":
    case "xhigh":
    case "max":
    case "ultra":
      return ANTIGRAVITY_GEMINI4_TIER_MODELS.xhigh;
    default:
      return null;
  }
}

/**
 * The client profile that can actually serve this model.
 *
 * Returns `"cli"` for the Gemini 4 tier ids because the ide surface answers 404 for
 * them, and null for everything else so the caller keeps the configured profile.
 * Deliberately narrow: only the ids proven ide-incompatible are forced, so a
 * connection's fingerprint stays stable for every other model.
 */
export function resolveAntigravityClientProfileForModel(
  modelId: string | null | undefined
): "cli" | null {
  return isAntigravityGemini4TierModel(modelId) ? "cli" : null;
}

/**
 * Thinking budget thresholds that map onto the four rungs. Kept for the case where
 * a client expresses intent as `reasoning_effort` rather than a tier id.
 */
export function antigravityGemini4TierForBudget(
  budget: number | null | undefined
): AntigravityGemini4Tier {
  if (typeof budget !== "number" || !Number.isFinite(budget)) return "high";
  if (budget <= 4096) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 24576) return "high";
  // Anything above the high rung is a request for the top tier, which this family
  // serves as its own id rather than as a bigger budget.
  return "xhigh";
}
