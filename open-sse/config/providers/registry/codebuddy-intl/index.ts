import type { RegistryEntry } from "../../shared.ts";

/**
 * CodeBuddy International — www.codebuddy.ai (SaaS; the CodeBuddy CLI/IDE gateway).
 *
 * Catalog = the live International lineup, verified 2026-10-07 against CodeBuddy
 * CLI v2.161.4: both its shipped product.json and the authenticated
 * `GET /v3/config` response list the same 22 models. This is NOT the CN catalog —
 * an earlier revision mirrored CN metadata, but the International gateway serves
 * its own lineup (GPT/Gemini families included, no MiniMax/GLM-4.x/Kimi-K2.5+2.7).
 *
 * The five `*-model` entries are gateway-side mode aliases (Auto/Fast/Balanced/
 * Primary/Deep); `deepseek-v4.1-flash-sg` is the Singapore variant. contextLength
 * mirrors upstream `maxInputTokens`; `maxOutputTokens`/`supportsReasoning`/
 * `supportsVision` mirror the upstream model config. Authenticated chat through
 * this provider still awaits an end-to-end live verification (farming).
 */
export const codebuddy_intlProvider: RegistryEntry = {
  id: "codebuddy-intl",
  alias: "cbai",
  format: "openai",
  executor: "codebuddy-intl",
  forceStream: true,
  baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
  authType: "oauth",
  authHeader: "bearer",
  headers: {
    "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
    "X-Product": "SaaS",
    "X-IDE-Type": "IDE",
    "X-IDE-Name": "IDE",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
  },
  models: [
    {
      id: "default-model",
      name: "Auto",
      contextLength: 176000,
      maxOutputTokens: 24000,
      supportsVision: true,
    },
    {
      id: "fast-model",
      name: "Fast",
      contextLength: 200000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "balanced-model",
      name: "Balanced",
      contextLength: 256000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "primary-model",
      name: "Primary",
      contextLength: 272000,
      maxOutputTokens: 72000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "deep-model",
      name: "Deep",
      contextLength: 176000,
      maxOutputTokens: 24000,
      supportsVision: true,
    },
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek-V4.1-Flash",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "deepseek-v4.1-flash-sg",
      name: "DeepSeek-V4.1-Flash (SG)",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gpt-6-astra",
      name: "GPT-6-Astra",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "hy4-preview",
      name: "Hy4 Preview",
      contextLength: 1000000,
      maxOutputTokens: 64000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "hy3",
      name: "Hy3",
      contextLength: 192000,
      maxOutputTokens: 64000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "kimi-k2.8-preview",
      name: "Kimi-K2.8-Preview",
      contextLength: 1000000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6-Terra",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6-Luna",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextLength: 272000,
      maxOutputTokens: 72000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "gemini-3.5-flash",
      name: "Gemini-3.5-Flash",
      contextLength: 1000000,
      maxOutputTokens: 65536,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "glm-5.3-flash",
      name: "GLM-5.3-Flash",
      contextLength: 1000000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      contextLength: 1000000,
      maxOutputTokens: 48000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      contextLength: 1000000,
      maxOutputTokens: 48000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "kimi-k3",
      name: "Kimi-K3",
      contextLength: 1000000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
    },
    {
      id: "kimi-k2.6",
      name: "Kimi-K2.6",
      contextLength: 256000,
      maxOutputTokens: 32000,
      supportsReasoning: true,
      supportsVision: true,
    },
  ],
};

export default codebuddy_intlProvider;
