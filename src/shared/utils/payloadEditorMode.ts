export const PAYLOAD_TREE_MAX_CHARS = 131072;

export function parsePayloadTreeMaxChars(raw: string | null | undefined): number {
  const value = (raw ?? "").trim();
  if (!/^\d+$/.test(value)) {
    return PAYLOAD_TREE_MAX_CHARS;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : PAYLOAD_TREE_MAX_CHARS;
}

export const PAYLOAD_EDITOR_FAILURE_MESSAGE = "PayloadJsonEditor: viewer unavailable";

export type PayloadEditorMode = "tree" | "text";

export function isValidJson(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.trim() === "") {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function resolvePayloadEditorMode(
  jsonText: string | null | undefined,
  maxChars: number = PAYLOAD_TREE_MAX_CHARS
): PayloadEditorMode {
  if (typeof jsonText !== "string") {
    return "text";
  }
  const limit = Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : PAYLOAD_TREE_MAX_CHARS;
  if (jsonText.length > limit) {
    return "text";
  }
  return isValidJson(jsonText) ? "tree" : "text";
}

/**
 * JSONEditor has no single read-only switch: `onEditable` only blocks direct
 * field editing, while Sort/Transform/Repair and mutation hotkeys keep working.
 * These options remove every mutation surface that would otherwise change the
 * displayed document.
 */
export function createReadOnlyEditorOptions(mode: PayloadEditorMode) {
  return {
    mode,
    history: false,
    mainMenuBar: false,
    navigationBar: true,
    enableSort: false,
    enableTransform: false,
    statusBar: mode === "text",
    onEditable: () => false,
    onCreateMenu: () => [],
  };
}

/**
 * Mutation hotkeys handled inside JSONEditor's Node/Textmode key handlers.
 * The editor does not consult `onEditable` there, so the container blocks
 * these combinations in the capture phase.
 */
export function isBlockedMutationShortcut(event: {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  const key = (event.key || "").toLowerCase();

  // ALT+SHIFT+Arrow moves nodes between parents (JSONEditor Node.onKeyDown).
  if (event.altKey && event.shiftKey && key.startsWith("arrow")) {
    return true;
  }

  if (!event.ctrlKey && !event.metaKey) {
    return false;
  }
  if (["d", "i", "m", "z", "y"].includes(key)) {
    return true;
  }
  return event.key === "Delete" || event.key === "Insert";
}
