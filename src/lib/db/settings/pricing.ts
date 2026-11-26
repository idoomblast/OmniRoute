/**
 * db/settings/pricing.ts — Pricing data CRUD (user overrides, LiteLLM sync, models.dev sync).
 */

import { getDbInstance } from "../core";
import { backupDbFile } from "../backup";
import { invalidateDbCache } from "../readCache";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { resolveAntigravityModelId } from "@omniroute/open-sse/config/antigravityModelAliases.ts";
import { type JsonRecord, toRecord } from "./shared";

/**
 * Providers that bill under a pricing namespace that their registry alias does not
 * point at. `ag` is the shared Antigravity/AGY price table, but `antigravity` declares
 * no alias and `agy` maps to itself, so the generic alias walk never reaches it.
 */
const PRICING_PROVIDER_NAMESPACE: Record<string, string> = {
  antigravity: "ag",
  agy: "ag",
};

type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
export type PricingSource = "default" | "litellm" | "modelsDev" | "user";
export type PricingSourceMap = Record<string, Record<string, PricingSource>>;

function readPricingNamespace(
  db: ReturnType<typeof getDbInstance>,
  namespace: string
): PricingByProvider {
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = ?").all(namespace);
  const pricing: PricingByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;

    try {
      pricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
    } catch {
      // Corrupted data — skip silently, fallback to lower layers
    }
  }

  return pricing;
}

function mergePricingLayers(layers: PricingByProvider[]): PricingByProvider {
  const mergedPricing: PricingByProvider = {};

  for (const layer of layers) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
        continue;
      }

      for (const [model, pricing] of Object.entries(models)) {
        mergedPricing[provider][model] = mergedPricing[provider][model]
          ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
          : pricing;
      }
    }
  }

  return mergedPricing;
}

function buildPricingSourceMap(layers: {
  defaults: PricingByProvider;
  litellm: PricingByProvider;
  modelsDev: PricingByProvider;
  user: PricingByProvider;
}): PricingSourceMap {
  const sourceMap: PricingSourceMap = {};
  const mergedPricing = mergePricingLayers([
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);

  for (const [provider, models] of Object.entries(mergedPricing)) {
    sourceMap[provider] = {};

    for (const model of Object.keys(models)) {
      if (layers.user[provider]?.[model]) {
        sourceMap[provider][model] = "user";
      } else if (layers.modelsDev[provider]?.[model]) {
        sourceMap[provider][model] = "modelsDev";
      } else if (layers.litellm[provider]?.[model]) {
        sourceMap[provider][model] = "litellm";
      } else {
        sourceMap[provider][model] = "default";
      }
    }
  }

  return sourceMap;
}

async function getPricingLayers() {
  const db = getDbInstance();

  // Layer 1: Hardcoded defaults (lowest priority)
  const { getDefaultPricing } = await import("@/shared/constants/pricing");
  return {
    defaults: getDefaultPricing(),
    litellm: readPricingNamespace(db, "pricing_synced"),
    modelsDev: readPricingNamespace(db, "models_dev_pricing"),
    user: readPricingNamespace(db, "pricing"),
  };
}

export async function getPricing() {
  const layers = await getPricingLayers();
  // Merge: defaults → LiteLLM → models.dev → user (each layer overrides the previous)
  return mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]);
}

export async function getPricingWithSources(): Promise<{
  pricing: PricingByProvider;
  sourceMap: PricingSourceMap;
}> {
  const layers = await getPricingLayers();
  return {
    pricing: mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]),
    sourceMap: buildPricingSourceMap(layers),
  };
}

export async function getPricingForModel(provider: string, model: string) {
  const pricing = await getPricing();

  // Scalar rates a row can carry. A partial override inherits whichever ones it omits from
  // the fallback row; leaving `output` undefined makes the calculator bill 0 for output
  // tokens instead of the default rate.
  const SCALAR_RATE_KEYS = ["input", "output", "cached", "reasoning", "cache_creation"] as const;

  // Rates that are a whole TIER object rather than a number. `long_context` is
  // `{threshold, input, output, cached, reasoning, cache_creation}` and `costCalculator`'s
  // `applyLongContextTier` reads it as an object — a numeric `long_context` is ignored
  // entirely, so it must be inherited as an opaque value, never compared as a number.
  const OBJECT_RATE_KEYS = ["long_context"] as const;

  /**
   * Fill rates a row omits from a more complete fallback row. A user override that only
   * sets `input` is a legitimate partial override; leaving `output` undefined makes the
   * calculator bill 0 for output tokens instead of the default rate.
   */
  const mergeMissingRates = (row: JsonRecord, fallback: JsonRecord): JsonRecord => {
    const merged: JsonRecord = { ...row };
    for (const key of SCALAR_RATE_KEYS) {
      if (typeof merged[key] === "number" && Number.isFinite(merged[key] as number)) continue;
      if (typeof fallback[key] === "number" && Number.isFinite(fallback[key] as number)) {
        merged[key] = fallback[key];
      }
    }
    for (const key of OBJECT_RATE_KEYS) {
      // Present at all (even as a malformed tier the calculator will ignore) counts as
      // the row having an opinion; only a genuinely absent key is inherited.
      if (merged[key] !== undefined && merged[key] !== null) continue;
      const tier = fallback[key];
      if (typeof tier === "object" && tier !== null && !Array.isArray(tier)) {
        merged[key] = tier;
      }
    }
    return merged;
  };

  const findKeyInsensitive = <T>(
    obj: Record<string, T> | undefined | null,
    key: string
  ): T | undefined => {
    if (!obj || !key) return undefined;
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === lowerKey) return v;
    }
    return undefined;
  };

  const pLower = (provider || "").toLowerCase();
  let providerPricing = findKeyInsensitive<PricingModels>(pricing, pLower);
  // Namespaces this provider may legitimately bill under, in priority order. Used
  // for per-model fallback below: a provider's own table can exist and still not
  // carry a given model (a single unrelated override row), so resolving the TABLE
  // is not enough — the MODEL has to be looked up in each candidate namespace.
  const candidateNamespaces: string[] = [pLower];

  // The alias is ALWAYS a candidate namespace, whether or not the provider also has its own
  // table. A full table under the provider id does not make the alias table irrelevant: a
  // partial override stored under the provider id inherits its unset rates from the alias
  // table, and only a candidate namespace can supply them. Pushing it conditionally dropped
  // `input`/`cached`/`reasoning`/`cache_creation`/`long_context` for every partial override on
  // a provider whose alias owns the real prices (`claude` → `cc`).
  {
    const alias = findKeyInsensitive<string>(PROVIDER_ID_TO_ALIAS, pLower);
    if (alias && alias.toLowerCase() !== pLower) {
      candidateNamespaces.push(alias.toLowerCase());
      if (!providerPricing) providerPricing = findKeyInsensitive(pricing, alias);
    }
  }

  if (!providerPricing) {
    for (const [id, mappedAlias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
      if (typeof mappedAlias === "string" && mappedAlias.toLowerCase() === pLower) {
        providerPricing = findKeyInsensitive(pricing, id);
        if (providerPricing) {
          candidateNamespaces.push(id.toLowerCase());
          break;
        }
      }
    }
  }

  // Both Antigravity OAuth providers bill under the shared `ag` pricing namespace,
  // but neither declares `ag` as its alias (`antigravity` has no alias at all and
  // `agy` maps to itself). Without this mapping every Antigravity model — including
  // the Gemini 4 Hydrogen tiers — resolves to null and cost/quota accounting silently
  // falls back to $0.
  const namespace = Object.prototype.hasOwnProperty.call(PRICING_PROVIDER_NAMESPACE, pLower)
    ? PRICING_PROVIDER_NAMESPACE[pLower]
    : undefined;
  if (namespace) candidateNamespaces.push(namespace.toLowerCase());

  if (!providerPricing) {
    // Preserve the historical `-cn` suffix stripping as a table-level fallback.
    const np = pLower.replace(/-cn$/, "");
    if (np && np !== pLower) {
      providerPricing = findKeyInsensitive(pricing, np);
      candidateNamespaces.push(np);
    }
  }

  const mLower = (model || "").toLowerCase();
  // Display aliases (`gemini-4-hydrogen`, `-extra`, `-max`) bill as the tier id they
  // route to. Scoped to the Antigravity namespace on purpose: applying the
  // Antigravity alias table to every provider rewrote unrelated ids (a Gemini exact
  // row at $1 was replaced by its `-high` row at $3).
  const isAntigravityNamespace = candidateNamespaces.some(
    (ns) => ns === "antigravity" || ns === "agy" || ns === "ag"
  );
  const canonicalModel = isAntigravityNamespace ? resolveAntigravityModelId(mLower) : mLower;

  const searchOrder = providerPricing
    ? [
        providerPricing,
        ...candidateNamespaces
          .filter((ns) => ns !== pLower)
          .map((ns) => findKeyInsensitive<PricingModels>(pricing, ns))
          .filter((t): t is PricingModels => Boolean(t)),
      ]
    : candidateNamespaces
        .map((ns) => findKeyInsensitive<PricingModels>(pricing, ns))
        .filter((t): t is PricingModels => Boolean(t));

  // Walk the tables in precedence order and merge every distinct row we find. The FIRST
  // row that sets a rate is the one that counts; later rows only fill the rates it left
  // out. Two cases this pins down:
  //   - a partial override for the requested name keeps its own rates and inherits the
  //     rest from the canonical row, instead of billing the omitted ones at $0;
  //   - a provider-local partial row keeps its rates even when the same model also
  //     exists, complete, in the shared namespace.
  // Inside one table the requested name is consulted before its alias target, so a
  // deliberate override of a display alias still beats the tier default it routes to.
  const rowCandidates = (table: PricingModels): JsonRecord[] => {
    const seenRows = new Set<JsonRecord>();
    const out: JsonRecord[] = [];
    for (const name of [mLower, canonicalModel, mLower.replace(/\./g, "-")]) {
      if (!name) continue;
      const hit = findKeyInsensitive<JsonRecord>(table, name);
      if (!hit || seenRows.has(hit)) continue;
      seenRows.add(hit);
      out.push(hit);
    }
    return out;
  };

  let merged: JsonRecord | null = null;
  const seenTables = new Set<PricingModels>();
  for (const table of searchOrder) {
    if (seenTables.has(table)) continue;
    seenTables.add(table);
    for (const row of rowCandidates(table)) {
      merged = merged ? mergeMissingRates(merged, row) : row;
    }
  }

  return merged;
}

export async function updatePricing(pricingData: PricingByProvider) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );

  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const existing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    existing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      insert.run(provider, JSON.stringify({ ...(existing[provider] || {}), ...models }));
    }
  });
  tx();
  backupDbFile("pre-write");
  invalidateDbCache("pricing"); // Bust the pricing read cache
  const updated: PricingByProvider = {};
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    updated[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }
  return updated;
}

export async function resetPricing(provider: string, model?: string) {
  const db = getDbInstance();

  if (model) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?")
      .get(provider);
    if (row) {
      const rowRecord = toRecord(row);
      const value = typeof rowRecord.value === "string" ? rowRecord.value : "{}";
      const models = toRecord(JSON.parse(value));
      delete models[model];
      if (Object.keys(models).length === 0) {
        db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
      } else {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'pricing' AND key = ?").run(
          JSON.stringify(models),
          provider
        );
      }
    }
  } else {
    db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
  }

  backupDbFile("pre-write");
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const result: Record<string, unknown> = {};
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    result[key] = JSON.parse(rawValue);
  }
  return result;
}

export async function resetAllPricing() {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'pricing'").run();
  backupDbFile("pre-write");
  return {};
}
