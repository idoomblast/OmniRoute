/**
 * OpenAI-compatible Responses API — background object endpoints.
 *
 * Implements the object lifecycle the Codex CLI (and other OpenAI-compatible
 * clients) expect for background responses:
 *   POST   /v1/responses              (background=true → 200 queued object)
 *   GET    /v1/responses/:id          (retrieve; terminal → full payload, running → in_progress envelope)
 *   DELETE /v1/responses/:id          (cancel; terminal → 404, running → cancelled object)
 *
 * Objects are persisted in the SQLite `response_objects` table (migration 111)
 * so they survive restarts and work across workers. The `customdata` column
 * stores a JSON envelope: { kind, model, status, created_at, error }.
 */

import { getDbInstance } from "@/lib/db/core";

export const RESPONSE_OBJECT_KIND = "response";

const RESPONSE_STATUS_VALUES = [
  "completed",
  "failed",
  "in_progress",
  "cancelling",
  "cancelled",
  "queued",
] as const;
export type ResponseObjectStatus = (typeof RESPONSE_STATUS_VALUES)[number];

/**
 * Statuses that can never change again. Terminal objects are returned in full
 * on GET and rejected with 404 on DELETE.
 */
export const TERMINAL_STATUSES: readonly ResponseObjectStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_STATUSES.includes(status as ResponseObjectStatus);
}

interface ObjectEnvelope {
  kind?: string;
  model?: string;
  status?: string;
  created_at?: number;
  error?: unknown;
}

function parseEnvelope(customdata: string | null | undefined): ObjectEnvelope | null {
  if (!customdata) return null;
  try {
    const parsed = JSON.parse(customdata);
    return parsed && typeof parsed === "object" ? (parsed as ObjectEnvelope) : null;
  } catch {
    return null;
  }
}

/**
 * Register a background response object. Called from the chat/responses
 * handler when `background: true` is requested, before execution is handed to
 * the background task manager.
 */
export function createResponseObject(id: string, model: string): void {
  const db = getDbInstance();
  db.prepare(
    `INSERT OR REPLACE INTO response_objects (id, object, status, created_at, customdata)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    "response",
    "queued",
    Math.floor(Date.now() / 1000),
    JSON.stringify({
      kind: RESPONSE_OBJECT_KIND,
      model,
      status: "queued",
      created_at: Math.floor(Date.now() / 1000),
    })
  );
}

/**
 * Load a response object row, ignoring rows written by other object kinds
 * (e.g. chatkit threads) that share the response_objects table.
 */
function loadResponseRow(id: string): { id: string; customdata: string | null } | null {
  const db = getDbInstance();
  const row = db.prepare("SELECT id, customdata FROM response_objects WHERE id = ?").get(id) as
    { id: string; customdata: string | null } | undefined;
  if (!row) return null;
  const env = parseEnvelope(row.customdata);
  if (!env || env.kind !== RESPONSE_OBJECT_KIND) return null;
  return row;
}

/**
 * Retrieve a response object.
 * - Terminal (completed/failed/cancelled): returns the stored full payload
 *   (the same object the streaming path would have emitted).
 * - Non-terminal (queued/in_progress/cancelling): returns an in_progress
 *   envelope so clients can keep polling.
 * - Unknown id: null (caller maps to 404).
 */
export function getResponseObject(id: string): Record<string, unknown> | null {
  const row = loadResponseRow(id);
  if (!row) return null;
  const env = parseEnvelope(row.customdata)!;

  if (isTerminalStatus(env.status)) {
    // The background manager persists the final payload under the same id;
    // return it verbatim so completed/failed/cancelled reads match the wire
    // format of a synchronous response.
    const db = getDbInstance();
    const stored = db.prepare("SELECT customdata FROM response_objects WHERE id = ?").get(id) as
      { customdata: string | null } | undefined;
    if (stored?.customdata) {
      try {
        const parsed = JSON.parse(stored.customdata);
        if (
          parsed &&
          typeof parsed === "object" &&
          parsed.id === id &&
          parsed.object === "response"
        ) {
          return parsed;
        }
      } catch {
        /* fall through to envelope */
      }
    }
  }

  // Non-terminal (or terminal payload not yet persisted): in_progress envelope.
  return {
    id,
    object: "response",
    model: env.model ?? "unknown",
    status: "in_progress",
    created_at: env.created_at ?? Math.floor(Date.now() / 1000),
    output: [],
    parallel_tool_calls: false,
    previous_response_id: null,
  };
}

/**
 * Cancel a response object.
 * - Terminal: returns { cancelled: false, status } → caller maps to 404.
 * - Running/queued: marks the object cancelled → caller maps to 200 object.
 * - Unknown id: null (caller maps to 404).
 */
export function cancelResponseObject(
  id: string
): { cancelled: boolean; status: ResponseObjectStatus } | null {
  const row = loadResponseRow(id);
  if (!row) return null;
  const env = parseEnvelope(row.customdata)!;

  if (isTerminalStatus(env.status)) {
    return { cancelled: false, status: env.status as ResponseObjectStatus };
  }

  const db = getDbInstance();
  db.prepare("UPDATE response_objects SET status = ? WHERE id = ?").run("cancelled", id);
  return { cancelled: true, status: "cancelled" };
}

/**
 * Build the queued background response object returned by POST /v1/responses
 * when background=true. Matches the shape Codex CLI's response_complete
 * handler expects (object:"response", status:"queued", output:[]).
 */
export function buildQueuedResponseObject(id: string, model: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "queued",
    background: true,
    model,
    output: [],
    parallel_tool_calls: false,
    previous_response_id: null,
  };
}
