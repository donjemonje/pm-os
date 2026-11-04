import { NextResponse } from "next/server";
import { ceiling } from "@/lib/competitors/config";
import { listWaiting, rotateScannerKey, verifyScannerKey } from "@/lib/competitors/local";
import { now } from "@/lib/competitors/settings";

/**
 * The local station's check-in (Website Scanning PRD 2026-11-04). Machine
 * key as a bearer token. Answers with every scan waiting for a station,
 * oldest first, each carrying its own short-lived scan token — the key itself
 * can do nothing else. When the key is 30 days old the server rotates it here
 * and returns the new secret once; the poller stores it. No person involved.
 */
export async function GET(req: Request) {
  const key = await verifyScannerKey(req.headers.get("authorization"));
  if (!key) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const waiting = await listWaiting(ceiling());
  const rotated = key.rotateDue ? await rotateScannerKey(key.id) : null;
  return NextResponse.json({
    station: key.label,
    serverTime: (await now()).toISOString(),
    waiting,
    ...(rotated ? { rotatedKey: rotated.secret } : {}),
  });
}
