import { PAYLOAD_TREE_MAX_CHARS } from "./payloadEditorMode";

let cachedMaxChars: number | null = null;
let inFlight: Promise<number> | null = null;

function normalizeMaxChars(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : PAYLOAD_TREE_MAX_CHARS;
}

/**
 * Resolve the runtime payload threshold once per browser page. The endpoint is
 * public and only exposes a non-sensitive UI limit, so any dashboard visitor
 * can render call-log payloads without a management API key.
 */
export function loadPayloadTreeMaxChars(): Promise<number> {
  if (cachedMaxChars !== null) {
    return Promise.resolve(cachedMaxChars);
  }
  const fetcher = globalThis.fetch;
  if (typeof fetcher !== "function") {
    cachedMaxChars = PAYLOAD_TREE_MAX_CHARS;
    return Promise.resolve(cachedMaxChars);
  }
  if (!inFlight) {
    inFlight = fetcher("/api/config/payload-editor", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) return PAYLOAD_TREE_MAX_CHARS;
        const body: unknown = await response.json();
        const value =
          body && typeof body === "object"
            ? (body as { maxTreeChars?: unknown }).maxTreeChars
            : undefined;
        return normalizeMaxChars(value);
      })
      .catch(() => PAYLOAD_TREE_MAX_CHARS)
      .then((value) => {
        cachedMaxChars = value;
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function resetPayloadTreeMaxCharsCache(): void {
  cachedMaxChars = null;
  inFlight = null;
}
