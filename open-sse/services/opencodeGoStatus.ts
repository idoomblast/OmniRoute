/**
 * opencodeGoStatus.ts — OpenCode Go console quota reader.
 *
 * The OpenCode Go dashboard moved to the console app and no longer renders the
 * quota windows in server-side HTML. The console itself calls:
 *
 *   GET https://opencode.ai/console/api/go/status
 *   x-org-id: wrk_...
 *   Cookie: __Host-console_session=st_...
 *
 * Response (trimmed):
 *   {
 *     "product": "go",
 *     "access": {
 *       "endsAt": "2026-11-27T11:12:43.000Z",
 *       "meters": {
 *         "fiveHour": { "resetsAt": "...", "limitMicroCents": "1200000000", "usedMicroCents": "17415946" },
 *         "week":     { "resetsAt": "...", "limitMicroCents": "3000000000", "usedMicroCents": "17415946" },
 *         "month":    { "resetsAt": "...", "limitMicroCents": "6000000000", "usedMicroCents": "17415946" }
 *       }
 *     }
 *   }
 *
 * `*MicroCents` are strings: 1 USD = 100 cents = 100_000_000 micro-cents.
 *
 * Auth notes (verified against the live console):
 *   - The `auth=Fe26.2...` cookie alone returns HTTP 401.
 *   - The `__Host-console_session=st_...` cookie alone returns HTTP 200.
 *   - `x-org-id` is mandatory (HTTP 400 `OrgRequired` without it).
 *
 * The session cookie is the credential users paste into the OpenCode Go auth
 * cookie field; the full `Cookie:` header works too. The API key cannot read
 * this endpoint — it is only valid for chat/models.
 */

import { toNumberOrNull } from "@/shared/utils/numeric";

type JsonRecord = Record<string, unknown>;

const MICRO_CENTS_PER_USD = 100_000_000;
const DEFAULT_STATUS_URL = "https://opencode.ai/console/api/go/status";
const FIREFOX_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/152.0";

export type OpenCodeGoMeter = {
  /** Dollars consumed in the window (clamped to the window limit). */
  usedUsd: number;
  /** Window limit in dollars (12 / 30 / 60 today). */
  limitUsd: number;
  /** Fraction of the window consumed, 0..1. */
  percentUsed: number;
  /** ISO timestamp when the window resets, when upstream reports one. */
  resetAt: string | null;
};

export type OpenCodeGoStatus = {
  product: string | null;
  plan: string | null;
  /** End of the paid period (`access.endsAt`). */
  periodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  session: OpenCodeGoMeter | null;
  weekly: OpenCodeGoMeter | null;
  monthly: OpenCodeGoMeter | null;
  limitReached: boolean;
};

export type OpenCodeGoStatusConfig =
  | { state: "configured"; workspaceId: string; cookie: string }
  | { state: "incomplete"; missing: string }
  | { state: "none" };

export type OpenCodeGoStatusFailureReason =
  "unauthorized" | "invalid-cookie" | "http" | "parse" | "network";

export type OpenCodeGoStatusFetchResult =
  | { ok: true; status: OpenCodeGoStatus }
  | {
      ok: false;
      reason: OpenCodeGoStatusFailureReason;
      httpStatus?: number;
      message: string;
    };

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function safeToIsoString(time: number): string | null {
  if (!Number.isFinite(time) || time < 0 || time > 8.64e15) return null;
  try {
    return new Date(time).toISOString();
  } catch {
    return null;
  }
}

function parseResetAt(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? safeToIsoString(parsed) : null;
  }
  const numeric = toNumberOrNull(value);
  if (numeric === null || numeric <= 0) return null;
  // Unix seconds (< 1e12) or milliseconds (>= 1e12)
  return safeToIsoString(numeric < 1e12 ? numeric * 1000 : numeric);
}

function getProviderSpecificString(data: JsonRecord | undefined, keys: string[]): string {
  const obj = toRecord(data);
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Resolve the console credentials from env or `providerSpecificData`.
 *
 * The workspace id is the `wrk_...` segment of the console URL; the cookie is
 * either the `__Host-console_session` value or a full `Cookie:` header.
 */
export function resolveOpenCodeGoStatusConfig(
  providerSpecificData?: JsonRecord
): OpenCodeGoStatusConfig {
  const workspaceId =
    process.env.OMNIROUTE_OPENCODE_GO_WORKSPACE_ID?.trim() ||
    process.env.OPENCODE_GO_WORKSPACE_ID?.trim() ||
    getProviderSpecificString(providerSpecificData, [
      "openCodeGoWorkspaceId",
      "opencodeGoWorkspaceId",
      "workspaceId",
    ]);
  const cookie =
    process.env.OMNIROUTE_OPENCODE_GO_CONSOLE_COOKIE?.trim() ||
    process.env.OPENCODE_GO_CONSOLE_COOKIE?.trim() ||
    process.env.OMNIROUTE_OPENCODE_GO_AUTH_COOKIE?.trim() ||
    process.env.OPENCODE_GO_AUTH_COOKIE?.trim() ||
    getProviderSpecificString(providerSpecificData, [
      "openCodeGoAuthCookie",
      "opencodeGoAuthCookie",
      "authCookie",
    ]);

  if (!workspaceId && !cookie) return { state: "none" };
  if (workspaceId && cookie) return { state: "configured", workspaceId, cookie };
  return {
    state: "incomplete",
    missing: workspaceId ? "OPENCODE_GO_AUTH_COOKIE" : "OPENCODE_GO_WORKSPACE_ID",
  };
}

/**
 * Build the upstream `Cookie` header.
 *
 * Accepted shapes:
 *   - full header:      `auth=...; __Host-console_session=st_...`
 *   - session cookie:   `__Host-console_session=st_...`
 *   - bare session id:  `st_...`                  → `__Host-console_session=st_...`
 *   - legacy auth:      `auth=Fe26.2...` / `Fe26.2...` (kept for compatibility;
 *                        the status endpoint rejects it with 401)
 *
 * Returns null when the value contains CR/LF (header-injection guard).
 */
export function buildOpenCodeGoCookieHeader(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\r\n]/.test(value)) return null;
  if (value.includes("__Host-console_session=")) return value;
  if (/^auth=/i.test(value)) return value;
  if (value.startsWith("Fe26.2")) return `auth=${value}`;
  return `__Host-console_session=${value}`;
}

function parseMeter(raw: unknown): OpenCodeGoMeter | null {
  const meter = toRecord(raw);
  const limitMicroCents = toNumberOrNull(
    meter.limitMicroCents ?? meter.limit_micro_cents ?? meter.limitMicros
  );
  if (limitMicroCents === null || limitMicroCents <= 0) return null;
  const usedMicroCents = Math.max(
    0,
    toNumberOrNull(meter.usedMicroCents ?? meter.used_micro_cents ?? meter.usedMicros) ?? 0
  );
  const limitUsd = limitMicroCents / MICRO_CENTS_PER_USD;
  return {
    usedUsd: Math.min(limitUsd, usedMicroCents / MICRO_CENTS_PER_USD),
    limitUsd,
    percentUsed: Math.max(0, Math.min(1, usedMicroCents / limitMicroCents)),
    resetAt: parseResetAt(meter.resetsAt ?? meter.resets_at ?? meter.resetAt),
  };
}

/**
 * Parse the `/console/api/go/status` payload. Returns null when the response
 * carries no recognizable meter windows (e.g. a non-subscriber account).
 */
export function parseOpenCodeGoStatusResponse(data: unknown): OpenCodeGoStatus | null {
  const root = toRecord(data);
  const access = toRecord(root.access);
  const meters = toRecord(access.meters);

  const session = parseMeter(
    meters.fiveHour ?? meters.five_hour ?? meters.session ?? meters.rolling
  );
  const weekly = parseMeter(meters.week ?? meters.weekly);
  const monthly = parseMeter(meters.month ?? meters.monthly);

  if (!session && !weekly && !monthly) return null;

  const product = typeof root.product === "string" ? root.product : null;
  const productLabel =
    product && product.trim() && product.trim().toLowerCase() !== "go"
      ? `OpenCode Go ${product.trim().charAt(0).toUpperCase()}${product.trim().slice(1)}`
      : "OpenCode Go";
  const percentUsed = [session, weekly, monthly]
    .filter((meter): meter is OpenCodeGoMeter => meter !== null)
    .map((meter) => meter.percentUsed);
  const limitReached =
    root.limitReached === true ||
    access.limitReached === true ||
    percentUsed.some((percent) => percent >= 1);

  return {
    product,
    plan: productLabel,
    periodEndsAt: parseResetAt(access.endsAt),
    cancelAtPeriodEnd: access.cancelAtPeriodEnd === true || root.cancelAtPeriodEnd === true,
    session,
    weekly,
    monthly,
    limitReached,
  };
}

function resolveStatusUrl(): string {
  return process.env.OMNIROUTE_OPENCODE_GO_STATUS_URL?.trim() || DEFAULT_STATUS_URL;
}

/**
 * Fetch the console status payload.
 *
 * Never throws: every failure is reported as a discriminated result so callers
 * can fall back to the legacy HTML scrape / API-key path or surface a targeted
 * message.
 */
export async function fetchOpenCodeGoStatus(
  config: Extract<OpenCodeGoStatusConfig, { state: "configured" }>,
  fetchImpl: typeof fetch = fetch
): Promise<OpenCodeGoStatusFetchResult> {
  const cookie = buildOpenCodeGoCookieHeader(config.cookie);
  if (!cookie) {
    return {
      ok: false,
      reason: "invalid-cookie",
      message: "OpenCode Go console cookie contains invalid characters.",
    };
  }

  const url = resolveStatusUrl();
  let referer = "https://opencode.ai/console";
  try {
    referer = `${new URL(url).origin}/console/${encodeURIComponent(config.workspaceId)}/go`;
  } catch {
    // Custom malformed override — keep the default referer.
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
        "x-org-id": config.workspaceId,
        Referer: referer,
        "User-Agent": FIREFOX_USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "network",
      message: `OpenCode Go console quota request failed: ${
        error instanceof Error ? error.message : "network error"
      }`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "unauthorized",
      httpStatus: response.status,
      message:
        "OpenCode Go console session is missing or expired. Paste the __Host-console_session " +
        "cookie from opencode.ai/console into the OpenCode Go auth cookie field.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "http",
      httpStatus: response.status,
      message: `OpenCode Go console quota API error (${response.status}).`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return {
      ok: false,
      reason: "parse",
      message: "OpenCode Go console quota response was not valid JSON.",
    };
  }

  const status = parseOpenCodeGoStatusResponse(json);
  if (!status) {
    return {
      ok: false,
      reason: "parse",
      message: "OpenCode Go console quota response did not contain meter windows.",
    };
  }
  return { ok: true, status };
}
