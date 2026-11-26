import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import {
  getAntigravityModelsDiscoveryUrls,
  getAntigravityFetchAvailableModelsUrls,
} from "@omniroute/open-sse/config/antigravityUpstream.ts";
import { getAntigravityContentHeaders } from "@omniroute/open-sse/services/antigravityHeaders.ts";
import { resolveAntigravityClientVersion } from "@omniroute/open-sse/services/antigravityClientProfile.ts";
import {
  getClientVisibleAntigravityModelName,
  isDiscoverableAntigravityModelId,
  toClientAntigravityModelId,
} from "@omniroute/open-sse/config/antigravityModelAliases.ts";
import {
  isAntigravityGemini4TierModel,
  isDisabledAntigravityModelId,
} from "@omniroute/open-sse/config/antigravityThinkingLevels.ts";
import {
  getClientVisibleAgyModelName,
  isDiscoverableAgyModelId,
} from "@omniroute/open-sse/config/agyModels.ts";
import {
  type AntigravityClientProfile,
  normalizeAntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";
import { ensureAntigravityProjectAssigned } from "@omniroute/open-sse/services/antigravityProjectBootstrap.ts";
import { persistDiscoveredAntigravityProjectId } from "@omniroute/open-sse/services/antigravityProjectPersist.ts";
import { asRecord, toNonEmptyString } from "./helpers";

const antigravityDiscoveryInflight = new Map<string, Promise<AntigravityDiscoveryResult>>();

/**
 * Result of a discovery sweep: models plus whether the upstream authority answered.
 */
export type AntigravityDiscoveryResult = {
  models: Array<{ id: string; name: string }>;
  /**
   * False when every discovery endpoint failed. Callers MUST NOT treat that as an
   * authoritative empty catalog — doing so persists an empty union over healthy
   * rows and deletes working models after a transient upstream error.
   */
  ok: boolean;
  /**
   * True when the connection's own profile answered but the cli supplement did not.
   * The returned models are then complete for the account's non-tier catalog but say
   * nothing about the tier ids, so the caller must merge rather than replace: replacing
   * drops the four tiers that were working a minute ago.
   */
  degraded?: boolean;
};

/**
 * Top-level keys under which this repo's discovery parsers find a catalog. Verified against
 * the parse sites (`grep -rnoE "\.(data|models|result|...)"`), not guessed: `data` (93
 * sites), `models` (56), `results` (15), `result` (11), `availableModels` (4), `items` (2).
 */
const CATALOG_CONTAINER_KEYS = [
  "data",
  "models",
  "result",
  "results",
  "availableModels",
  "items",
] as const;

/**
 * Top-level keys that carry an error instead of a catalog, across the API dialects these
 * providers speak: REST (`{"error": ...}`), Google/GCP (`{"fault": ...}`), FastAPI
 * (`{"detail": ...}`), and the plural REST form (`{"errors": [...]}`).
 */
const ERROR_ENVELOPE_KEYS = ["error", "errors", "fault", "detail"] as const;

/**
 * Whether a value is a model entry.
 *
 * The identity fields are exactly the ones `normalizeDiscoveredModels` reads
 * (`id` || `name` || `model`) — anything else would be dropped on write, so an array of such
 * values persists ZERO models no matter how long it is. Keeping the two definitions in step is
 * what makes "is this a catalog" mean "would this persist anything".
 */
function looksLikeModelEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  for (const field of ["id", "name", "model", "displayName", "display_name"] as const) {
    const raw = entry[field];
    if (typeof raw === "string" && raw.trim().length > 0) return true;
  }
  return false;
}

/**
 * Whether the value under a catalog container key is actually a catalog.
 *
 * This is CONTENT-aware on purpose. A container key being present with an object under it
 * proves nothing: `{"data":{"error":{"code":429}}}` is an error envelope wrapped in the
 * provider's normal container, and reading it as "the account has nothing" deletes a healthy
 * catalog behind a 200. That is the round-5 BF-1 defect, still reachable in round 9 because the
 * test was shape-aware (`typeof value === "object"`) rather than content-aware.
 *
 * Accepted shapes:
 *   - an ARRAY (any length — an empty one is a real, authoritative answer)
 *   - an id→model MAP whose values are model-shaped objects (any count, including zero)
 * Everything else — a string, a number, a nested error envelope, `{}`, `{error:...}` — is not
 * a catalog and must not be read as an empty one.
 */
function isCatalogContainerValue(value: unknown, key: string, depth = 0): boolean {
  if (Array.isArray(value)) {
    // An EMPTY array is a real answer (the account has nothing).
    if (value.length === 0) return true;
    // A non-empty array is a catalog only if at least one element is model-shaped. Length is
    // not evidence: `[{error:{code:429}}]`, `["Service temporarily unavailable"]` and `[null]`
    // are all length 1, and every one of them persists zero models while the route's
    // `models.length === 0` test stays false — wiping the stored catalog behind a 200.
    return value.some((entry) => looksLikeModelEntry(entry));
  }
  if (typeof value !== "object" || value === null) return false;
  // A nested error envelope is not a catalog, whatever container it hides in.
  if (hasErrorEnvelopeDeep(value)) return false;
  const record = value as Record<string, unknown>;
  const entries = Object.values(record);

  if (entries.length === 0) {
    // `{"models":{}}` is the documented id→model map with zero entries — a real answer.
    // `{"data":{}}` is not: every parser reads `data` as an ARRAY, so an empty object there
    // carries no catalog at all and must not be read as an empty account.
    return key === "models";
  }

  // A DIRECT id→model map (`{"models":{"glm-5":{...}}}`).
  if (entries.every(looksLikeModelEntry)) return true;

  // A catalog wrapped one envelope deeper — `{"data":{"data":[...]}}` (zai-web) and
  // `{"data":{"models":[...]}}` — is still a catalog. Bounded depth so a pathological body
  // cannot recurse forever, and the nested value must satisfy the same content test.
  if (depth < 2) {
    for (const containerKey of CATALOG_CONTAINER_KEYS) {
      if (!(containerKey in record)) continue;
      if (isCatalogContainerValue(record[containerKey], containerKey, depth + 1)) return true;
    }
  }

  return false;
}

/**
 * Whether an error envelope appears at this level, in any of the dialects these providers speak
 * (REST `error`/`errors`, GCP `fault`, FastAPI `detail`), OR nested one container level down
 * under a known catalog key (`{"data":{"error":...}}`).
 */
function hasErrorEnvelopeDeep(payload: unknown): boolean {
  if (hasErrorEnvelope(payload)) return true;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return CATALOG_CONTAINER_KEYS.some((key) => key in record && hasErrorEnvelope(record[key]));
}

/**
 * Keys that accompany an EMPTY catalog when the upstream is really reporting a problem.
 *
 * Providers answer `200 {"data":[],"message":"Quota exceeded","code":429}` — a real error with an
 * empty array attached. The array shape is valid and empty, so a content-aware container test
 * alone reads it as "this account has no models" and deletes every stored row. The signal lives
 * in a SIBLING key, which no container-level test can see.
 */
/**
 * String values that mean "nothing went wrong" when they accompany an empty catalog.
 */
const BENIGN_ENVELOPE_STRINGS = new Set([
  "ok",
  "success",
  "succeeded",
  "completed",
  "complete",
  "done",
  "empty",
  "no content",
  "none",
  "null",
  "list",
  "collection",
  "page",
  "object",
]);

/**
 * Keys whose boolean `false` is a pagination flag rather than a failure report.
 *
 * `false` is an error by DEFAULT (`{"success":false}` is the classic one), so the exceptions
 * have to be named explicitly.
 */
const BENIGN_FALSE_KEYS = new Set([
  "has_more",
  "hasmore",
  "has_next",
  "hasnext",
  "incomplete",
  "truncated",
  // `error: false` is the explicit statement that there is no error — the OpenAI-dialect
  // spelling several proxies emit. It was the one non-empty-looking key that still refused a
  // legitimately empty catalog.
  "error",
  "errors",
  "fault",
]);

/**
 * Whether ONE non-container value is provably harmless next to an empty catalog.
 *
 * This replaced an enumerated list of error keys (`message`, `code`, `status`, ...). That list
 * was whack-a-mole: the reviewer only had to answer `{"data":[],"msg":"Too Many Requests"}`,
 * `{"data":[],"statusCode":429}`, `{"data":[],"meta":{"code":429}}`,
 * `{"data":[],"code":-32000}` or `{"data":[],"Message":"quota"}` — none of which are spelled
 * in the list — and the catalog was deleted behind a 200. Default-deny on unknown keys is the
 * only rule that does not depend on guessing every provider's spelling.
 */
function isBenignEnvelopeValue(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) return true;
    return BENIGN_ENVELOPE_STRINGS.has(text);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    // 0 and 2xx say "fine". Negative numbers and >= 400 are status/error codes.
    return value === 0 || (value >= 200 && value < 400);
  }
  if (typeof value === "boolean") return value === true || BENIGN_FALSE_KEYS.has(key.toLowerCase());
  if (Array.isArray(value)) return value.length === 0;
  // An EMPTY object carries nothing; a non-empty one is a structured reason
  // (`{"meta":{"code":429}}`).
  return typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0;
}

/**
 * Whether a container value is EMPTY but shape-valid — i.e. it would persist nothing while
 * still being a legitimate "the account has nothing" answer.
 *
 * `{"data":[]}` qualifies. `{"data":{},"result":{"code":429}}` does not: presence of one empty
 * container must not launder a sibling that is really an error report.
 */
function isShapeValidEmptyCatalogValue(value: unknown, key: string, depth = 0): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length === 0) return key === "models";
  if (hasErrorEnvelopeDeep(record)) return false;
  if (depth >= 2) return false;
  let sawContainer = false;
  for (const [entryKey, entryValue] of entries) {
    if (!(CATALOG_CONTAINER_KEYS as readonly string[]).includes(entryKey)) return false;
    sawContainer = true;
    if (!isShapeValidEmptyCatalogValue(entryValue, entryKey, depth + 1)) return false;
  }
  return sawContainer;
}

/**
 * Whether ANY depth of the value holds a model-shaped entry.
 *
 * `{"data":{"data":[{"id":"a"}]}}` (zai-web) and `{"data":{"models":[...]}}` (qwen-web) nest the
 * real catalog one envelope down. A non-recursive test calls those "nothing persists" and then
 * treats the body as an empty-or-broken answer.
 */
function persistsAnyModel(value: unknown, depth: number): boolean {
  if (Array.isArray(value)) return value.some((entry) => looksLikeModelEntry(entry));
  if (typeof value !== "object" || value === null) return false;
  if (depth >= 2) return false;
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (looksLikeModelEntry(entry)) return true;
    if ((CATALOG_CONTAINER_KEYS as readonly string[]).includes(key)) {
      if (persistsAnyModel(entry, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Whether a catalog payload actually carries a models collection.
 *
 * Callers use this to SKIP an endpoint instead of answering "the account has nothing" — that
 * answer clears the stored catalog behind a 200 with no call log.
 *
 * The test is POSITIVE and CONTENT-aware: a known catalog container must be present AND must
 * hold something catalog-shaped. Earlier versions were progressively less wrong:
 *   - "any top-level array or object" accepted `{"errors":[...]}` and `{"fault":{...}}`
 *   - "any object under a known key" accepted `{"data":{"error":{...}}}`
 * Both read as empty catalogs and wiped healthy ones. Presence of a key is not evidence.
 */
export function hasCatalogCollection(payload: unknown): boolean {
  // A bare array is the whole catalog (AI/ML API answers with a top-level list) — but only
  // when it actually holds model entries. `[{"error":{"code":429}}]` is a top-level error
  // array, not an empty account.
  if (Array.isArray(payload)) {
    if (payload.length === 0) return true;
    return payload.some((entry) => looksLikeModelEntry(entry));
  }
  const record = asRecord(payload);
  // An error envelope at the top level is never a catalog, even when a container key is also
  // present (`{"data": [], "error": {...}}` answers an error, not an empty account).
  if (hasErrorEnvelope(record)) return false;

  const containerKeys = CATALOG_CONTAINER_KEYS.filter((key) => key in record);
  if (containerKeys.length === 0) return false;

  const wouldPersistSomething = containerKeys.some((key) => persistsAnyModel(record[key], 0));

  if (!wouldPersistSomething) {
    // Nothing here would persist a model, so the body is claiming "this account is empty".
    // That claim is only authoritative when EVERY other key in the envelope is provably
    // harmless. Default-deny: an unrecognised key might be this provider's way of reporting
    // the failure that produced the empty list, and reading it as "no models" deletes the
    // stored catalog behind a 200. `{"data":[],"msg":"Too Many Requests"}` is the shape that
    // proved an enumerated error-key list was not enough.
    for (const [key, value] of Object.entries(record)) {
      if ((CATALOG_CONTAINER_KEYS as readonly string[]).includes(key)) {
        if (!isShapeValidEmptyCatalogValue(value, key)) return false;
        continue;
      }
      if (!isBenignEnvelopeValue(key, value)) return false;
    }
  }

  return containerKeys.some((key) => isCatalogContainerValue(record[key], key));
}

/**
 * Whether the PARSED model list contradicts the body that produced it.
 *
 * `hasCatalogCollection` answers a body-level question — "does this payload carry models
 * somewhere in a known container?" — which is the right test for deciding whether an endpoint
 * answered at all. It is NOT the same question as "did the parser read them": each provider
 * reads one specific key (`data.data`, `data.models`, `result`, ...).
 *
 * `{"data": [], "models": [{"id":"x"}]}` answers BOTH true to "carries a catalog" and zero to
 * the generic parser, because `data.data` is an array and therefore wins the branch. Reading that
 * emptying as an authoritative "this account has no models" deletes the very rows the body was
 * carrying — the exact failure the catalog guards exist to prevent, arrived at from the inside.
 * Every empty-decision site must ask THIS question after parsing, not just the body-level one.
 */
export function catalogParseDiverges(payload: unknown, parsedCount: number | undefined): boolean {
  // A provider parser can return a NON-ARRAY (`data.data` is whatever upstream sent), so a raw
  // `.length` read is `undefined` and silently compares false. Treat "no usable count" the same
  // as zero: if the body carries a model the parse did not produce, the parse is not evidence.
  const count = typeof parsedCount === "number" && Number.isFinite(parsedCount) ? parsedCount : 0;
  return count === 0 && persistsAnyModel(payload, 0);
}

/**
 * Whether a payload carries an error envelope instead of a catalog. Providers answer 200
 * with an error often enough that a parser reading `data.data || data.models || []` turns it
 * into an empty catalog; callers check this before acting on that emptiness.
 */
export function hasErrorEnvelope(payload: unknown): boolean {
  const record = asRecord(payload);
  return ERROR_ENVELOPE_KEYS.some((key) => {
    if (!(key in record)) return false;
    const value = record[key];
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "boolean") return value === true;
    if (typeof value === "number") return value !== 0;
    // An EMPTY container carries no error. This matters concretely: Cloudflare Workers AI
    // answers every SUCCESSFUL response with `{result:[...], success:true, errors:[], messages:[]}`,
    // so counting `errors: []` as a failure rejected the live catalog for that provider at every
    // guard site and silently served the 13-entry local fallback instead. `{"error":{}}` and
    // `{"detail":{}}` are equally empty.
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
  });
}

type AntigravityDiscoveryModel = {
  id: string;
  name: string;
  isInternal?: boolean;
};

export function normalizeAntigravityModelsResponse(data: unknown): AntigravityDiscoveryModel[] {
  const payload = asRecord(data).models;

  if (Array.isArray(payload)) {
    return payload
      .map((value) => {
        const item = asRecord(value);
        const id =
          typeof item.id === "string"
            ? item.id
            : typeof item.name === "string"
              ? item.name
              : typeof item.model === "string"
                ? item.model
                : "";
        const name =
          typeof item.displayName === "string"
            ? item.displayName
            : typeof item.name === "string"
              ? item.name
              : id;
        return id ? { id, name, ...(item.isInternal === true ? { isInternal: true } : {}) } : null;
      })
      .filter((value): value is AntigravityDiscoveryModel => Boolean(value));
  }

  const modelsById = asRecord(payload);
  return Object.entries(modelsById)
    .map(([id, value]) => {
      const item = asRecord(value);
      const name =
        typeof item.displayName === "string"
          ? item.displayName
          : typeof item.name === "string"
            ? item.name
            : id;
      return id ? { id, name, ...(item.isInternal === true ? { isInternal: true } : {}) } : null;
    })
    .filter((value): value is AntigravityDiscoveryModel => Boolean(value));
}

export function filterUserCallableAntigravityModels(
  models: AntigravityDiscoveryModel[],
  provider: "antigravity" | "agy" = "antigravity"
) {
  return models.filter(
    (model) =>
      model.isInternal !== true &&
      !isDisabledAntigravityModelId(model.id) &&
      (provider === "agy"
        ? isDiscoverableAgyModelId(model.id)
        : isDiscoverableAntigravityModelId(model.id))
  );
}

/**
 * Warning surfaced when the cli supplement fails but the primary sweep succeeded: the
 * tier rows come from last-known-good state rather than this refresh.
 */
export const DEGRADED_TIER_WARNING =
  "CLI model discovery failed — Gemini 4 tier models kept from the last successful refresh";

/**
 * Re-add the four Hydrogen tier ids from the connection's last-known-good rows when a
 * cli sweep failed. Everything else stays exactly as the primary sweep reported: the
 * authoritative profile owns the non-tier catalog, and the supplement can only ever
 * contribute tiers.
 */
export function mergeLastKnownTiers(
  models: Array<{ id: string; name: string }>,
  lastKnownGood: ReadonlyArray<{ id: string; name: string }>
): Array<{ id: string; name: string }> {
  const merged = [...models];
  const seen = new Set(merged.map((model) => model.id));
  for (const model of lastKnownGood) {
    if (!isAntigravityGemini4TierModel(model.id)) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push({ id: model.id, name: model.name || model.id });
  }
  return merged;
}

/**
 * Re-exported so existing callers of the discovery module keep working; the single
 * definition (and its rationale) lives in the catalog fact module.
 */
export { isDisabledAntigravityModelId };

export function mapAntigravityModelForClient(
  model: { id: string; name: string },
  provider: "antigravity" | "agy" = "antigravity"
): {
  id: string;
  name: string;
} {
  const clientId = toClientAntigravityModelId(model.id);
  return {
    id: clientId,
    name:
      provider === "agy"
        ? getClientVisibleAgyModelName(clientId, model.name)
        : getClientVisibleAntigravityModelName(clientId, model.name),
  };
}

export async function fetchAntigravityDiscoveryModelsCached(
  accessToken: string,
  connectionId: string,
  proxy: unknown,
  providerSpecificData?: unknown,
  provider: "antigravity" | "agy" = "antigravity"
): Promise<AntigravityDiscoveryResult> {
  const profile = normalizeAntigravityClientProfile(asRecord(providerSpecificData).clientProfile);
  const cacheKey = `${provider}:${connectionId}:${accessToken.substring(0, 16)}:${profile}`;
  const inflight = antigravityDiscoveryInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async (): Promise<AntigravityDiscoveryResult> => {
    await resolveAntigravityClientVersion(profile);
    const discovered = await ensureAntigravityProjectAssigned(accessToken, fetch, profile);
    if (discovered) {
      // #8491: persist the recovered id so it survives the next token refresh
      // or process restart instead of being silently rediscovered every time.
      await persistDiscoveredAntigravityProjectId(
        connectionId,
        discovered,
        asRecord(providerSpecificData)
      );
    }

    // The connection's own profile is the AUTHORITATIVE catalog: it is what this
    // account actually sees, and it owns every non-tier model. A failed sweep here
    // is NOT authoritative emptiness — reporting [] would let the route persist an
    // empty union over a healthy catalog, deleting working models because a
    // transient 503 hit the one profile that matters.
    const primary = await discoverAntigravityModelsForKey(profile, accessToken, proxy, provider);
    if (!primary.ok) {
      return { models: [], ok: false };
    }

    // Gemini 4 Hydrogen tier ids (low|medium|high|xhigh) are advertised only by the
    // cli catalog: the ide catalog lists 17 models and contains none of them. If the
    // connection runs ide, supplement the authoritative catalog with EXACTLY the four
    // entitled tier ids — never the rest of the cli catalog, which would publish
    // unrelated cli-only models the non-tier path deliberately keeps on ide.
    if (profile === "cli") {
      return { models: primary.models, ok: true };
    }

    const merged = [...primary.models];
    const seen = new Set(merged.map((model) => model.id));
    const cli = await discoverAntigravityModelsForKey("cli", accessToken, proxy, provider);
    for (const model of cli.models) {
      if (!isAntigravityGemini4TierModel(model.id)) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }

    // A cli outage says nothing about the tier ids: the account still has them, we
    // just could not see them this sweep. Reporting `degraded` lets the caller keep
    // the tiers it already has instead of persisting an ide-only union that deletes
    // all four. A successful but empty cli catalog is authoritative and NOT degraded —
    // that would be a real entitlement change.
    return { models: merged, ok: true, degraded: !cli.ok };
  })().finally(() => {
    antigravityDiscoveryInflight.delete(cacheKey);
  });

  antigravityDiscoveryInflight.set(cacheKey, promise);
  return promise;
}

/**
 * One discovery pass for a single client profile. `ok` reports whether any discovery
 * URL answered successfully — an empty `models` list with `ok: true` means the
 * upstream authoritatively returned nothing, which is a different fact from a sweep
 * where every endpoint failed.
 */
async function discoverAntigravityModelsForKey(
  profile: AntigravityClientProfile,
  accessToken: string,
  proxy: unknown,
  provider: "antigravity" | "agy"
): Promise<{ models: Array<{ id: string; name: string }>; ok: boolean }> {
  await resolveAntigravityClientVersion(profile);

  for (const discoveryUrl of [
    ...getAntigravityFetchAvailableModelsUrls(),
    ...getAntigravityModelsDiscoveryUrls(),
  ]) {
    try {
      const response = await safeOutboundFetch(discoveryUrl, {
        ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
        guard: getProviderOutboundGuard(),
        proxyConfig: proxy,
        method: "POST",
        headers: getAntigravityContentHeaders(profile, accessToken),
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(
          `[models] ${provider} discovery failed at ${discoveryUrl} (${response.status}): ${errorText}`
        );
        continue;
      }

      const payload = await response.json();
      const models = filterUserCallableAntigravityModels(
        normalizeAntigravityModelsResponse(payload),
        provider
      ).map((model) => mapAntigravityModelForClient(model, provider));
      // An empty list is only authoritative if the body actually HAD a models
      // collection. A 200 with an unexpected shape (an error envelope, a redirect page)
      // carries no information about the catalog, and treating it as "the account has
      // nothing" would suppress a healthy later endpoint and publish a partial catalog.
      //
      // The test is the SAME content-aware classifier the generic path uses, not a shape
      // check. `hasModelsCollection` only asked whether `models` was an object, so
      // `{"models":{"error":{"code":429}}}` passed it, `normalizeAntigravityModelsResponse`
      // turned the map KEY `error` into a model named "error", the sweep answered `ok:true`,
      // and that single bogus row replaced the whole catalog. `{"models":[],"error":true}`
      // passed it too and deleted every stored row as an authoritative empty.
      if (!hasCatalogCollection(payload)) {
        console.warn(
          `[models] ${provider} discovery at ${discoveryUrl} returned no models collection — skipping`
        );
        continue;
      }
      return { models, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[models] ${provider} discovery threw for ${discoveryUrl}: ${message}`);
    }
  }

  return { models: [], ok: false };
}

export function normalizeDataRobotCatalogResponse(
  data: unknown
): Array<{ id: string; name: string }> {
  const items = Array.isArray(asRecord(data).data) ? (asRecord(data).data as unknown[]) : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const model =
        toNonEmptyString(item.model) || toNonEmptyString(item.id) || toNonEmptyString(item.name);
      if (!model) return null;
      if (item.isActive === false) return null;
      const name = toNonEmptyString(item.label) || toNonEmptyString(item.displayName) || model;
      return { id: model, name };
    })
    .filter((value): value is { id: string; name: string } => Boolean(value));
}

export function normalizeOpenAiLikeModelsResponse(
  data: unknown,
  fallbackOwner: string
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : Array.isArray(payload.models)
        ? (payload.models as unknown[])
        : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.id) || toNonEmptyString(item.model) || toNonEmptyString(item.name);
      if (!id) return null;
      const name =
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy =
        toNonEmptyString(item.owned_by) || toNonEmptyString(item.provider) || fallbackOwner;
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}

export function normalizeSapModelsResponse(
  data: unknown
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(payload.resources) ? (payload.resources as unknown[]) : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.model) || toNonEmptyString(item.id) || toNonEmptyString(item.name);
      if (!id) return null;
      const name =
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy = toNonEmptyString(item.provider) || "sap";
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}

export function normalizeAzureModelsResponse(
  data: unknown,
  fallbackOwner = "azure-ai"
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : Array.isArray(payload.models)
        ? (payload.models as unknown[])
        : Array.isArray(payload.value)
          ? (payload.value as unknown[])
          : Array.isArray(payload.deployments)
            ? (payload.deployments as unknown[])
            : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.id) ||
        toNonEmptyString(item.deployment_name) ||
        toNonEmptyString(item.deploymentName) ||
        toNonEmptyString(item.name) ||
        toNonEmptyString(item.model);
      if (!id) return null;
      const name =
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy =
        toNonEmptyString(item.owned_by) || toNonEmptyString(item.provider) || fallbackOwner;
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}
