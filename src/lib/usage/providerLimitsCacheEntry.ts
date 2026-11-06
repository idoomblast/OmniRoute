import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { setQuotaCache } from "@/domain/quotaCache";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function toProviderLimitsCacheEntry(
  usage: JsonRecord,
  source: string,
  // A fetcher that serves its last known quota (e.g. Claude during a 429 cooldown) flags it
  // `_stale` with the original read time — keep that time instead of stamping it as fresh.
  fetchedAt = usage._stale === true && typeof usage._staleSince === "string"
    ? usage._staleSince
    : new Date().toISOString()
): ProviderLimitsCacheEntry {
  const value = Number(usage.bankedResetCredits);
  return {
    quotas: isRecord(usage.quotas) ? usage.quotas : null,
    ...(isRecord(usage.modelQuotas) ? { modelQuotas: usage.modelQuotas } : {}),
    plan: usage.plan ?? null,
    message: typeof usage.message === "string" ? usage.message : null,
    fetchedAt,
    source,
    bankedResetCredits: Number.isFinite(value) ? value : undefined,
  };
}

/** Persist a usage reading's shared and per-model windows into the quota cache. */
export function setQuotaCacheFromUsage(
  connectionId: string,
  provider: string,
  usage: JsonRecord
): void {
  if (!isRecord(usage.quotas)) return;
  setQuotaCache(
    connectionId,
    provider,
    usage.quotas,
    isRecord(usage.modelQuotas) ? usage.modelQuotas : {}
  );
}

/**
 * Keep the last usable reading when a refresh produced only a message (for
 * example a 429 cooldown serving stale data). A model-only reading still counts
 * as usable: Claude reports display-only `modelQuotas` beside shared windows.
 */
export function mergeProviderLimitsCacheEntry(
  _provider: string,
  next: ProviderLimitsCacheEntry,
  previous: ProviderLimitsCacheEntry | null | undefined
): ProviderLimitsCacheEntry {
  if (!previous) return next;
  const previousUsable = Boolean(
    (previous.quotas && Object.keys(previous.quotas).length > 0) ||
    (previous.modelQuotas && Object.keys(previous.modelQuotas).length > 0)
  );
  if (!next.quotas && next.message && previousUsable) return previous;
  return next;
}
