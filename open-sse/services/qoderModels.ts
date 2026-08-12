/**
 * Qoder model catalog + credential resolution for the pure-HTTP (COSY) path.
 * Ported from 9router (decolua/9router, MIT).
 *
 * - PAT (pt-...) connections cannot sign COSY requests directly: they are
 *   exchanged for a short-lived job token (jt-...) via
 *   openapi.qoder.sh/api/v1/jobToken/exchange (plain JSON POST), then that
 *   job token is used for signing. Job-token traffic must hit api2.qoder.sh —
 *   api3 rejects jt- with "Login expired" (403).
 * - The live model catalog is fetched from /algo/api/v2/model/list
 *   (COSY-signed) and cached per credential for 1h. Chat requests MUST carry
 *   the exact server-published model_config for the requested key — sending a
 *   stale/wrong block silently downgrades to a different model upstream.
 */

import crypto from "crypto";

import { buildCosyHeaders } from "../shared/qoder/cosy.ts";
import {
  QODER_CHAT_BASE_ALT,
  QODER_JOB_TOKEN_EXCHANGE_URL,
  QODER_MODEL_LIST_URL,
  QODER_USERINFO_URL,
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
} from "../shared/qoder/constants.ts";
import { isQoderPatToken, resolveQoderJobToken } from "./qoderCli.ts";

const FETCH_TIMEOUT_MS = 15_000;
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h

export type QoderModelEntry = {
  id: string;
  name: string;
  contextLength: number;
  isVL: boolean;
  isReasoning: boolean;
  maxOutputTokens: number;
  description: string;
};

type QoderCatalogEntry = {
  expiresAt: number;
  models: QoderModelEntry[];
  rawConfigs: Map<string, Record<string, unknown>>;
};

/** @type {Map<string, { expiresAt: number, accessToken: string, userId: string }>} */
const patJobCache = new Map<string, { accessToken: string; userId: string; expiresAt: number }>();

/** @type {Map<string, QoderCatalogEntry>} */
const catalogCache = new Map<string, QoderCatalogEntry>();

/**
 * In-flight fetch promises keyed by cacheKey. Concurrent first-time callers
 * (parallel chat windows) all observe the same Promise so we fan-out exactly
 * one upstream request per credential per miss.
 * @type {Map<string, Promise<QoderCatalogEntry | null>>}
 */
const inflight = new Map<string, Promise<QoderCatalogEntry | null>>();

/** A Qoder PAT (pt-*) is the only credential type that needs the exchange. */
export function isQoderPat(token: unknown): boolean {
  return typeof token === "string" && isQoderPatToken(token);
}

/**
 * Resolve the Qoder userId for a job token (needed for COSY signing).
 * Returns "" on any failure — callers fall back to the stored userId.
 */
async function fetchUserIdForJobToken(
  jobToken: string,
  signal: AbortSignal | null = null
): Promise<string> {
  try {
    const res = await fetch(QODER_USERINFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
      },
      signal,
    });
    if (!res.ok) return "";
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return String(data.id || data.userId || data.user_id || "");
  } catch {
    return "";
  }
}

/**
 * Resolve a PAT to a job-token credential, cached per-PAT. The job token is
 * short-lived (~24h); we re-exchange once it is within 5 minutes of expiry.
 */
async function resolvePatCredential(
  pat: string,
  signal: AbortSignal | null = null
): Promise<{ accessToken: string; userId: string; expiresAt: number }> {
  const now = Date.now();
  const cached = patJobCache.get(pat);
  if (cached && cached.expiresAt - now > PAT_REFRESH_BUFFER_MS) return cached;

  const jobToken = await resolveQoderJobToken(pat, { signal });
  if (!jobToken || !jobToken.startsWith("jt-")) {
    // resolveQoderJobToken falls back to the raw PAT on exchange failure —
    // a `pt-*` in the Cosy envelope is rejected upstream, so surface the error.
    throw new Error("qoder PAT exchange failed: no job token returned");
  }
  const userId = await fetchUserIdForJobToken(jobToken, signal);
  const resolved = { accessToken: jobToken, userId, expiresAt: now + PAT_DEFAULT_TTL_MS };
  patJobCache.set(pat, resolved);
  return resolved;
}

const PAT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PAT_DEFAULT_TTL_MS = 23 * 60 * 60 * 1000;

type QoderCredentials = Record<string, unknown> & {
  apiKey?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  displayName?: unknown;
  email?: unknown;
  providerSpecificData?: Record<string, unknown>;
};

/**
 * Resolve connection credentials to COSY-signable form:
 *   - PAT (pt-...) connections → exchanged to a job token (jt-...) + userId
 *   - everything else → passed through unchanged
 */
export async function resolveQoderCredentials(
  credentials: QoderCredentials,
  signal: AbortSignal | null = null
): Promise<QoderCredentials> {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "");
  if (isQoderPat(raw)) {
    const resolved = await resolvePatCredential(raw, signal);
    return {
      ...credentials,
      accessToken: resolved.accessToken,
      apiKey: undefined,
      providerSpecificData: {
        authMethod: "pat",
        ...(credentials?.providerSpecificData || {}),
        userId: resolved.userId || credentials?.providerSpecificData?.userId || "",
        machineId: credentials?.providerSpecificData?.machineId || "",
      },
    };
  }
  return credentials;
}

/**
 * Stable cache key per credential (so different login sessions for the same
 * account share an entry).
 */
function cacheKey(credentials: QoderCredentials): string {
  const psd = credentials?.providerSpecificData || {};
  const seed = String(
    psd.userId || credentials?.refreshToken || credentials?.accessToken || "anonymous"
  );
  return crypto.createHash("sha256").update(`qoder:${seed}`).digest("hex");
}

/** Strip credential -> COSY creds for buildCosyHeaders. */
function cosyCredsFromConnection(credentials: QoderCredentials): {
  userId: string;
  authToken: string;
  name: string;
  email: string;
  machineId: string;
} {
  const psd = credentials?.providerSpecificData || {};
  return {
    userId: String(psd.userId || ""),
    authToken: String(credentials?.accessToken || ""),
    name: String(credentials?.displayName || ""),
    email: String(credentials?.email || ""),
    machineId: String(psd.machineId || ""),
  };
}

/**
 * Fetch the live model list for this credential. Returns
 *   { models: [...], rawConfigs: Map<modelKey, modelConfigObject> }
 * or `null` on any error.
 */
async function fetchQoderCatalogRaw(
  credentials: QoderCredentials,
  signal: AbortSignal | null
): Promise<{ models: QoderModelEntry[]; rawConfigs: Map<string, Record<string, unknown>> } | null> {
  const creds = cosyCredsFromConnection(credentials);
  if (!creds.userId || !creds.authToken) return null;

  // Job-token traffic is rejected by api3 ("Login expired" 403) — the
  // official qodercli serves it from api2 instead.
  const modelListUrl = String(creds.authToken).startsWith("jt-")
    ? `${QODER_CHAT_BASE_ALT}/algo/api/v2/model/list`
    : QODER_MODEL_LIST_URL;

  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    ...buildCosyHeaders(Buffer.alloc(0), modelListUrl, creds),
  };

  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;
  let response: Response;
  try {
    timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        abortListener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }
    response = await fetch(modelListUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }

  if (!response.ok) return null;

  const body = (await response.json().catch(() => null)) as {
    chat?: Array<Record<string, unknown>>;
  } | null;
  if (!body || !Array.isArray(body.chat)) return null;

  const models: QoderModelEntry[] = [];
  const rawConfigs = new Map<string, Record<string, unknown>>();
  for (const entry of body.chat) {
    if (!entry || typeof entry !== "object") continue;
    const key = String(entry.key || "");
    if (!key) continue;

    // Always cache the config — chat needs model_config even for UI-hidden
    // models (enable:false). Upstream still accepts chat for these keys.
    rawConfigs.set(key, entry);
    if (entry.enable === false) continue;

    const display = String(entry.display_name || key);
    const ctx = Number(entry.max_input_tokens) || 131_072;
    models.push({
      id: key,
      name: display,
      contextLength: ctx,
      isVL: !!entry.is_vl,
      isReasoning: !!entry.is_reasoning,
      maxOutputTokens: Number(entry.max_output_tokens) || 0,
      description: String(entry.description || ""),
    });
  }

  return { models, rawConfigs };
}

/**
 * Get the cached model_config block for a given model key, fetching the
 * catalog first if needed. Returns null when the catalog can't be fetched.
 */
export async function getQoderModelConfig(
  credentials: QoderCredentials,
  modelKey: string,
  options: { signal?: AbortSignal | null; forceRefresh?: boolean } = {}
): Promise<Record<string, unknown> | null> {
  const cached = await resolveQoderModels(credentials, options);
  if (!cached) return null;
  const config = cached.rawConfigs.get(modelKey);
  if (!config) return null;
  // Defensive copy — chat code may mutate `key` to align with the alias path.
  return { ...config, key: modelKey };
}

/**
 * Resolve the live model catalog + raw configs for a credential. Caches
 * results for CATALOG_TTL_MS and deduplicates concurrent misses.
 */
export async function resolveQoderModels(
  credentials: QoderCredentials,
  options: { signal?: AbortSignal | null; forceRefresh?: boolean } = {}
): Promise<QoderCatalogEntry | null> {
  let resolved: QoderCredentials;
  try {
    resolved = await resolveQoderCredentials(credentials, options.signal || null);
  } catch {
    return null;
  }
  if (!resolved?.accessToken || !(resolved.providerSpecificData || {}).userId) return null;

  const key = cacheKey(resolved);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) return cached;
  }

  // Coalesce concurrent misses on the same credential into one upstream call.
  const existing = inflight.get(key);
  if (existing && !options.forceRefresh) {
    return existing;
  }

  const fetchPromise = (async (): Promise<QoderCatalogEntry | null> => {
    const fetched = await fetchQoderCatalogRaw(resolved, options.signal || null);
    if (!fetched) return null;
    const entry: QoderCatalogEntry = {
      expiresAt: Date.now() + CATALOG_TTL_MS,
      models: fetched.models,
      rawConfigs: fetched.rawConfigs,
    };
    catalogCache.set(key, entry);
    return entry;
  })();

  inflight.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (inflight.get(key) === fetchPromise) {
      inflight.delete(key);
    }
  }
}

export function invalidateQoderCatalog(credentials: QoderCredentials): void {
  if (!credentials) return;
  catalogCache.delete(cacheKey(credentials));
}

export function clearQoderCatalog(): void {
  catalogCache.clear();
}

/** Test-only: drop per-PAT job-token cache so unit tests don't leak state. */
export function __clearQoderPatJobCache(): void {
  patJobCache.clear();
}
