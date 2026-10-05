import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CODEBUDDY_INTL_CONFIG,
  PROVIDERS as OAUTH_IDS,
} from "../../src/lib/oauth/constants/oauth.ts";
import { codebuddyIntl } from "../../src/lib/oauth/providers/codebuddy-intl.ts";
import OAUTH_PROVIDERS from "../../src/lib/oauth/providers/index.ts";
import { pollForToken } from "../../src/lib/oauth/providers.ts";
import { refreshCodebuddyIntlToken } from "../../open-sse/services/tokenRefresh/providers/codebuddyIntl.ts";
import { getAccessToken, supportsTokenRefresh } from "../../open-sse/services/tokenRefresh.ts";

const originalFetch = globalThis.fetch;
const config = CODEBUDDY_INTL_CONFIG;
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("International OAuth config and device-flow registrations use the .ai IDE endpoints", () => {
  assert.deepEqual(config, {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  });
  assert.equal(OAUTH_IDS.CODEBUDDY_INTL, "codebuddy-intl");
  assert.equal(OAUTH_PROVIDERS["codebuddy-intl"], codebuddyIntl);
  assert.equal(codebuddyIntl.flowType, "device_code");
  assert.equal(supportsTokenRefresh("codebuddy-intl"), true);
  assert.match(
    read("src/app/api/oauth/[provider]/[action]/route.ts"),
    /NO_PKCE_DEVICE_CODE_PROVIDERS = new Set\(\[[\s\S]*?"codebuddy-intl"[\s\S]*?\]\)/
  );
  assert.match(
    read("src/app/api/providers/[id]/test/oauthTestConfig.ts"),
    /"codebuddy-intl": \{[^}]*checkExpiry: true,[^}]*refreshable: true/
  );
});

test("International device state request returns the browser authUrl and CN-compatible shape", async () => {
  const state = "test-state";
  const authUrl = `https://www.codebuddy.ai/login?platform=ide&state=${state}`;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${config.stateUrl}?platform=ide`);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Domain"), "www.codebuddy.ai");
    assert.equal(headers.get("User-Agent"), config.userAgent);
    assert.equal(headers.get("X-No-Authorization"), "true");
    return jsonResponse({ code: 0, data: { state, authUrl } });
  };
  assert.deepEqual(await codebuddyIntl.requestDeviceCode(config), {
    device_code: state,
    user_code: state,
    verification_uri: authUrl,
    verification_uri_complete: authUrl,
    expires_in: 600,
    interval: 5,
  });
});

test("International poll preserves 11217 pending semantics and the helper marks it pending", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${config.tokenUrl}?state=state%20%26%20value`);
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Domain"), "www.codebuddy.ai");
    assert.equal(headers.get("X-No-Enterprise-Id"), "true");
    return jsonResponse({ code: 11217, msg: "11217:login ing..." });
  };
  assert.deepEqual(await codebuddyIntl.pollToken(config, "state & value"), {
    ok: false,
    data: { code: 11217, msg: "11217:login ing..." },
  });
  assert.deepEqual(await pollForToken("codebuddy-intl", "state & value", null, null), {
    success: false,
    error: "authorization_pending",
    pending: true,
  });
});

test("International poll success maps rotated tokens with the CN lifecycle defaults", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      code: 0,
      data: { accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 7200 },
    });
  const result = await codebuddyIntl.pollToken(config, "state");
  assert.deepEqual(result, {
    ok: true,
    data: {
      access_token: "test-access",
      refresh_token: "test-refresh",
      token_type: "Bearer",
      expires_in: 7200,
    },
  });
  assert.deepEqual(await pollForToken("codebuddy-intl", "state", null, null), {
    success: true,
    tokens: {
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresIn: 7200,
      providerSpecificData: {},
    },
  });
  assert.equal(
    codebuddyIntl.mapTokens({ access_token: "test", refresh_token: "", token_type: "Bearer" })
      .expiresIn,
    86400
  );
});

test("International device state failures are descriptive, sanitized, and reject missing authUrl", async () => {
  globalThis.fetch = async () => jsonResponse({}, 403);
  await assert.rejects(codebuddyIntl.requestDeviceCode(config), /state request failed \(403\)/);
  globalThis.fetch = async () => jsonResponse({ code: 0, data: { state: "state" } });
  await assert.rejects(codebuddyIntl.requestDeviceCode(config), /missing state\/authUrl/);
  globalThis.fetch = async () =>
    jsonResponse({ code: 1, msg: "denied /home/operator/private/file.ts" });
  await assert.rejects(codebuddyIntl.requestDeviceCode(config), (error: Error) => {
    assert.ok(!error.message.includes("/home/operator/private/file.ts"));
    return true;
  });
});

test("International refresh uses the .ai plugin headers and rotates or retains the refresh token", async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, config.refreshUrl);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Domain"), "www.codebuddy.ai");
    assert.equal(headers.get("X-Refresh-Token"), "test-refresh");
    assert.equal(headers.get("X-Auth-Refresh-Source"), "plugin");
    return jsonResponse({
      code: 0,
      data: {
        accessToken: "test-access",
        refreshToken: calls++ === 0 ? "rotated" : "",
        expiresIn: 3600,
      },
    });
  };
  assert.deepEqual(await refreshCodebuddyIntlToken("test-refresh"), {
    accessToken: "test-access",
    refreshToken: "rotated",
    expiresIn: 3600,
  });
  assert.deepEqual(await getAccessToken("codebuddy-intl", { refreshToken: "test-refresh" }, null), {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    expiresIn: 3600,
  });
});

test("International refresh returns null for missing, rejected, malformed, or failed tokens", async () => {
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch");
  };
  assert.equal(await refreshCodebuddyIntlToken(""), null);
  globalThis.fetch = async () => jsonResponse({ code: 12153 }, 401);
  assert.equal(await refreshCodebuddyIntlToken("bogus"), null);
  globalThis.fetch = async () => jsonResponse({ code: 0, data: {} });
  assert.equal(await refreshCodebuddyIntlToken("bogus"), null);
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };
  assert.equal(await refreshCodebuddyIntlToken("bogus"), null);
});
