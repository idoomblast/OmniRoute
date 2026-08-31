import type { RegistryEntry } from "../../shared.ts";

export const baiProvider: RegistryEntry = {
  id: "bai",
  alias: "bai",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.b.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  modelsUrl: "https://api.b.ai/v1/models",
  // GLM-5.3-Flash strict effort tiers (low|high|max) are declared globally via
  // MODEL_SPECS — no per-provider entry needed (see modelSpecs.ts).
  models: [],
  passthroughModels: true,
};
