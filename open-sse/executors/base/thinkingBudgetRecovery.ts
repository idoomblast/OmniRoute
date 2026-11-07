/**
 * Thinking-budget 400 clamp-and-retry for the Gemini family (any provider).
 *
 * The proactive capThinkingBudget clamp misses models outside MODEL_SPECS, so an
 * xhigh budget (131072) can reach the upstream and bounce with
 * "thinking_budget must be in the range [-1, N]". When that happens: parse the
 * advertised max, record it process-wide (so FUTURE requests clamp proactively
 * via capThinkingBudget → getLearnedThinkingCap), clamp the nested budget in the
 * live transformedBody, and retry the same URL once. Subsequent requests never
 * pay this 400→retry round-trip.
 *
 * Extracted from executors/base.ts to keep that file inside its frozen budget.
 */

import { HTTP_STATUS } from "../../config/constants.ts";

type RecoveryLog = { info?: (tag: string, message: string) => void } | null;

export async function recoverThinkingBudget(args: {
  response: Response;
  url: string;
  provider: string;
  model: string | undefined;
  body: unknown;
  fetchOptions: RequestInit;
  fetchFn: (url: string, options: RequestInit) => Promise<Response>;
  requiresSigning: boolean;
  signBody: (body: string) => Promise<string>;
  readBudget: (body: unknown) => number | null;
  clampBudget: (body: unknown, max: number) => boolean;
  recordLearnedCap: (provider: string, model: string | undefined, budget: number) => void;
  parseUpstreamMax: (errorText: string) => number | null;
  log?: RecoveryLog;
}): Promise<{ response: Response; body: unknown; clampedMax: number } | null> {
  const { response, body, url, fetchOptions, fetchFn } = args;
  if (response.status !== HTTP_STATUS.BAD_REQUEST || !body || typeof body !== "object") {
    return null;
  }
  const errorText = await response
    .clone()
    .text()
    .catch(() => "");
  const upstreamMax = args.parseUpstreamMax(errorText);
  if (upstreamMax === null) return null;

  const currentBudget = args.readBudget(body);
  // Record under the budget that actually failed so the learned step ladder
  // advances correctly; fall back to upstreamMax when the body carries no
  // readable budget (still record so we stop re-hitting).
  args.recordLearnedCap(args.provider, args.model, currentBudget ?? upstreamMax + 1);
  if (!args.clampBudget(body, upstreamMax)) {
    return { response, body, clampedMax: upstreamMax };
  }
  let retryBody = JSON.stringify(body);
  if (args.requiresSigning) retryBody = await args.signBody(retryBody);
  args.log?.info?.(
    "THINKING_BUDGET",
    `Upstream 400 rejected thinking_budget — clamped to ${upstreamMax} and retrying (learned for ${args.provider}/${args.model})`
  );
  return {
    response: await fetchFn(url, { ...fetchOptions, body: retryBody }),
    body,
    clampedMax: upstreamMax,
  };
}
