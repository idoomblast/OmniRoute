---
title: "Gemini 4 Hydrogen reasoning tiers (Antigravity / AGY)"
version: 3.8.49
lastUpdated: 2026-11-26
---

# Gemini 4 Hydrogen reasoning tiers (Antigravity / AGY)

Gemini 4 Hydrogen on the Cloud Code surface is tiered **by model id**, exactly like
Gemini 3.7/3.8. The authoritative source is the authenticated `:fetchAvailableModels`
response fetched with the **cli** client profile.

## The catalog (cli profile)

```
groupedModels["gemini-4-hydrogen"] = {
  displayName: "Gemini 4 Hydrogen",
  supportedThinkingLevels: [
    { thinkingSuffix: "low",    thinkingDisplayName: "Low" },
    { thinkingSuffix: "medium", thinkingDisplayName: "Medium" },
    { thinkingSuffix: "high",   thinkingDisplayName: "High" },
    { thinkingSuffix: "xhigh",  thinkingDisplayName: "Extra High" },
  ]
}
```

| Upstream id                | thinkingLevel sentinel | maxOutputTokens |
| -------------------------- | ---------------------- | --------------- |
| `gemini-4-hydrogen-low`    | 1                      | 262144          |
| `gemini-4-hydrogen-medium` | 2                      | 262144          |
| `gemini-4-hydrogen-high`   | 3                      | 262144          |
| `gemini-4-hydrogen-xhigh`  | 100                    | 262144          |
| `gemini-4-hydrogen-sonar`  | 1                      | 65536           |

The fourth rung is **`xhigh`**, displayed as "Extra High" — that is the app's
"extra" tier. It is its own model id, not a `thinkingLevel` on a shared id.

## Two traps

1. **`gemini-4-hydrogen-sonar` is a different model, not the family's shared id.**
   It is smaller (65536 vs 262144 output tokens) and does **not** implement XHIGH:
   asking it for the fourth rung (any of `thinkingLevel: "xhigh"`, numeric `7`,
   numeric `100`) answers 400 `Thinking level is unsupported: THINKING_LEVEL_XHIGH`.
   A bare `thinkingBudget: 32768` on `-sonar` produces the same 400 — the upstream
   reads an oversized budget as an out-of-range level. Tier ids never answer that;
   they carry the tier themselves and return 200.

2. **The tier ids are served by the cli client profile only.** With the ide profile
   (OmniRoute's connection default) all four ids answer 404 "Requested entity was
   not found" and are absent from the ide catalog entirely (ide sees 17 models, cli
   sees 26). The same applies to the CLI version: **1.2.8+** serves the tier ids,
   1.2.7 and below 404. `ANTIGRAVITY_CLI_FALLBACK_VERSION` is therefore `1.2.8`.

Carbon/Argon/Neon exist in the catalog only as `gemini-4-carbon-disabled`,
`gemini-4-argon-disabled`, `gemini-4-neon-disabled` — not callable.

## How OmniRoute wires it

- `open-sse/config/antigravityThinkingLevels.ts` — tier-id detection
  (`isAntigravityGemini4TierModel`), tier ↔ id maps, and
  `resolveAntigravityClientProfileForModel()` (tier ids → `"cli"`).
- `open-sse/executors/antigravity/executeAttempt.ts` — forces the cli profile
  per request for tier ids only; every other model keeps the connection's
  configured fingerprint.
- `open-sse/executors/antigravity.ts` —
  `preserveAntigravityGemini4TierRequest()` drops the `thinkingLevel` /
  `thinkingBudget` the translators derived from `reasoning_effort`, because the
  tier is already in the id and forwarding either risks a contradiction (400 on
  `-sonar`) or a silent downgrade.
- Client display ids: `gemini-4-hydrogen` → High, `gemini-4-hydrogen-extra` /
  `gemini-4-hydrogen-max` → XHigh. Tier ids pass through untouched.

Pricing: one row per tier id plus `-sonar`, all $1.50 in / $7.50 out / $0.075
cached per MTok (LiteLLM `gemini/gemini-4-hydrogen`).

Coverage: `tests/unit/antigravity-gemini4-hydrogen.test.ts`.
