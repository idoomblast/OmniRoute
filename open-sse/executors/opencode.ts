import { randomUUID } from "node:crypto";
import { BaseExecutor, type ExecuteInput, type ProviderCredentials } from "./base.ts";
import { PROVIDERS, MAX_TOOLS_LIMIT } from "../config/constants.ts";
import { getModelTargetFormat } from "../config/providerModels.ts";
import {
  injectReasoningContentForThinkingModel,
  isThinkingMessageModel,
} from "../utils/reasoningContentInjector.ts";
import { runWithProxyContext } from "../utils/proxyFetch.ts";
import {
  clientSuppliedOpencodeSession,
  findHeader,
  forwardOpencodeClientHeaders,
  resolveOpencodeCliDefaults,
} from "../utils/opencodeHeaders.ts";
import { projectOpencodeSessionBody } from "../utils/opencodeSessionIdentity.ts";
import { generateSessionId } from "../services/sessionManager.ts";
import { currentRequestContext, runInRequestContext } from "./opencodeRequestContext.ts";
import {
  attemptFor,
  isGatedFreeTierRequest,
  isPremiumOpencodeModel,
  noteFreeTierOutcome,
  prepareFreeTierRequest,
  rebuildJsonFromForcedStream,
  surfaceFromBaseUrl,
} from "./opencodeFreeTierContract.ts";
import {
  handleLoopFreeTierRefusal,
  retryFreeTierRefusalWithObservedTools,
} from "./opencodeFreeTierRetry.ts";
import { withRequestShapeRetry } from "./opencodeRequestShape.ts";
import { isOpencodeFreeTierRefusal, proxyKeyOf } from "./opencodeGeoBlock.ts";

// Re-exported: the free-model catalog moved to the contract module (it decides whether the
// contract applies), and existing importers keep resolving it from the executor.
export { isPremiumOpencodeModel };

/**
 * Per-account proxy configuration, persisted by NoAuthAccountCard under
 * `providerSpecificData.accountProxies` (keyed by the account id, which the UI
 * stores in `providerSpecificData.fingerprints`). Same shape mimocode uses.
 */
export interface OpencodeAccountProxyConfig {
  fingerprint: string;
  proxy: {
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    relayAuth?: string;
  } | null;
}

/** Runtime rotation/cooldown state for one "OpenCode Free" account. */
interface OpencodeAccountState {
  /** Account id (UI: providerSpecificData.fingerprints[i]); "" for the default direct account. */
  fingerprint: string;
  cooldownUntil: number;
  consecutiveFails: number;
  /** Resolved proxy config for this account (null = direct egress). */
  proxy: OpencodeAccountProxyConfig["proxy"];
}

const OPENCODE_COOLDOWN_BASE_MS = 5_000;
const OPENCODE_COOLDOWN_MAX_MS = 60_000;

const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;

/**
 * Models on opencode-go that support effort-tier aliases. Each entry maps the
 * canonical base id to the set of effort suffixes the upstream supports.
 *
 * - deepseek-v4-pro: all four tiers (low/medium/high/max)
 * - glm-5.2: high/max only (Z.AI maps these through the reasoning plane;
 *   low/medium are not supported on the OpenAI transport)
 * - mimo-v2.5: high/max only (same reasoning; Xiaomi MiMo does not document
 *   low/medium effort tiers)
 * - #8353 OpenCode Go registry effort variants (exact suffix sets from
 *   `opencode models opencode-go --verbose`; MiniMax M3 excluded — different
 *   thinking-mode mapping):
 *   deepseek-v4-flash high/max; grok-4.5 low/medium/high; hy3 none/low/high;
 *   kimi-k3 max; qwen3.6-plus / qwen3.7-max / qwen3.7-plus high/max
 */
const EFFORT_TIERS: Record<string, readonly string[]> = {
  "deepseek-v4-pro": EFFORT_LEVELS,
  "deepseek-v4-flash": ["high", "max"],
  "glm-5.2": ["high", "max"],
  "mimo-v2.5": ["high", "max"],
  "grok-4.5": ["low", "medium", "high"],
  hy3: ["none", "low", "high"],
  "kimi-k3": ["max"],
  "qwen3.6-plus": ["high", "max"],
  "qwen3.7-max": ["high", "max"],
  "qwen3.7-plus": ["high", "max"],
};

/**
 * Parse a model string with an effort-level suffix.
 * e.g. "deepseek-v4-pro-low" → { baseModel: "deepseek-v4-pro", effort: "low" }
 *      "glm-5.2-high"         → { baseModel: "glm-5.2", effort: "high" }
 * Returns null if the model doesn't match any known effort-tier pattern.
 */
export function parseEffortLevel(model: string): { baseModel: string; effort: string } | null {
  const m = String(model || "");
  for (const [baseModel, levels] of Object.entries(EFFORT_TIERS)) {
    for (const level of levels) {
      if (m === `${baseModel}-${level}`) {
        return { baseModel, effort: level };
      }
    }
  }
  return null;
}

/**
 * Client headers that carry a caller session identity and can stand in for
 * x-opencode-session when the client did not send one (first match wins).
 * x-session-affinity / x-session-id mirror the existing synthesizeRequestId
 * mapping; x-omniroute-session-id is OmniRoute's native session header.
 */
const OPENCODE_SESSION_FALLBACK_HEADERS = [
  "x-session-affinity",
  "x-session-id",
  "x-omniroute-session-id",
] as const;

/**
 * Console Go (opencode.ai/zen/go) hard-requires x-opencode-session and 400s
 * "Request is missing x-opencode-session and cannot be routed efficiently"
 * when it is absent (production, 2026-09-14, opencode-go/deepseek-v4.1-flash).
 * The OpenCode CLI always sends it — a stable id per conversation — plus a
 * self-identifying User-Agent; docs (opencode.ai/docs/go) ask clients for
 * exactly that. Resolution order (client values always win, per #5997):
 *   1. client x-opencode-session → passthrough, nothing to do
 *   2. client x-session-affinity / x-session-id / x-omniroute-session-id
 *   3. conversation fingerprint (sessionManager.generateSessionId) → stable
 *      across the turns of one conversation, unique across conversations
 *   4. random UUID → opaque but satisfies the header-present contract
 * Returns a shallow copy of the input with the id injected into a copied
 * clientHeaders record (the caller's object is read-only and is never
 * mutated); OpencodeExecutor.buildHeaders forwards it from there.
 */
export function withSynthesizedOpencodeSession(
  input: ExecuteInput,
  provider: string
): ExecuteInput {
  const clientHeaders = input.clientHeaders;
  if (clientHeaders && findHeader(clientHeaders, "x-opencode-session")) {
    return input;
  }
  const fromClient = clientHeaders
    ? OPENCODE_SESSION_FALLBACK_HEADERS.map((name) => findHeader(clientHeaders, name)).find(
        (value): value is string => Boolean(value)
      )
    : undefined;
  const body = (typeof input.body === "object" && input.body !== null ? input.body : null) as
    Parameters<typeof generateSessionId>[0] | null;
  const sessionId = fromClient || generateSessionId(body, { provider }) || randomUUID();
  return {
    ...input,
    clientHeaders: { ...(clientHeaders ?? {}), "x-opencode-session": sessionId },
  };
}

/** Registry target format for a model, defaulting to the openai surface. */
export function resolveOpencodeTargetFormat(provider: string, model: string): string {
  return getModelTargetFormat(provider, model) || "openai";
}

export class OpencodeExecutor extends BaseExecutor {
  /**
   * The target format and the client session of the request being served. While `execute()`
   * runs they live in that request's own context (this instance is shared and requests
   * overlap); outside it they fall back to plain fields, which is how `buildHeaders`,
   * `buildUrl` and `transformRequest` are exercised on their own.
   */
  private _formatFallback: string | null = null;
  private _sessionFallback: string | undefined;
  get _requestFormat(): string | null {
    return currentRequestContext()?.format ?? this._formatFallback;
  }
  set _requestFormat(value: string | null) {
    const context = currentRequestContext();
    if (context) context.format = value;
    else this._formatFallback = value;
  }
  private get _clientSession(): string | undefined {
    const context = currentRequestContext();
    return context ? context.session : this._sessionFallback;
  }
  private set _clientSession(value: string | undefined) {
    const context = currentRequestContext();
    if (context) context.session = value;
    else this._sessionFallback = value;
  }
  private _surface = () => surfaceFromBaseUrl(this.config?.baseUrl);

  /**
   * Free-tier retry context: the request-scoped contract state the retry helper needs.
   */
  private freeTierRetryCtx(input: ExecuteInput) {
    // The contract attempt is keyed by the request body, so read it back from
    // there instead of a shared field (#14148).
    const attempt = attemptFor(input.body);
    return {
      surface: this._surface(),
      provider: this.provider,
      requestFormat: this._requestFormat,
      clientSession: this._clientSession,
      borrowed: attempt?.borrowed,
      clientToolNames: attempt?.clientToolNames ?? [],
    };
  }

  /**
   * Per-account rotation state, rebuilt from credentials on each request. The
   * default entry (fingerprint "") represents the single anonymous account with
   * no configured proxy — preserves the historical direct pass-through when the
   * user has not configured any per-account proxy.
   */
  private accounts: OpencodeAccountState[] = [
    { fingerprint: "", cooldownUntil: 0, consecutiveFails: 0, proxy: null },
  ];
  private nextAccountIdx = 0;

  constructor(provider: string) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  /**
   * Rebuild `accounts` from `providerSpecificData.fingerprints` +
   * `providerSpecificData.accountProxies`. Each configured account id becomes a
   * rotation slot carrying its own proxy. When the user configured no accounts
   * at all, the single default direct account is kept (backward compatible).
   */
  private syncAccountsFromCredentials(credentials: ProviderCredentials): void {
    const psd = credentials?.providerSpecificData;
    const fingerprints = Array.isArray(psd?.fingerprints)
      ? (psd!.fingerprints as unknown[]).filter((f): f is string => typeof f === "string")
      : [];

    const accountProxies = psd?.accountProxies as OpencodeAccountProxyConfig[] | undefined;
    const proxyMap = Array.isArray(accountProxies)
      ? new Map(accountProxies.map((ap) => [ap.fingerprint, ap.proxy ?? null] as const))
      : null;

    if (fingerprints.length === 0) {
      // No configured accounts — keep a single direct account.
      this.accounts = [{ fingerprint: "", cooldownUntil: 0, consecutiveFails: 0, proxy: null }];
      this.nextAccountIdx = 0;
      return;
    }

    const previous = new Map(this.accounts.map((a) => [a.fingerprint, a] as const));
    this.accounts = fingerprints.map((fp) => {
      const prior = previous.get(fp);
      return {
        fingerprint: fp,
        cooldownUntil: prior?.cooldownUntil ?? 0,
        consecutiveFails: prior?.consecutiveFails ?? 0,
        proxy: proxyMap ? (proxyMap.get(fp) ?? null) : null,
      };
    });
    if (this.nextAccountIdx >= this.accounts.length) this.nextAccountIdx = 0;
  }

  private isAccountReady(account: OpencodeAccountState): boolean {
    return account.cooldownUntil <= Date.now();
  }

  /** Round-robin pick, skipping accounts in cooldown; falls back to the next index. */
  private pickAccount(): OpencodeAccountState {
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (this.nextAccountIdx + i) % this.accounts.length;
      const acct = this.accounts[idx];
      if (this.isAccountReady(acct)) {
        this.nextAccountIdx = (idx + 1) % this.accounts.length;
        return acct;
      }
    }
    const fallbackIdx = this.nextAccountIdx % this.accounts.length;
    this.nextAccountIdx = (this.nextAccountIdx + 1) % this.accounts.length;
    return this.accounts[fallbackIdx];
  }

  private markCooldown(account: OpencodeAccountState): void {
    account.consecutiveFails++;
    const backoff = Math.min(
      OPENCODE_COOLDOWN_BASE_MS * Math.pow(2, account.consecutiveFails - 1),
      OPENCODE_COOLDOWN_MAX_MS
    );
    account.cooldownUntil = Date.now() + backoff + Math.random() * 1000;
  }

  private markSuccess(account: OpencodeAccountState): void {
    account.consecutiveFails = 0;
  }

  /** Mask an account id for logs (UI calls it a fingerprint). */
  private static maskAccountId(fingerprint: string): string {
    if (!fingerprint) return "direct";
    return `${fingerprint.slice(0, 8)}…`;
  }

  /**
   * Hand a JSON caller a JSON body even though the free-tier contract forced the upstream
   * request to stream. A streaming caller, a refusal and an already-JSON body pass through.
   */
  private finalizeForcedStream(
    input: ExecuteInput,
    result: Awaited<ReturnType<BaseExecutor["execute"]>>
  ): Awaited<ReturnType<BaseExecutor["execute"]>> {
    const attempt = attemptFor(input.body);
    noteFreeTierOutcome(attempt, "response" in result && !!result.response?.ok);
    if (input.stream) return result;
    if (!("response" in result) || !result.response) return result;
    // Non-null exactly when the contract applied: stands in for a surface/model guard.
    if (!attempt) return result;
    const response = rebuildJsonFromForcedStream(
      result.response,
      this._requestFormat,
      attempt.model
    );
    return response === result.response ? result : { ...result, response };
  }

  async execute(input: ExecuteInput) {
    return runInRequestContext(() => withRequestShapeRetry(input, (i) => this.executeOnce(i)));
  }

  private async executeOnce(input: ExecuteInput) {
    this._requestFormat = resolveOpencodeTargetFormat(this.provider, input.model);
    try {
      this.syncAccountsFromCredentials(input.credentials);

      // Console Go 400s without x-opencode-session; synthesize a stable one when
      // the client sent no session identity (see withSynthesizedOpencodeSession).
      const prepared = withSynthesizedOpencodeSession(input, this.provider);

      const hasProxies = this.accounts.some((a) => a.proxy !== null);
      // Fast path: no multi-account proxy wiring configured → original behavior, plus
      // the same bounded free-tier refusal retry the rotation loop runs (observed tool
      // names appended once; a refusal that survives it is returned as-is).
      if (this.accounts.length === 1 && !hasProxies) {
        const single = await super.execute(prepared);
        const first = single as { response: Response };
        const retryAfterRefusal = await retryFreeTierRefusalWithObservedTools(
          this.freeTierRetryCtx(input),
          prepared,
          first,
          prepared.log,
          "",
          (retryInput) =>
            super.execute(retryInput).then((r) => (r instanceof Response ? { response: r } : r))
        );
        if (retryAfterRefusal) {
          return this.finalizeForcedStream(input, retryAfterRefusal);
        }
        return this.finalizeForcedStream(input, single);
      }

      const { log } = prepared;
      let lastResult: Awaited<ReturnType<BaseExecutor["execute"]>> | null = null;

      for (let attempt = 0; attempt < this.accounts.length; attempt++) {
        const account = this.pickAccount();
        const masked = OpencodeExecutor.maskAccountId(account.fingerprint);
        // #5217 (Gap 2): promoted debug→info so the per-request account/proxy
        // rotation selection is visible in the Console log view at the default
        // APP_LOG_LEVEL=info (users could not see which account/proxy was used).
        // Token stays masked — never log the full account id.
        log?.info?.(
          "OPENCODE",
          `dispatch via account ${masked} (idx ${attempt + 1}/${this.accounts.length})` +
            (account.proxy
              ? ` through proxy ${account.proxy.host}:${account.proxy.port}`
              : " direct")
        );

        // Pin egress to this account's proxy for the whole BaseExecutor dispatch
        // (incl. its intra-URL 429 retries). skipUpstreamRetry lets THIS loop own
        // the cross-account 429 fallback instead of BaseExecutor's same-key retry.
        const result = await runWithProxyContext(account.proxy, () =>
          super.execute({ ...prepared, skipUpstreamRetry: true })
        );
        lastResult = result;

        const status = result.response.status;
        if (status === 429) {
          this.markCooldown(account);
          log?.warn?.("OPENCODE", `Rate limited (429) on account ${masked}, rotating to next…`);
          continue;
        }

        // Free-tier refusal: upstream rejected the REQUEST (client identity or
        // request shape), not this account. One bounded retry with observed tools
        // appended, then the refusal is returned unchanged — no rotation, no
        // account-health write (every sibling account gets the same verdict).
        if (status === 403 || status === 451) {
          let bodyText: string | null = null;
          try {
            bodyText = await result.response.clone().text();
          } catch {
            log?.debug?.("OPENCODE", "body read failed on free-tier check");
          }
          if (bodyText !== null && isOpencodeFreeTierRefusal(status, bodyText)) {
            return await handleLoopFreeTierRefusal(
              (retried) => this.finalizeForcedStream(input, retried),
              input,
              result,
              this.freeTierRetryCtx(input),
              { account, masked, proxyKey: proxyKeyOf(account.proxy) ?? "direct" },
              log,
              "",
              {
                dispatch: (retryInput) =>
                  runWithProxyContext(account.proxy, () =>
                    super.execute({
                      ...withSynthesizedOpencodeSession(retryInput, this.provider),
                      skipUpstreamRetry: true,
                    })
                  ).then((r) => (r instanceof Response ? { response: r } : r)),
                noteServed: () => undefined,
              }
            );
          }
        }

        // Account-health reset is reserved for HTTP successes: calling it on a
        // refusal/error would erase the cooldown backoff a healthy rotation
        // earned (#14011).
        if (result.response.ok) this.markSuccess(account);
        return this.finalizeForcedStream(input, result);
      }

      // All accounts returned 429 (or errored) — surface the last response.
      return lastResult ?? this.finalizeForcedStream(input, await super.execute(prepared));
    } finally {
      this._requestFormat = null;
    }
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ) {
    void urlIndex;
    void credentials;

    const base = this.config.baseUrl;
    switch (this._requestFormat) {
      case "claude":
        return `${base}/messages`;
      case "openai-responses":
        return `${base}/responses`;
      case "gemini":
        return `${base}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      default:
        return `${base}/chat/completions`;
    }
  }

  buildHeaders(
    credentials: ProviderCredentials | null,
    stream = true,
    clientHeaders?: Record<string, string> | null,
    model?: string,
    _health?: Record<string, unknown>,
    body?: unknown
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // #8467: honor Extra API Keys rotation via BaseExecutor.resolveEffectiveKey.
    // Fall back to accessToken only when no apiKey/extras resolve to a key.
    const key = credentials
      ? this.resolveEffectiveKey(credentials) || credentials.accessToken
      : undefined;

    if (key) {
      if (this._requestFormat === "claude") {
        headers["x-api-key"] = key;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    }

    if (this._requestFormat === "claude") {
      headers["anthropic-version"] = "2023-06-01";
    }

    // The free tier only answers streamed requests (measured 2026-09-17: a non-streamed
    // body answers 403 FreeTierError), so a JSON client is served by streaming upstream and
    // rebuilding the JSON body from the event stream — the path chatCore already takes for
    // any buffered event-stream response. Announcing the stream here keeps that buffering an
    // expected outcome rather than a warning.
    const gatedScope =
      Boolean(model) && isGatedFreeTierRequest(this._surface(), this.provider, model);
    if (stream || gatedScope) {
      headers["Accept"] = "text/event-stream";
    }

    // Synthesize OpenCode CLI identity headers by default so Cloudflare in front of
    // opencode.ai/zen doesn't 429 VPS requests lacking CLI identity. Opt-out via
    // OPENCODE_SYNTHESIZE_CLI_HEADERS=false. Client-supplied headers always win;
    // User-Agent is replaced with the CLI UA unless the client already sends one that
    // satisfies the OpenCode version contract. (#5997, #14013)
    const cliDefaults = resolveOpencodeCliDefaults(
      this.config?.id || this.provider || "opencode",
      gatedScope
    );

    this._clientSession = clientSuppliedOpencodeSession(clientHeaders, body);
    if (clientHeaders || cliDefaults) {
      forwardOpencodeClientHeaders(headers, clientHeaders ?? {}, {
        synthesizeRequestId: true,
        cliDefaults,
        sessionBody: projectOpencodeSessionBody(body),
      });
    }

    void model;

    return headers;
  }

  transformRequest(
    model: string,
    body: any,
    stream: boolean,
    credentials: ProviderCredentials
  ): any {
    let modifiedBody = super.transformRequest(model, body, stream, credentials);
    // Free-tier request contract (see opencodeFreeTierContract.ts): streaming plus a
    // non-empty tools array, in the shape of the surface this model is served on. Paid
    // models on the same host are not gated and stay untouched.
    const prepared = prepareFreeTierRequest(
      modifiedBody,
      this._requestFormat ?? resolveOpencodeTargetFormat(this.provider, model),
      this._surface(),
      this.provider,
      model,
      this._clientSession,
      body
    );
    modifiedBody = prepared.body;
    // 9router#1442: OpenCode upstreams (e.g. kimi-k2.6 via opencode-go) return
    // 400 "Extra inputs are not permitted, field: 'client_metadata'" — an
    // OpenAI-Codex/Claude-CLI passthrough field with no equivalent here. The
    // DefaultExecutor strip only covers cerebras/mistral, and OpencodeExecutor
    // extends BaseExecutor directly, so nothing removed it on this path.
    if (
      modifiedBody &&
      typeof modifiedBody === "object" &&
      !Array.isArray(modifiedBody) &&
      Object.prototype.hasOwnProperty.call(modifiedBody, "client_metadata")
    ) {
      delete (modifiedBody as Record<string, unknown>).client_metadata;
    }
    if (modifiedBody && typeof modifiedBody === "object" && !Array.isArray(modifiedBody)) {
      const mb = modifiedBody as Record<string, unknown>;
      if (Array.isArray(mb.tools) && mb.tools.length > MAX_TOOLS_LIMIT) {
        mb.tools = mb.tools.slice(0, MAX_TOOLS_LIMIT);
      }
    }
    // Console Go (opencode.ai/zen/go) runs a strict schema on /chat/completions
    // and rejects the Responses-API-shaped `reasoning: { enabled, effort }`
    // object with 400 "Extra inputs are not permitted, field: 'reasoning'" —
    // the transport only accepts the flat `reasoning_effort` string (proved
    // by the glm-5.2-high/-max variant aliases, which inject that flat field).
    // Fold a present `reasoning.effort` into `reasoning_effort` (explicit string
    // always wins), then strip the object from the wire body. Runs BEFORE the
    // variant-suffix injection so a client-supplied effort wins over the model
    // alias suffix. An object without `effort` is dropped as well: `enabled`
    // alone has no flat equivalent and the upstream rejects the whole field,
    // so keeping it would 400 the request. Scoped to the Go tier only — the
    // 400 evidence is go-specific; zen has no such incident on record.
    if (
      this.provider === "opencode-go" &&
      modifiedBody &&
      typeof modifiedBody === "object" &&
      !Array.isArray(modifiedBody)
    ) {
      const mb = modifiedBody as Record<string, unknown>;
      const reasoning = mb.reasoning;
      if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
        const effort = (reasoning as Record<string, unknown>).effort;
        if (mb.reasoning_effort === undefined && typeof effort === "string" && effort.length > 0) {
          mb.reasoning_effort = effort;
        }
        delete mb.reasoning;
      }
    }
    if (modifiedBody && typeof modifiedBody === "object" && !Array.isArray(modifiedBody)) {
      const mb = modifiedBody as Record<string, unknown>;
      // OpenCode accepts stream_options only on streaming Chat Completions (#13699).
      const format = this._requestFormat ?? resolveOpencodeTargetFormat(this.provider, model);
      if (format !== "openai" || mb.stream !== true) {
        delete mb.stream_options;
      }
      const parsed = parseEffortLevel(model);
      if (parsed) {
        mb.model = parsed.baseModel;
        if (mb.reasoning_effort === undefined) {
          mb.reasoning_effort = parsed.effort;
        }
      }
    }
    // #1543 / upstream PR #1099: thinking-mode upstreams routed through OpenCode
    // (DeepSeek V4 Flash, Kimi, MiniMax, ...) require reasoning_content echoed
    // back on assistant messages, or they 400 with "reasoning_content must be
    // passed back". OpenAI clients drop it across turns, so we inject a
    // placeholder for the affected model families.
    if (isThinkingMessageModel(model)) {
      modifiedBody = injectReasoningContentForThinkingModel(modifiedBody);
    }
    return modifiedBody;
  }
}
