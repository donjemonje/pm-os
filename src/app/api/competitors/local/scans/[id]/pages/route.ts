import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { isPageKind } from "@/lib/competitors/config";
import { pdfToText } from "@/lib/competitors/fetcher";
import { startLocalScan, verifyScanToken } from "@/lib/competitors/local";
import { storageFull } from "@/lib/competitors/settings";
import { extractLinks } from "@/lib/competitors/html";
import { categoryOf, recordPage, type PageReadStatus } from "@/lib/competitors/pages";
import { appendHandedInPage } from "@/lib/competitors/scan";
import { isInsideSite, pageKey } from "@/lib/competitors/url";

type Params = { params: Promise<{ id: string }> };

/** Raw HTML per post (longer is cut, the text extractor reads what is there); PDFs up to 20 MB (base64). */
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** The whole request, checked before the body is parsed (a 20 MB PDF is ~27 MB of base64 plus the envelope). */
const MAX_BODY_BYTES = 30 * 1024 * 1024;
/** Plain text handed in directly (the page store keeps MAX_PAGE_CHARS). */
const MAX_TEXT_CHARS = 400_000;

const STATUSES: PageReadStatus[] = ["ok", "notfound", "blocked", "login", "timeout", "slowdown", "other"];

/**
 * POST one page the station read (scan token as bearer). Body:
 *   { url, status: "ok" | "notfound" | "blocked" | "login" | "timeout" | "slowdown" | "other",
 *     html?, text?, pdfBase64?, title?, kind?, ms?, attempts?,
 *     linked?: string[] }   URLs the station found pointing at pages (its sitemap entries) — feeds "unlinked"
 * The server extracts the text (HTML → text, PDF → text), normalizes, hashes
 * and decides new / changed / unchanged / not read, exactly as for the remote
 * lane. URLs outside the competitor's site are refused. Every post is a
 * heartbeat; the first one marks the scan running. When the PM-OS store is
 * full the answer is { stop: "storage" } and the station stops the scan.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const tok = await verifyScanToken(req.headers.get("authorization"), id);
  if (!tok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "request is larger than 30 MB" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const scan = await db.competitorScan.findUnique({ where: { id }, select: { id: true, status: true, workspaceId: true, sourceId: true, source: { select: { type: true, url: true, competitor: { select: { host: true, deletedAt: true } } } } } });
  if (!scan) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (scan.source.competitor.deletedAt || scan.status === "cancelled") return NextResponse.json({ error: "The scan was cancelled" }, { status: 410 });
  if (scan.status !== "running" && scan.status !== "pending_local" && scan.status !== "queued") return NextResponse.json({ error: "The scan already ended" }, { status: 409 });

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "url must be an absolute http(s) URL" }, { status: 400 });
  }
  if (!isInsideSite(url, scan.source.competitor.host)) return NextResponse.json({ error: `url is outside the competitor's site (${scan.source.competitor.host})` }, { status: 422 });
  const statusIn = typeof body.status === "string" && (STATUSES as string[]).includes(body.status) ? (body.status as PageReadStatus) : null;
  if (!statusIn) return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });

  let status: PageReadStatus = statusIn;
  let html: string | null = typeof body.html === "string" ? body.html : null;
  let text: string | null = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT_CHARS) : null;
  let kind = isPageKind(body.kind) ? body.kind : "page";
  /** Why a page the station read ends as "not read" here (a refusal would make the station abandon the whole scan). */
  let readError: string | null = null;
  // Oversize HTML is cut, not refused: the text extractor reads what is there.
  if (html && Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) html = Buffer.from(html, "utf8").subarray(0, MAX_HTML_BYTES).toString("utf8");
  if (typeof body.pdfBase64 === "string" && body.pdfBase64) {
    kind = "document";
    html = null;
    let bytes: Buffer | null = null;
    try {
      bytes = Buffer.from(body.pdfBase64, "base64");
    } catch {
      return NextResponse.json({ error: "pdfBase64 is not base64" }, { status: 400 });
    }
    if (bytes.byteLength > MAX_PDF_BYTES) {
      readError = `PDF larger than 20 MB (${Math.round(bytes.byteLength / 1024 / 1024)} MB)`;
    } else {
      try {
        text = await pdfToText(new Uint8Array(bytes));
      } catch (e) {
        readError = `PDF could not be read: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)}`;
      }
    }
    if (readError) {
      // The page is recorded as not read this scan (its previous text stays), the scan goes on.
      status = "other";
      text = null;
    }
  }
  if (status === "ok" && !html && !text) return NextResponse.json({ error: "an ok page needs html, text or pdfBase64" }, { status: 400 });

  if (scan.status !== "running") await startLocalScan(id, null);
  // PM-OS keeps at most STORAGE_LIMIT_CHARS of page text in all (Daniel 2026-11-09). Full → this page is not taken, the scan is
  // flagged and the station stops; everything left is "not attempted — storage limit" when the scan is processed.
  if (status === "ok" && (await storageFull())) {
    await db.competitorScan.update({ where: { id }, data: { errorKind: "storage", heartbeatAt: new Date() } });
    return NextResponse.json({ url: url.href, outcome: "skipped", stop: "storage", error: "PM-OS storage limit reached — the scan stops here; contact support@pm-os.io" });
  }
  const sourceLabel = C.profile.sourceTypes[scan.source.type] ?? scan.source.type;
  const ms = typeof body.ms === "number" && Number.isFinite(body.ms) ? Math.max(0, Math.round(body.ms)) : 0;
  const attempts = typeof body.attempts === "number" && Number.isFinite(body.attempts) ? Math.max(1, Math.round(body.attempts)) : 1;
  const r = await recordPage(
    { scanId: id, sourceId: scan.sourceId, workspaceId: scan.workspaceId, url: url.href, siteUrl: scan.source.url, status, html, text, title: typeof body.title === "string" ? body.title : null, kind, via: "handin", ms, errorDetail: readError },
    sourceLabel,
  );
  // The links on the page say what still points where (the "unlinked" state) — collected on the scan and applied when it is
  // processed, after every page row exists (the same bookkeeping as the remote lane).
  const linked = new Set<string>();
  if (html) for (const l of extractLinks(html, url.href)) if (isInsideSite(l, scan.source.competitor.host)) linked.add(pageKey(l, scan.source.url));
  // The station's own discoveries (its sitemap entries) point at pages too — handed in with a page, usually the first one.
  if (Array.isArray(body.linked)) {
    for (const raw of (body.linked as unknown[]).slice(0, 5000)) {
      if (typeof raw !== "string") continue;
      try {
        const l = new URL(raw);
        if (isInsideSite(l, scan.source.competitor.host)) linked.add(pageKey(l, scan.source.url));
      } catch {
        // not a URL — ignored
      }
    }
  }
  await appendHandedInPage(id, {
    url: r.url,
    status: status === "ok" ? 200 : status === "notfound" ? 404 : status === "login" ? 401 : status === "blocked" ? 403 : status === "slowdown" ? 429 : 0,
    outcome: r.outcome,
    ...(r.outcome === "failed" ? { category: r.category ?? categoryOf(status as Exclude<PageReadStatus, "ok">), error: readError ?? status } : {}),
    chars: r.chars,
    ms,
    via: "handin",
  }, linked, [
    ...(attempts > 1 ? [{ at: new Date().toISOString(), level: "info" as const, msg: `Station retried ${attempts - 1} time${attempts === 2 ? "" : "s"} before ${status === "ok" ? "reading the page" : `giving up (${status})`}`, url: r.url }] : []),
    // Same words as the remote lane (scan.ts) so the scan log reads alike whichever lane ran.
    ...(status === "slowdown" ? [{ at: new Date().toISOString(), level: "warn" as const, msg: "The site answered 429 Too Many Requests — stopping this scan; the next one continues from here", url: r.url }] : []),
    ...(readError ? [{ at: new Date().toISOString(), level: "warn" as const, msg: readError, url: r.url }] : []),
  ]);
  return NextResponse.json({ url: r.url, outcome: r.outcome, state: r.state });
}
