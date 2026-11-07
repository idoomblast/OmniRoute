/**
 * Import-token helpers for the OAuth provider route.
 *
 * Extracted from the route file to keep it under the frozen file-size cap.
 */

import { createHash } from "node:crypto";

/**
 * Serialize imports of the same token so two concurrent pastes cannot both see
 * "no match" and create two connections with different device identities.
 */
const importTokenLocks = new Map<string, Promise<unknown>>();

export function withImportTokenLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = importTokenLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.finally(() => {
    if (importTokenLocks.get(key) === tail) importTokenLocks.delete(key);
  });
  importTokenLocks.set(key, tail);
  return run;
}

/** Hash a raw import token for use as a non-secret lock key. */
export function importTokenLockKey(provider: string, token: unknown): string {
  return `${provider}:${createHash("sha256").update(String(token)).digest("hex")}`;
}

/**
 * Re-importing a token onto an existing connection must keep its persisted
 * device identity, or the account presents to the upstream as a new device.
 */
export function keepDeviceIdentity<T extends { providerSpecificData?: Record<string, unknown> }>(
  tokenData: T,
  existing: { providerSpecificData?: Record<string, unknown> | null } | undefined
): T {
  const cliUserID = existing?.providerSpecificData?.cliUserID;
  if (typeof cliUserID !== "string" || !tokenData.providerSpecificData) return tokenData;
  return { ...tokenData, providerSpecificData: { ...tokenData.providerSpecificData, cliUserID } };
}
