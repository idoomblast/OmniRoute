import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIGRAVITY_CLI_FALLBACK_VERSION,
  ANTIGRAVITY_IDE_FALLBACK_VERSION,
  ANTIGRAVITY_VERSION_CACHE_TTL_MS,
  clearAntigravityVersionCaches,
  getCachedAntigravityCliVersion,
  getCachedAntigravityIdeVersion,
  resolveAntigravityCliVersion,
  resolveAntigravityIdeVersion,
  seedAntigravityCliVersionCache,
  seedAntigravityIdeVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

const originalDateNow = Date.now;

test.afterEach(() => {
  Date.now = originalDateNow;
  clearAntigravityVersionCaches();
});

test("IDE and CLI start with independent captured fallback versions", () => {
  assert.equal(getCachedAntigravityIdeVersion(), ANTIGRAVITY_IDE_FALLBACK_VERSION);
  assert.equal(getCachedAntigravityCliVersion(), ANTIGRAVITY_CLI_FALLBACK_VERSION);
  assert.equal(ANTIGRAVITY_IDE_FALLBACK_VERSION, "2.8.1");
  assert.equal(ANTIGRAVITY_CLI_FALLBACK_VERSION, "1.2.8");
});

test("IDE resolver reads the official updater feed and caches only the IDE version", async () => {
  const urls: string[] = [];
  const fetchMock = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify([{ version: "3.0.0", execution_id: "ide-release" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.equal(await resolveAntigravityIdeVersion(fetchMock as typeof fetch), "3.0.0");
  assert.equal(await resolveAntigravityIdeVersion(fetchMock as typeof fetch), "3.0.0");
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    "https://antigravity-auto-updater-974169037036.us-central1.run.app/releases"
  );
  assert.equal(getCachedAntigravityIdeVersion(), "3.0.0");
  assert.equal(getCachedAntigravityCliVersion(), "1.2.8");
});

test("IDE resolver selects the newest feed entry and never falls below its version floor", async () => {
  const mixedFeedFetch = async () =>
    new Response(
      JSON.stringify([
        { version: "3.0.0" },
        { version: "3.2.0" },
        { version: "2.9.0" },
        { version: "invalid" },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  assert.equal(await resolveAntigravityIdeVersion(mixedFeedFetch as typeof fetch), "3.2.0");

  clearAntigravityVersionCaches();
  const staleFeedFetch = async () =>
    new Response(JSON.stringify([{ version: "2.0.0" }, { version: "1.23.2" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(
    await resolveAntigravityIdeVersion(staleFeedFetch as typeof fetch),
    ANTIGRAVITY_IDE_FALLBACK_VERSION
  );
  assert.equal(getCachedAntigravityIdeVersion(), ANTIGRAVITY_IDE_FALLBACK_VERSION);
});

test("IDE resolver keeps a newer cached version when a later feed response is older", async () => {
  let now = 1_000;
  Date.now = () => now;
  seedAntigravityIdeVersionCache("2.9.0", now);
  now += ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1;

  const olderFeedFetch = async () =>
    new Response(JSON.stringify([{ version: "2.8.0" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(await resolveAntigravityIdeVersion(olderFeedFetch as typeof fetch), "2.9.0");
  assert.equal(getCachedAntigravityIdeVersion(), "2.9.0");
});

test("CLI resolver reads the official Google GitHub release and caches only the CLI version", async () => {
  const urls: string[] = [];
  const fetchMock = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ tag_name: "v1.5.17", name: "1.5.17" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  // The resolver takes the newest of (feed, cache, fallback); the feed wins here.
  assert.equal(await resolveAntigravityCliVersion(fetchMock as typeof fetch), "1.5.17");
  assert.equal(await resolveAntigravityCliVersion(fetchMock as typeof fetch), "1.5.17");
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest"
  );
  assert.equal(getCachedAntigravityCliVersion(), "1.5.17");
  assert.equal(getCachedAntigravityIdeVersion(), "2.8.1");
});

test("CLI resolver never drops below the Gemini 4 tier floor", async () => {
  // A stale feed advertising an older CLI must not lower the identity below 1.2.8,
  // the first version that serves the Gemini 4 Hydrogen tier ids (older ones 404).
  const staleFeedFetch = async () =>
    new Response(JSON.stringify({ tag_name: "v1.2.0", name: "1.2.0" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(await resolveAntigravityCliVersion(staleFeedFetch as typeof fetch), "1.2.8");
  assert.equal(getCachedAntigravityCliVersion(), "1.2.8");
});

test("IDE and CLI TTL refreshes are independent", async () => {
  let now = 1_000;
  Date.now = () => now;
  seedAntigravityCliVersionCache("1.2.8", now);

  const firstFetch = async () =>
    new Response(JSON.stringify([{ version: "2.9.0" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const secondFetch = async () =>
    new Response(JSON.stringify([{ version: "3.0.0" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(await resolveAntigravityIdeVersion(firstFetch as typeof fetch), "2.9.0");
  now += ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1;
  assert.equal(await resolveAntigravityIdeVersion(secondFetch as typeof fetch), "3.0.0");
  assert.equal(getCachedAntigravityCliVersion(), "1.2.8");
});

test("each resolver falls back only to its own last known good version", async () => {
  const failingFetch = async () => {
    throw new Error("network down");
  };

  assert.equal(
    await resolveAntigravityIdeVersion(failingFetch as typeof fetch),
    ANTIGRAVITY_IDE_FALLBACK_VERSION
  );
  assert.equal(
    await resolveAntigravityCliVersion(failingFetch as typeof fetch),
    ANTIGRAVITY_CLI_FALLBACK_VERSION
  );

  seedAntigravityIdeVersionCache("2.9.0", 0);
  seedAntigravityCliVersionCache("1.3.0", 0);
  assert.equal(await resolveAntigravityIdeVersion(failingFetch as typeof fetch), "2.9.0");
  assert.equal(await resolveAntigravityCliVersion(failingFetch as typeof fetch), "1.3.0");
});

test("concurrent requests coalesce within each product without crossing products", async () => {
  let ideCalls = 0;
  let cliCalls = 0;
  let releaseIde: (() => void) | undefined;
  let releaseCli: (() => void) | undefined;
  const ideGate = new Promise<void>((resolve) => {
    releaseIde = resolve;
  });
  const cliGate = new Promise<void>((resolve) => {
    releaseCli = resolve;
  });

  const ideFetch = async () => {
    ideCalls += 1;
    await ideGate;
    return new Response(JSON.stringify([{ version: "3.0.0" }]), { status: 200 });
  };
  const cliFetch = async () => {
    cliCalls += 1;
    await cliGate;
    return new Response(JSON.stringify({ tag_name: "1.4.0" }), { status: 200 });
  };

  const ideOne = resolveAntigravityIdeVersion(ideFetch as typeof fetch);
  const ideTwo = resolveAntigravityIdeVersion(ideFetch as typeof fetch);
  const cliOne = resolveAntigravityCliVersion(cliFetch as typeof fetch);
  const cliTwo = resolveAntigravityCliVersion(cliFetch as typeof fetch);
  releaseIde?.();
  releaseCli?.();

  assert.deepEqual(await Promise.all([ideOne, ideTwo]), ["3.0.0", "3.0.0"]);
  assert.deepEqual(await Promise.all([cliOne, cliTwo]), ["1.4.0", "1.4.0"]);
  assert.equal(ideCalls, 1);
  assert.equal(cliCalls, 1);
});

test("a cached CLI version below the floor never reaches the wire", async () => {
  // The resolver applies the floor, but the header path reads the CACHE directly.
  // A stale/seed cache of 1.2.7 made an IDE-backed tier call emit 1.2.7, which the
  // upstream answers with 404 for Gemini 4 tier ids.
  seedAntigravityCliVersionCache("1.2.7");
  assert.equal(getCachedAntigravityCliVersion(), "1.2.8");

  // A cache at or above the floor is honored unchanged.
  seedAntigravityCliVersionCache("1.9.0");
  assert.equal(getCachedAntigravityCliVersion(), "1.9.0");
  clearAntigravityVersionCaches();
});
