import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { isPageKind } from "@/lib/competitors/config";
import { pdfToText } from "@/lib/competitors/fetcher";
import { startLocalScan, verifyScanToken } from "@/lib/competitors/local";
import { extractLinks } from "@/lib/competitors/html";
import { categoryOf, recordPage, type PageReadStatus } from "@/lib/competitors/pages";
import { appendHandedInPage } from "@/lib/competitors/scan";
import { isInsideSite, pageKey } from "@/lib/competitors/url";

type Params = { params: Promise<{ id: string }> };

/** Raw HTML per post; PDFs up to 20 MB (base64). */
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

const STATUSES: PageReadStatus[] = ["ok", "notfound", "blocked", "login", "timeout", "slowdown", "other"];

/**
 * POST one page the station read (scan token as bearer). Body:
 *   { url, status: "ok" | "notfound" | "blocked" | "login" | "timeout" | "slowdown" | "other",
 *     html?, text?, pdfBase64?, title?, kind?, ms? }
 * The server extracts the text (HTML → text, PDF → text), normalizes, hashes
 * and decides new / changed / unchanged / not read, exactly as for the remote
 * lane. URLs outside the competitor's site are refused. Every post is a
 * heartbeat; the first one marks the scan running.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const tok = await verifyScanToken(req.headers.get("authorization"), id);
  if (!tok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const scan = await db.competitorScan.findUnique({ where: { id }, select: { id: true, status: true, workspaceId: true, sourceId: true, source: { select: { type: true, competitor: { select: { host: true, deletedAt: true } } } } } });
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
  const status = typeof body.status === "string" && (STATUSES as string[]).includes(body.status) ? (body.status as PageReadStatus) : null;
  if (!status) return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });

  let html: string | null = typeof body.html === "string" ? body.html : null;
  let text: string | null = typeof body.text === "string" ? body.text : null;
  let kind = isPageKind(body.kind) ? body.kind : "page";
  if (html && Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return NextResponse.json({ error: "html is larger than 2 MB" }, { status: 413 });
  if (typeof body.pdfBase64 === "string" && body.pdfBase64) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.pdfBase64, "base64");
    } catch {
      return NextResponse.json({ error: "pdfBase64 is not base64" }, { status: 400 });
    }
    if (bytes.byteLength > MAX_PDF_BYTES) return NextResponse.json({ error: "PDF is larger than 20 MB" }, { status: 413 });
    try {
      text = await pdfToText(new Uint8Array(bytes));
    } catch (e) {
      return NextResponse.json({ error: `PDF could not be read: ${e instanceof Error ? e.message : String(e)}` }, { status: 422 });
    }
    html = null;
    kind = "document";
  }
  if (status === "ok" && !html && !text) return NextResponse.json({ error: "an ok page needs html, text or pdfBase64" }, { status: 400 });

  if (scan.status !== "running") await startLocalScan(id, null);
  const sourceLabel = C.profile.sourceTypes[scan.source.type] ?? scan.source.type;
  const ms = typeof body.ms === "number" && Number.isFinite(body.ms) ? Math.max(0, Math.round(body.ms)) : 0;
  const attempts = typeof body.attempts === "number" && Number.isFinite(body.attempts) ? Math.max(1, Math.round(body.attempts)) : 1;
  const r = await recordPage(
    { scanId: id, sourceId: scan.sourceId, workspaceId: scan.workspaceId, url: url.href, status, html, text, title: typeof body.title === "string" ? body.title : null, kind, via: "handin", ms },
    sourceLabel,
  );
  // The links on the page say what still points where (the "unlinked" state) — collected on the scan and applied when it is
  // processed, after every page row exists (the same bookkeeping as the remote lane).
  const linked = new Set<string>();
  if (html) for (const l of extractLinks(html, url.href)) if (isInsideSite(l, scan.source.competitor.host)) linked.add(pageKey(l));
  await appendHandedInPage(id, {
    url: r.url,
    status: status === "ok" ? 200 : status === "notfound" ? 404 : status === "login" ? 401 : status === "blocked" ? 403 : status === "slowdown" ? 429 : 0,
    outcome: r.outcome,
    ...(r.outcome === "failed" ? { category: r.category ?? categoryOf(status as Exclude<PageReadStatus, "ok">), error: status } : {}),
    chars: r.chars,
    ms,
    via: "handin",
  }, linked, attempts > 1 ? [{ at: new Date().toISOString(), level: "info", msg: `Station retried ${attempts - 1} time${attempts === 2 ? "" : "s"} before ${status === "ok" ? "reading the page" : `giving up (${status})`}`, url: r.url }] : []);
  return NextResponse.json({ url: r.url, outcome: r.outcome, state: r.state });
}
