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
import { normalizeAntigravityClientProfile } from "@/shared/constants/antigravityClientProfile";
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
 * Whether a discovery payload actually carries a models collection. `models` may be an
 * array (or an id→model map); anything else means the body is not a catalog answer, so
 * its emptiness must not be read as authoritative.
 */
function hasModelsCollection(payload: unknown): boolean {
  const models = asRecord(payload).models;
  if (Array.isArray(models)) return true;
  const map = asRecord(models);
  return Object.keys(map).length > 0;
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
      if (!hasModelsCollection(payload)) {
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
