/**
 * usage/kenari.ts — Kenari subscription usage leaf.
 *
 * Delegates to the cookie-based `kenariQuotaFetcher` and reshapes the plan
 * windows into the standard `{ plan, quotas }` usage response consumed by
 * Provider Limits. The routing API key (`kn-...`) cannot read the subscription
 * endpoint; the website session cookie is resolved from
 * `providerSpecificData.kenariSessionCookie` (or the env/file fallbacks).
 */

import {
  fetchKenariQuotaDetailed,
  type KenariQuota,
  type KenariQuotaFailureReason,
  KENARI_WINDOW_5H,
  KENARI_WINDOW_MONTHLY,
  KENARI_WINDOW_WEB_SEARCH,
  KENARI_WINDOW_WEEKLY,
} from "../kenariQuotaFetcher.ts";
import { type UsageQuota } from "./quota.ts";

const WINDOW_LABELS: Record<string, string> = {
  [KENARI_WINDOW_5H]: "5-hour",
  [KENARI_WINDOW_WEEKLY]: "Weekly",
  [KENARI_WINDOW_MONTHLY]: "Monthly",
};

function failureMessage(reason: KenariQuotaFailureReason): string {
  if (reason === "missing_cookie") {
    return "Kenari quota needs a session cookie. Set providerSpecificData.kenariSessionCookie (or KENARI_SESSION_COOKIE / KENARI_SESSION_COOKIE_FILE).";
  }
  if (reason === "expired") {
    return "Kenari session expired. Refresh __Host-kn_session on kenari.id, then update the connection.";
  }
  return "Kenari connected. Unable to fetch the subscription quota right now.";
}

export async function getKenariUsage(
  connectionId: string,
  _apiKey: string,
  providerSpecificData?: Record<string, unknown>
) {
  try {
    const { quota, reason } = await fetchKenariQuotaDetailed(connectionId, {
      providerSpecificData,
    });

    if (!quota) return { message: failureMessage(reason) };

    const kenari = quota as KenariQuota;
    const quotas: Record<string, UsageQuota> = {};

    for (const [name, window] of Object.entries(kenari.windowsDetail)) {
      if (!window) continue;
      quotas[name] = {
        used: window.used,
        total: window.total,
        remaining: Math.max(0, window.total - window.used),
        remainingPercentage: window.remainingPercentage,
        resetAt: window.resetAt,
        unlimited: false,
        displayName: WINDOW_LABELS[name] ?? name,
      };
    }

    if (kenari.webSearch) {
      quotas[KENARI_WINDOW_WEB_SEARCH] = {
        used: kenari.webSearch.used,
        total: kenari.webSearch.allowance,
        remaining: Math.max(0, kenari.webSearch.allowance - kenari.webSearch.used),
        remainingPercentage: kenari.webSearch.remainingPercentage,
        resetAt: null,
        unlimited: false,
        displayName: "Web search",
      };
    }

    return {
      plan: kenari.planName || "Kenari",
      quotas,
      limitReached: kenari.limitReached === true,
      nearLimit: kenari.nearLimit,
      planStatus: kenari.planStatus,
      weekLeftIdr: kenari.weekLeftIdr,
      monthLeftIdr: kenari.monthLeftIdr,
    };
  } catch (error) {
    return { message: `Kenari error: ${(error as Error).message}` };
  }
}
