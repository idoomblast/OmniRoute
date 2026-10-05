/**
 * CodeBuddy International usage handler — cloned from the CN handler to avoid
 * changing production CN behavior. The .ai billing wire shape and IDE headers
 * come from 9router; refill and bonus accounting retain OmniRoute's semantics.
 * Authenticated International usage has not been live-verified (no account).
 */
import { sanitizeErrorMessage } from "../../utils/error.ts";

const USAGE_URL = "https://www.codebuddy.ai/v2/billing/meter/get-user-resource";

interface TencentAccount {
  PackageName?: string;
  SubProductName?: string;
  CycleStartTime?: string | number;
  CycleEndTime?: string | number;
  DeductionEndTime?: string | number;
  CycleCapacitySize?: number | string;
  CycleCapacitySizePrecise?: string | number;
  CycleCapacityUsed?: number | string;
  CycleCapacityUsedPrecise?: string | number;
  CapacitySize?: number | string;
  CapacitySizePrecise?: string | number;
  CapacityUsed?: number | string;
  CapacityUsedPrecise?: string | number;
}

interface CodeBuddyBillingResponse {
  code?: number;
  msg?: unknown;
  data?: {
    Response?: {
      Data?: {
        Accounts?: TencentAccount[];
      };
    };
  };
}

function parseResetTime(value: unknown): string | null {
  if (!value) return null;
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") {
      const ts = value < 1e12 ? value * 1000 : value;
      const d = new Date(ts);
      return d.getTime() > 0 ? d.toISOString() : null;
    }
    if (typeof value === "string") {
      if (/^\d+$/.test(value)) {
        const n = Number(value);
        const d = new Date(n < 1e12 ? n * 1000 : n);
        return d.getTime() > 0 ? d.toISOString() : null;
      }
      const d = new Date(value);
      return Number.isNaN(d.getTime()) || d.getTime() <= 0 ? null : d.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

// Prefer the *Precise string fields (exact), fall back to the numeric ones.
function num(precise: unknown, plain: unknown): number {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

function refillCadence(acc: TencentAccount): "Monthly" | "Weekly" | "Daily" {
  const start = parseResetTime(acc.CycleStartTime);
  const end = parseResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

function cycleEndMs(acc: TencentAccount): number {
  const r = parseResetTime(acc.CycleEndTime);
  return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
}

function deductionEndMs(acc: TencentAccount): number {
  const v = acc.DeductionEndTime;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const r = parseResetTime(v);
  return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
}

// Refill packs reset before expiry; bonus packs expire at the cycle end.
const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
function isRefill(acc: TencentAccount): boolean {
  const ce = cycleEndMs(acc);
  const de = deductionEndMs(acc);
  return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
}

interface CodeBuddyUsageResult {
  plan?: string;
  quotas?: Record<
    string,
    {
      used: number;
      total: number;
      resetAt: string | null;
      unlimited: boolean;
    }
  >;
  message?: string;
}

export async function getCodeBuddyIntlUsage(
  accessToken?: string,
  apiKey?: string,
  _providerSpecificData?: unknown
): Promise<CodeBuddyUsageResult> {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: "CodeBuddy International credential not available." };
  }

  try {
    const response = await fetch(USAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
        "X-Product": "SaaS",
        "X-IDE-Type": "IDE",
        "X-IDE-Name": "IDE",
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1",
      },
      body: "{}",
    });

    if (response.status === 401 || response.status === 403) {
      return { message: "CodeBuddy International credential invalid or expired." };
    }
    if (!response.ok) {
      return { message: `CodeBuddy International quota API error (${response.status}).` };
    }

    const json: CodeBuddyBillingResponse = await response.json();
    if (json?.code !== 0) {
      const message = typeof json?.msg === "string" && json.msg ? json.msg : "unknown";
      return { message: sanitizeErrorMessage(`CodeBuddy International quota error: ${message}`) };
    }

    const data = json?.data?.Response?.Data || {};
    const accountsRaw: TencentAccount[] = Array.isArray(data.Accounts) ? data.Accounts : [];
    if (accountsRaw.length === 0) {
      return { message: "CodeBuddy International connected. No credit package found." };
    }

    const byExpiry = (a: TencentAccount, b: TencentAccount) => cycleEndMs(a) - cycleEndMs(b);
    const refills = accountsRaw.filter(isRefill).sort(byExpiry);
    const bonuses = accountsRaw.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas: NonNullable<CodeBuddyUsageResult["quotas"]> = {};
    const seenRefill: Record<string, number> = {};
    refills.forEach((acc) => {
      const base = refillCadence(acc);
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
      };
    });
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
      };
    });

    const basePkg = refills[0] || accountsRaw[0] || {};
    const plan = basePkg.PackageName || basePkg.SubProductName || "CodeBuddy International";

    return { plan, quotas };
  } catch {
    // Usage messages can reach HTTP/dashboard clients; never expose exceptions.
    return { message: "CodeBuddy International error: failed to fetch quota." };
  }
}

export default getCodeBuddyIntlUsage;
