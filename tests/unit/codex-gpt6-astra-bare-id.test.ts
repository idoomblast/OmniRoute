import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// GPT-6 Astra is a Codex-native model like the gpt-5.6 tiers, but this fork
// deliberately keeps OpenAI as the historical default for bare overlapping ids
// (the #9275 rollback pinned by codex-synced-bare-model-routing.test.ts): bare
// `gpt-6-astra` reaches Codex when it is the only active provider, and OpenAI
// when both are active — the same contract as bare `gpt-5.6-sol`. The gpt-6
// ids therefore stay OUT of CODEX_NATIVE_UNPREFIXED_MODELS, and the native-set
// assertion below locks that in.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-gpt6-bare-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-gpt6-bare-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { CODEX_NATIVE_UNPREFIXED_MODELS, getModelInfoCore } =
  await import("../../open-sse/services/model.ts");
const { getProviderModels } = await import("../../open-sse/config/providerModels.ts");

// The base id and its effort tiers, as registered for the codex provider.
const ASTRA_IDS = getProviderModels("codex")
  .map((model) => model.id)
  .filter((id) => /^gpt-6-astra(?:-(?:ultra|max|xhigh|high|medium|low))?$/.test(id));
assert.ok(ASTRA_IDS.length >= 7, `expected the Astra effort tiers, got ${ASTRA_IDS}`);

async function seedConnection(provider: "codex" | "openai") {
  await providersDb.createProviderConnection({
    provider,
    authType: provider === "codex" ? "oauth" : "apikey",
    name: `${provider}-gpt6-bare`,
    email: provider === "codex" ? "codex@example.com" : undefined,
    apiKey: provider === "openai" ? "sk-openai-gpt6-bare" : undefined,
    accessToken: provider === "codex" ? "codex-gpt6-bare-access" : undefined,
    isActive: true,
    testStatus: "active",
    providerSpecificData: provider === "codex" ? { workspaceId: "ws-gpt6-bare" } : {},
  });
}

test.beforeEach(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("GPT-6 Astra stays out of the Codex-native unprefixed set (fork historical default)", () => {
  for (const id of ASTRA_IDS) {
    assert.equal(CODEX_NATIVE_UNPREFIXED_MODELS.has(id), false, id);
  }
});

test("bare gpt-6-astra routes to Codex when only Codex is active", async () => {
  await seedConnection("codex");

  for (const id of ["gpt-6-astra", "gpt-5.6-sol"]) {
    const info = await getModelInfoCore(id, null);
    assert.equal(info.provider, "codex", id);
    assert.equal(info.model, id);
  }
});

test("bare gpt-6-astra keeps OpenAI as the historical default when both are active", async () => {
  await seedConnection("codex");
  await seedConnection("openai");

  for (const id of ["gpt-6-astra", "gpt-5.6-sol"]) {
    const info = await getModelInfoCore(id, null);
    assert.equal(info.provider, "openai", id);
    assert.equal(info.model, id);
  }
});

test("explicit cx/ and openai/ prefixes stay authoritative for gpt-6-astra", async () => {
  await seedConnection("codex");
  await seedConnection("openai");

  const codexAlias = await getModelInfoCore("cx/gpt-6-astra", null);
  const codexCanonical = await getModelInfoCore("codex/gpt-6-astra", null);
  const openai = await getModelInfoCore("openai/gpt-6-astra", null);

  assert.equal(codexAlias.provider, "codex");
  assert.equal(codexCanonical.provider, "codex");
  assert.equal(openai.provider, "openai");
});
