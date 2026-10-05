import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { CODEBUDDY_INTL_CONFIG } from "../constants/oauth";

/**
 * CodeBuddy International device-auth flow: 9router's .ai endpoints and IDE headers,
 * cloned from our CN flow to preserve OmniRoute's pending/error token semantics.
 * POST state -> open authUrl -> GET token?state (11217 = login pending).
 */
type CodeBuddyConfig = typeof CODEBUDDY_INTL_CONFIG;

interface CodeBuddyDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface CodeBuddyTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in?: number;
}

interface CodeBuddyAuthResponse {
  code?: number;
  msg?: string;
  data?: {
    state?: string;
    authUrl?: string;
    url?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
  };
}

interface CodeBuddyPollResult {
  ok: boolean;
  data: Record<string, unknown> | CodeBuddyTokens;
}

export const codebuddyIntl = {
  config: CODEBUDDY_INTL_CONFIG,
  flowType: "device_code" as const,

  requestDeviceCode: async (config: CodeBuddyConfig): Promise<CodeBuddyDeviceCodeResponse> => {
    // Like CN, platform is a query parameter, not a body-only field.
    const stateUrl = `${config.stateUrl}?platform=${encodeURIComponent(config.platform)}`;
    const response = await fetch(stateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: JSON.stringify({ platform: config.platform }),
    });

    if (!response.ok) {
      throw new Error(`CodeBuddy International state request failed (${response.status})`);
    }

    const json = (await response.json()) as CodeBuddyAuthResponse;
    const authUrl = json.data?.authUrl || json.data?.url;
    if (json.code !== 0 || !json.data?.state || !authUrl) {
      throw new Error(
        `CodeBuddy International state error: ${sanitizeErrorMessage(json.msg || "missing state/authUrl")}`
      );
    }

    const state = String(json.data.state);
    return {
      device_code: state,
      user_code: state,
      verification_uri: authUrl,
      verification_uri_complete: authUrl,
      expires_in: 600,
      interval: Math.max(1, Math.floor((config.pollInterval || 5000) / 1000)),
    };
  },

  pollToken: async (config: CodeBuddyConfig, deviceCode: string): Promise<CodeBuddyPollResult> => {
    const response = await fetch(`${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = (await response.json()) as CodeBuddyAuthResponse;
    if (data.code === 0 && data.data?.accessToken) {
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
        },
      };
    }
    // Unlike 9router, retain OUR CN pending result; pollForToken adapts this provider's code.
    return { ok: false, data: { code: data.code, msg: sanitizeErrorMessage(data.msg) } };
  },

  mapTokens: (tokens: CodeBuddyTokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in || 86400,
    providerSpecificData: {},
  }),
};

export default codebuddyIntl;
