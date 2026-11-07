/** context-1m beta header gating, extracted to keep executors/base.ts under its cap. */

import { isClaudeCodeCompatible } from "../../services/provider.ts";
import {
  appendAnthropicBetaHeader,
  CONTEXT_1M_BETA_HEADER,
  modelHasNativeContext1m,
  modelSupportsContext1mBeta,
} from "../../services/claudeCodeCompatible.ts";
import { getClaudeCodeCompatibleRequestDefaults } from "@/lib/providers/requestDefaults";

export function applyContext1mBetaHeader(args: {
  headers: Record<string, string>;
  provider: string;
  model: string;
  extendedContext?: boolean;
  providerSpecificData?: Record<string, unknown>;
}): void {
  const ccCompatible = isClaudeCodeCompatible(args.provider);
  const ccDefaults = ccCompatible
    ? getClaudeCodeCompatibleRequestDefaults(args.providerSpecificData)
    : {};
  const forwardExtendedContext =
    args.extendedContext && modelSupportsContext1mBeta(args.model) && !ccCompatible;
  const forwardCcCompatibleContext1m =
    ccCompatible && ccDefaults.context1m === true && !modelHasNativeContext1m(args.model);
  if (forwardExtendedContext || forwardCcCompatibleContext1m) {
    appendAnthropicBetaHeader(args.headers, CONTEXT_1M_BETA_HEADER);
  }
}
