import { NextResponse } from "next/server";
import { listWaiting, resumeLocalScan, rotateScannerKey, verifyScannerKey } from "@/lib/competitors/local";
import { now, scanTimeLimitMs } from "@/lib/competitors/settings";

/**
 * The local station's check-in (Website Scanning PRD 2026-11-04). Machine
 * key as a bearer token. Answers with every scan waiting for a station,
 * oldest first, each carrying its own short-lived scan token — the key itself
 * can do nothing else. When the key is 30 days old the server rotates it here
 * and returns the new secret once; the poller stores it. No person involved.
 *
 * `?resume=<scanId>&reason=network|shutdown|crash|error&stoppedAt=<ISO>&pages=<n>&left=<n>` — the station holds the
 * saved place of a scan it did not finish: the scan goes back to waiting before the list is built, so the same
 * answer hands it back and the station continues from the page it stopped on.
 */
export async function GET(req: Request) {
  const key = await verifyScannerKey(req.headers.get("authorization"));
  if (!key) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const resume = q.get("resume");
  if (resume) {
    await resumeLocalScan(resume, key.id, {
      reason: q.get("reason") ?? "crash",
      stoppedAt: q.get("stoppedAt"),
      pagesRead: Math.max(0, Number(q.get("pages")) || 0),
      pagesLeft: Math.max(0, Number(q.get("left")) || 0),
    });
  }
  const waiting = await listWaiting({ ms: await scanTimeLimitMs() });
  const rotated = key.rotateDue ? await rotateScannerKey(key.id) : null;
  return NextResponse.json({
    station: key.label,
    serverTime: (await now()).toISOString(),
    waiting,
    ...(rotated ? { rotatedKey: rotated.secret } : {}),
  });
}
