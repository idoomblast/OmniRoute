import { NextResponse } from "next/server";
import { parsePayloadTreeMaxChars } from "@/shared/utils/payloadEditorMode";

export const dynamic = "force-dynamic";

/**
 * GET /api/config/payload-editor — runtime display limit for the call-log
 * payload viewer. The value is read from the server environment on every
 * request, so operators can tune it with a container restart (no rebuild).
 */
export async function GET() {
  const maxTreeChars = parsePayloadTreeMaxChars(process.env.PAYLOAD_TREE_MAX_CHARS);
  return NextResponse.json(
    { maxTreeChars },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
