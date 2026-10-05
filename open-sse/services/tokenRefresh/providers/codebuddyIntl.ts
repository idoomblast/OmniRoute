import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import { sanitizeErrorMessage } from "../../../utils/error.ts";
import type { RefreshLogger } from "../shared.ts";

/**
 * Cloned from our CN refresh flow with 9router's International config/domain.
 * Refresh tokens travel in X-Refresh-Token, not a form body. Proxy context and
 * token rotation/fallback retain OmniRoute's existing lifecycle behavior.
 */
export async function refreshCodebuddyIntlToken(
  refreshToken: string,
  log: RefreshLogger = null,
  proxyConfig: unknown = null
) {
  if (!refreshToken) return null;
  const { CODEBUDDY_INTL_CONFIG } = await import("@/lib/oauth/constants/oauth");
  const oauth = CODEBUDDY_INTL_CONFIG;
  try {
    const response = await runWithProxyContext(proxyConfig, () =>
      fetch(oauth.refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": oauth.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "www.codebuddy.ai",
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": "SaaS",
        },
        body: "{}",
      })
    );

    if (!response.ok) {
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy International token", {
        status: response.status,
      });
      return null;
    }

    const data = await response.json();
    if (data?.code !== 0 || !data?.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy International token refresh returned no token", {
        code: data?.code,
        msg: sanitizeErrorMessage(data?.msg),
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy International token", {
      hasNewAccessToken: !!data.data.accessToken,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
    };
  } catch (error) {
    log?.error?.(
      "TOKEN_REFRESH",
      `Network error refreshing CodeBuddy International token: ${sanitizeErrorMessage(error instanceof Error ? error.message : error)}`
    );
    return null;
  }
}
