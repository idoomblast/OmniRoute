/**
 * Import-token lock: a rejected task must not leak an unobserved rejection, and
 * the key must be reusable once the failing task settles.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withImportTokenLock } from "../../src/app/api/oauth/[provider]/[action]/importTokenHelpers.ts";

test("rejected import task is caught by the caller, leaves no unhandled rejection, and frees the key", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      withImportTokenLock("provider:test", async () => {
        throw new Error("synthetic import failure");
      }),
      /synthetic import failure/
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, [], "the lock tail must be rejection-neutral");

    const next = await withImportTokenLock("provider:test", async () => "reused");
    assert.equal(next, "reused", "a failed task frees the key for the next import");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
