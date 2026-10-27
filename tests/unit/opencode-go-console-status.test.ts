import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpenCodeGoCookieHeader,
  fetchOpenCodeGoStatus,
  parseOpenCodeGoStatusResponse,
  resolveOpenCodeGoStatusConfig,
} from "../../open-sse/services/opencodeGoStatus.ts";
import { getOpenCodeGoUsage } from "../../open-sse/services/opencodeOllamaUsage.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Cookie header ───────────────────────────────────────────────────────────

test("buildOpenCodeGoCookieHeader wraps a bare console session id", () => {
  assert.equal(buildOpenCodeGoCookieHeader("st_60b05f25"), "__Host-console_session=st_60b05f25");
});

test("buildOpenCodeGoCookieHeader keeps an explicit console session cookie", () => {
  assert.equal(
    buildOpenCodeGoCookieHeader("__Host-console_session=st_60b05f25"),
    "__Host-console_session=st_60b05f25"
  );
});

test("buildOpenCodeGoCookieHeader keeps a full Cookie header untouched", () => {
  const header = "auth=Fe26.2**abc; __Host-console_session=st_60b05f25; oc_locale=en";
  assert.equal(buildOpenCodeGoCookieHeader(header), header);
});

test("buildOpenCodeGoCookieHeader preserves the legacy auth= prefix", () => {
  assert.equal(buildOpenCodeGoCookieHeader("auth=Fe26.2**abc"), "auth=Fe26.2**abc");
  assert.equal(buildOpenCodeGoCookieHeader("Fe26.2**abc"), "auth=Fe26.2**abc");
});

test("buildOpenCodeGoCookieHeader rejects CRLF header injection", () => {
  assert.equal(buildOpenCodeGoCookieHeader("__Host-console_session=st_a\r\nX-Evil: 1"), null);
  assert.equal(buildOpenCodeGoCookieHeader(""), null);
});

// ─── Response parsing ───────────────────────────────────────────────────────

const STATUS_PAYLOAD = {
  subscriberUserId: "acc_01M0Q6N819K85RDEGJDVZQBZPC",
  product: "go",
  renewalProduct: "go",
  cancelAtPeriodEnd: false,
  access: {
    startsAt: "2026-10-27T11:12:43.000Z",
    endsAt: "2026-11-27T11:12:43.000Z",
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: {
        startsAt: "2026-10-27T11:15:30.000Z",
        resetsAt: "2026-10-27T16:15:30.000Z",
        limitMicroCents: "1200000000",
        usedMicroCents: "17415946",
      },
      week: {
        startsAt: "2026-10-26T00:00:00.000Z",
        resetsAt: "2026-11-02T00:00:00.000Z",
        limitMicroCents: "3000000000",
        usedMicroCents: "17415946",
      },
      month: {
        resetsAt: "2026-11-27T11:12:43.000Z",
        limitMicroCents: "6000000000",
        usedMicroCents: "17415946",
      },
    },
  },
};

test("parseOpenCodeGoStatusResponse maps access.meters micro-cents to dollars", () => {
  const status = parseOpenCodeGoStatusResponse(STATUS_PAYLOAD);
  assert.ok(status);
  assert.equal(status.plan, "OpenCode Go");
  assert.equal(status.product, "go");
  assert.equal(status.periodEndsAt, "2026-11-27T11:12:43.000Z");
  assert.equal(status.limitReached, false);

  assert.ok(status.session);
  assert.equal(status.session.limitUsd, 12);
  assert.equal(status.session.usedUsd, 0.17415946);
  assert.equal(status.session.percentUsed, 17415946 / 1200000000);
  assert.equal(status.session.resetAt, "2026-10-27T16:15:30.000Z");

  assert.ok(status.weekly);
  assert.equal(status.weekly.limitUsd, 30);
  assert.ok(status.monthly);
  assert.equal(status.monthly.limitUsd, 60);
});

test("parseOpenCodeGoStatusResponse clamps an over-limit meter and flags limitReached", () => {
  const status = parseOpenCodeGoStatusResponse({
    product: "go",
    access: {
      meters: {
        fiveHour: { limitMicroCents: "1200000000", usedMicroCents: "2400000000" },
      },
    },
  });
  assert.ok(status);
  assert.equal(status.session?.percentUsed, 1);
  assert.equal(status.session?.usedUsd, 12);
  assert.equal(status.limitReached, true);
});

test("parseOpenCodeGoStatusResponse returns null when no meter windows exist", () => {
  assert.equal(parseOpenCodeGoStatusResponse({ product: "go", access: {} }), null);
  assert.equal(parseOpenCodeGoStatusResponse({}), null);
});

// ─── Fetch ──────────────────────────────────────────────────────────────────

test("fetchOpenCodeGoStatus sends the console session cookie and x-org-id", async () => {
  let requestUrl = "";
  let requestHeaders: Headers | null = null;

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers as HeadersInit | undefined);
    return new Response(JSON.stringify(STATUS_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await fetchOpenCodeGoStatus({
    state: "configured",
    workspaceId: "wrk_01M0Q6N9AG8T3290P0SXBK22KB",
    cookie: "__Host-console_session=st_60b05f25",
  });

  assert.equal(requestUrl, "https://opencode.ai/console/api/go/status");
  assert.equal(
    requestHeaders?.get("x-org-id"),
    "wrk_01M0Q6N9AG8T3290P0SXBK22KB",
    "x-org-id is mandatory upstream"
  );
  assert.equal(requestHeaders?.get("Cookie"), "__Host-console_session=st_60b05f25");
  assert.equal(
    requestHeaders?.get("Referer"),
    "https://opencode.ai/console/wrk_01M0Q6N9AG8T3290P0SXBK22KB/go"
  );
  assert.ok(result.ok);
  assert.equal(result.status.session?.limitUsd, 12);
});

test("fetchOpenCodeGoStatus reports an expired console session", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ _tag: "Unauthorized" }), {
      status: 401,
    });

  const result = await fetchOpenCodeGoStatus({
    state: "configured",
    workspaceId: "wrk_x",
    cookie: "st_expired",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unauthorized");
  assert.match(result.message, /__Host-console_session/);
});

test("fetchOpenCodeGoStatus reports a missing x-org-id as an HTTP failure", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ _tag: "OrgRequired" }), { status: 400 });

  const result = await fetchOpenCodeGoStatus({
    state: "configured",
    workspaceId: "wrk_x",
    cookie: "st_valid",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "http");
  assert.equal(result.httpStatus, 400);
});

// ─── Config resolution ──────────────────────────────────────────────────────

test("resolveOpenCodeGoStatusConfig reads providerSpecificData fields", () => {
  const config = resolveOpenCodeGoStatusConfig({
    opencodeGoWorkspaceId: "wrk_123",
    opencodeGoAuthCookie: "st_abc",
  });
  assert.deepEqual(config, {
    state: "configured",
    workspaceId: "wrk_123",
    cookie: "st_abc",
  });
});

test("resolveOpenCodeGoStatusConfig reports the missing half", () => {
  assert.deepEqual(resolveOpenCodeGoStatusConfig({ opencodeGoWorkspaceId: "wrk_123" }), {
    state: "incomplete",
    missing: "OPENCODE_GO_AUTH_COOKIE",
  });
  assert.deepEqual(resolveOpenCodeGoStatusConfig({ opencodeGoAuthCookie: "st_abc" }), {
    state: "incomplete",
    missing: "OPENCODE_GO_WORKSPACE_ID",
  });
  assert.deepEqual(resolveOpenCodeGoStatusConfig({}), { state: "none" });
});

// ─── Dashboard usage integration ────────────────────────────────────────────

test("getOpenCodeGoUsage reads quota from the console status endpoint", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(STATUS_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const result = (await getOpenCodeGoUsage("", {
    opencodeGoWorkspaceId: "wrk_01M0Q6N9AG8T3290P0SXBK22KB",
    opencodeGoAuthCookie: "__Host-console_session=st_60b05f25",
  })) as {
    plan?: string | null;
    limitReached?: boolean;
    quotas?: Record<
      string,
      {
        used: number;
        total: number;
        remaining: number;
        remainingPercentage: number;
        resetAt: string | null;
      }
    >;
  };

  assert.equal(result.plan, "OpenCode Go");
  assert.equal(result.limitReached, false);
  assert.deepEqual(Object.keys(result.quotas ?? {}), ["session", "weekly", "mcp_monthly"]);

  assert.equal(result.quotas!.session.total, 12);
  assert.equal(result.quotas!.session.used, 0.17);
  assert.equal(result.quotas!.session.remaining, 11.83);
  assert.equal(result.quotas!.session.remainingPercentage, 99);
  assert.equal(result.quotas!.session.resetAt, "2026-10-27T16:15:30.000Z");

  assert.equal(result.quotas!.weekly.total, 30);
  assert.equal(result.quotas!.mcp_monthly.total, 60);
});

test("getOpenCodeGoUsage surfaces an actionable message for an expired session", async () => {
  globalThis.fetch = async () => new Response(null, { status: 401 });

  const result = (await getOpenCodeGoUsage("sk-chat-only", {
    opencodeGoWorkspaceId: "wrk_x",
    opencodeGoAuthCookie: "st_expired",
  })) as { message?: string };

  assert.match(result.message ?? "", /__Host-console_session/);
  assert.match(result.message ?? "", /expired|missing/i);
});
