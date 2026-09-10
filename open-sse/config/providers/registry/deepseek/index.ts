import type { RegistryEntry } from "../../shared.ts";

export const deepseekProvider: RegistryEntry = {
  id: "deepseek",
  alias: "ds",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.deepseek.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportsReasoning: true },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supportsReasoning: true },
    {
      // DeepSeek V4.1-Flash (2026-09-10) — native multimodal vision. The official
      // API wire string is `deepseek-flash`; the user-facing OmniRoute id
      // `deepseek-v4.1-flash` is remapped onto it by PROVIDER_MODEL_ALIASES in
      // open-sse/services/model.ts. deepseek-v4-flash / -vision-exp are retired
      // upstream (temporarily routed to V4.1) and stay listed for back-compat.
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      supportsReasoning: true,
      supportsVision: true,
      supportedThinkingEfforts: ["low", "high", "max"],
      maxOutputTokens: 384000,
      contextLength: 1000000,
    },
  ],
};
