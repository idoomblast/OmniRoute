/**
 * kenariQuotaFetcher.ts — Kenari subscription / plan quota fetcher.
 *
 * Kenari exposes the subscriber's plan windows at
 *   GET https://kenari.id/api/subscription
 * authenticated by the website session cookie `__Host-kn_session` (the routing
 * API key `kn-...` is a different credential and is NOT accepted there).
 *
 * The cookie is host-locked, so this fetcher must call kenari.id directly and
 * must never route the request through the proxy pool. The cookie itself is
 * read from the connection's `providerSpecificData.kenariSessionCookie` (or
 * `KENARI_SESSION_COOKIE` / `KENARI_SESSION_COOKIE_FILE`) so it can be
 * refreshed without rebuilding the image.
 *
 * Response shape (plan Kreator, 2026-11-26):
 *   {
 *     plan_id, plan_name, plan_status,
 *     window_week:  { used_frac: 0.18, resets_in_secs: 463578 },
 *     window_month: { used_frac: 0.04, resets_in_secs: 2450778 },
 *     window_5h: null,
 *     free_tier: { daily_used, daily_limit, reset_in_secs },
 *     weekly_reset: { available, week_left_micro_idr, month_left_micro_idr },
 *     web_search: { allowance, used_today },
 *     plan_live, near_limit, auto_renew, restart
 *   }
 *
 * `used_frac` is 0..1 (not 0..100); money fields are micro-IDR (divide by
 * 1e6). `daily_limit = 0` means "not applicable" — never divide by it.
 */

import fs from "node:fs";
import { registerQuotaFetcher, registerQuotaWindows, type QuotaInfo } from "./quotaPreflight.ts";
import { registerMonitorFetcher } from "./quotaMonitor.ts";
import { throttleQuotaFetch } from "./quotaFetchThrottle.ts";

const KENARI_SUBSCRIPTION_URL = "https://kenari.id/api/subscription";
const KENARI_REFERER = "https://kenari.id/usage";
const KENARI_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:161.0) Gecko/20100101 Firefox/161.0";
const CACHE_TTL_MS = 60_000;
const MICRO_IDR_PER_IDR = 1_000_000;

export const KENARI_WINDOW_5H = "5h";
export const KENARI_WINDOW_WEEKLY = "weekly";
export const KENARI_WINDOW_MONTHLY = "monthly";
export const KENARI_WINDOW_WEB_SEARCH = "web_search";

type JsonRecord = Record<string, unknown>;

export interface KenariWindowQuota {
  /** Remaining percentage, 0..100 (UI contract). */
  remainingPercentage: number;
  /** Used percentage, 0..100. */
  used: number;
  /** Plan window size in percent points. */
  total: number;
  percentUsed: number;
  resetAt: string | null;
  resetsInSecs: number | null;
}

export interface KenariWebSearchQuota {
  allowance: number;
  used: number;
  remainingPercentage: number;
}

export interface KenariQuota extends QuotaInfo {
  planId: string | null;
  planName: string | null;
  planStatus: string | null;
  windowsDetail: Partial<Record<string, KenariWindowQuota>>;
  webSearch: KenariWebSearchQuota | null;
  freeTier: { dailyUsed: number; dailyLimit: number; resetAt: string | null } | null;
  weeklyResetAvailable: boolean;
  weekLeftIdr: number | null;
  monthLeftIdr: number | null;
  nearLimit: boolean;
}

export type KenariQuotaFailureReason = "missing_cookie" | "expired" | "error" | null;

export interface KenariQuotaFetchResult {
  quota: KenariQuota | null;
  reason: KenariQuotaFailureReason;
}

interface CacheEntry {
  quota: KenariQuota;
  fetchedAt: number;
}

const quotaCache = new Map<string, CacheEntry>();

const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaCache) {
    if (now - entry.fetchedAt > CACHE_TTL_MS * 5) quotaCache.delete(key);
  }
}, 5 * 60_000);
if (typeof _cacheCleanup === "object" && "unref" in _cacheCleanup) {
  (_cacheCleanup as { unref?: () => void }).unref?.();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundPercent(value: number): number {
  return Math.round(value * 100);
}

/** Accepts a raw cookie value, a `__Host-kn_session=...` pair, or a full Cookie header. */
export function normalizeKenariCookie(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/__Host-kn_session\s*=/.test(trimmed)) return trimmed;
  if (trimmed.includes(";") && trimmed.includes("=")) return trimmed;
  return `__Host-kn_session=${trimmed}`;
}

/**
 * Resolve the session cookie without ever hardcoding it:
 *   1. `providerSpecificData.kenariSessionCookie` (editable per connection, no redeploy)
 *   2. `KENARI_SESSION_COOKIE` env
 *   3. `KENARI_SESSION_COOKIE_FILE` (mode-600 file, re-readable at runtime)
 */
export function resolveKenariSessionCookie(connection?: Record<string, unknown>): string | null {
  const psd = toRecord(connection?.providerSpecificData);
  const fromConnection = nonEmptyString(psd.kenariSessionCookie);
  if (fromConnection) return normalizeKenariCookie(fromConnection);

  const fromEnv = nonEmptyString(process.env.KENARI_SESSION_COOKIE);
  if (fromEnv) return normalizeKenariCookie(fromEnv);

  const filePath = nonEmptyString(process.env.KENARI_SESSION_COOKIE_FILE);
  if (filePath) {
    try {
      const content = nonEmptyString(fs.readFileSync(filePath, "utf8"));
      if (content) return normalizeKenariCookie(content);
    } catch {
      // Missing/unreadable credential file — fall through to "missing cookie".
    }
  }

  return null;
}

function parseWindow(value: unknown, now: number): KenariWindowQuota | null {
  const record = toRecord(value);
  const usedFrac = toFiniteNumber(record.used_frac);
  if (usedFrac === null) return null;

  const fraction = clampFraction(usedFrac);
  const resetsInSecs = toFiniteNumber(record.resets_in_secs);
  const used = roundPercent(fraction);

  return {
    used,
    total: 100,
    remainingPercentage: Math.max(0, 100 - used),
    percentUsed: fraction,
    resetsInSecs,
    resetAt:
      resetsInSecs !== null && resetsInSecs >= 0
        ? new Date(now + resetsInSecs * 1000).toISOString()
        : null,
  };
}

function parseWebSearch(value: unknown): KenariWebSearchQuota | null {
  const record = toRecord(value);
  const allowance = toFiniteNumber(record.allowance) ?? 0;
  if (allowance <= 0) return null;
  const used = Math.max(0, toFiniteNumber(record.used_today) ?? 0);
  const usedPct = Math.min(100, (used / allowance) * 100);
  return {
    allowance,
    used,
    remainingPercentage: Math.max(0, Math.round(100 - usedPct)),
  };
}

function parseFreeTier(value: unknown, now: number): KenariQuota["freeTier"] {
  const record = toRecord(value);
  const dailyLimit = toFiniteNumber(record.daily_limit) ?? 0;
  if (dailyLimit <= 0) return null;
  const dailyUsed = Math.max(0, toFiniteNumber(record.daily_used) ?? 0);
  const resetsInSecs = toFiniteNumber(record.reset_in_secs);
  return {
    dailyUsed,
    dailyLimit,
    resetAt:
      resetsInSecs !== null && resetsInSecs >= 0
        ? new Date(now + resetsInSecs * 1000).toISOString()
        : null,
  };
}

function microIdrToIdr(value: unknown): number | null {
  const micro = toFiniteNumber(value);
  if (micro === null) return null;
  return Math.round(micro / MICRO_IDR_PER_IDR);
}

export function parseKenariSubscription(data: unknown, now = Date.now()): KenariQuota | null {
  const root = toRecord(data);
  const windowWeek = parseWindow(root.window_week, now);
  const windowMonth = parseWindow(root.window_month, now);
  const window5h = parseWindow(root.window_5h, now);

  if (!windowWeek && !windowMonth && !window5h) return null;

  const windowEntries: Array<[string, KenariWindowQuota]> = [];
  if (windowWeek) windowEntries.push([KENARI_WINDOW_WEEKLY, windowWeek]);
  if (windowMonth) windowEntries.push([KENARI_WINDOW_MONTHLY, windowMonth]);
  if (window5h) windowEntries.push([KENARI_WINDOW_5H, window5h]);

  const windowsDetail = Object.fromEntries(windowEntries) as KenariQuota["windowsDetail"];
  const worst = windowEntries.reduce((max, [, window]) => Math.max(max, window.percentUsed), 0);
  const worstWindow = windowEntries.find(([, window]) => window.percentUsed === worst)?.[1];

  const weeklyReset = toRecord(root.weekly_reset);
  const freeTier = parseFreeTier(root.free_tier, now);

  return {
    used: roundPercent(worst),
    total: 100,
    percentUsed: worst,
    resetAt: worstWindow?.resetAt ?? null,
    windows: Object.fromEntries(
      windowEntries.map(([name, window]) => [
        name,
        { percentUsed: window.percentUsed, resetAt: window.resetAt },
      ])
    ),
    limitReached: worst >= 1 - 1e-9,
    plan: nonEmptyString(root.plan_name),
    planId: nonEmptyString(root.plan_id),
    planName: nonEmptyString(root.plan_name),
    planStatus: nonEmptyString(root.plan_status),
    windowsDetail,
    webSearch: parseWebSearch(root.web_search),
    freeTier,
    weeklyResetAvailable: weeklyReset.available === true,
    weekLeftIdr: microIdrToIdr(weeklyReset.week_left_micro_idr),
    monthLeftIdr: microIdrToIdr(weeklyReset.month_left_micro_idr),
    nearLimit: root.near_limit === true,
  };
}

// ─── Core fetcher ────────────────────────────────────────────────────────────

export async function fetchKenariQuotaDetailed(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<KenariQuotaFetchResult> {
  const cached = quotaCache.get(connectionId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { quota: cached.quota, reason: null };
  }

  const cookie = resolveKenariSessionCookie(connection);
  if (!cookie) return { quota: null, reason: "missing_cookie" };

  try {
    await throttleQuotaFetch();
    const response = await fetch(KENARI_SUBSCRIPTION_URL, {
      method: "GET",
      headers: {
        Cookie: cookie,
        "X-Kenari-Locale": "id",
        Referer: KENARI_REFERER,
        "User-Agent": KENARI_USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (response.status === 401 || response.status === 403) {
      quotaCache.delete(connectionId);
      return { quota: null, reason: "expired" };
    }
    if (!response.ok) return { quota: null, reason: "error" };

    const data = await response.json();
    const quota = parseKenariSubscription(data);
    if (!quota) return { quota: null, reason: "error" };

    quotaCache.set(connectionId, { quota, fetchedAt: Date.now() });
    return { quota, reason: null };
  } catch {
    return { quota: null, reason: "error" };
  }
}

/** `QuotaFetcher`-compatible entry point (preflight / monitor). */
export async function fetchKenariQuota(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<QuotaInfo | null> {
  const { quota } = await fetchKenariQuotaDetailed(connectionId, connection);
  return quota;
}

export function invalidateKenariQuotaCache(connectionId: string): void {
  quotaCache.delete(connectionId);
}

export function registerKenariQuotaFetcher(): void {
  registerQuotaFetcher("kenari", fetchKenariQuota);
  registerMonitorFetcher("kenari", fetchKenariQuota);
  registerQuotaWindows("kenari", [KENARI_WINDOW_WEEKLY, KENARI_WINDOW_MONTHLY, KENARI_WINDOW_5H]);
}
