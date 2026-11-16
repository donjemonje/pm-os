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
 *
 * A station that reads several sites at the same time (Daniel 2026-11-16) may hold several saved places: it repeats
 * all five values once per scan, in the same order (the n-th reason / stoppedAt / pages / left belong to the n-th
 * resume). The answer names the scans this check-in looked at in `resumed`. A station that sends the five values once
 * — the one-scan-at-a-time poller — is served exactly as before.
 */
/** Saved places one check-in may report (a station reads 10 sites at the same time by default; more than this is ignored). */
const MAX_RESUMES = 50;

/** A page count from the station: a whole number, 0 to 10 million. */
function count(v: string | null | undefined): number {
  const n = Math.trunc(Number(v ?? 0));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 10_000_000) : 0;
}

export async function GET(req: Request) {
  const key = await verifyScannerKey(req.headers.get("authorization"));
  if (!key) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const resumes = q.getAll("resume").slice(0, MAX_RESUMES);
  const reasons = q.getAll("reason");
  const stoppedAts = q.getAll("stoppedAt");
  const pages = q.getAll("pages");
  const lefts = q.getAll("left");
  const resumed: string[] = [];
  for (const [i, scanId] of resumes.entries()) {
    if (!scanId) continue;
    await resumeLocalScan(scanId, key.id, {
      reason: reasons[i] ?? "crash",
      stoppedAt: stoppedAts[i] ?? null,
      pagesRead: count(pages[i]),
      pagesLeft: count(lefts[i]),
    });
    resumed.push(scanId);
  }
  const waiting = await listWaiting({ ms: await scanTimeLimitMs() });
  const rotated = key.rotateDue ? await rotateScannerKey(key.id) : null;
  return NextResponse.json({
    station: key.label,
    serverTime: (await now()).toISOString(),
    waiting,
    // The saved places this check-in looked at (whatever became of them). A station that sent several knows they were
    // all heard; an answer without this field came from a server that hears only the first.
    ...(resumed.length ? { resumed } : {}),
    ...(rotated ? { rotatedKey: rotated.secret } : {}),
  });
}
