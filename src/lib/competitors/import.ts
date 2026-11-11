import { db } from "../db";
import { recordCompetitorEvent } from "./analytics";
import { isPageKind, type PageKind, type SourceType } from "./config";
import { contentHash } from "./html";
import { pageKey } from "./url";

/**
 * A collector hands pages to the pipeline. The website is the one source the
 * scanner fetches itself; every other source type — datasheets, a help
 * center, video transcripts, archive captures, press — arrives through here
 * as page texts with their URLs, and the scan that follows runs exactly as a
 * website scan does from the diff onward (lib/competitors/scan.ts). Today's
 * collectors are the import CLI (scripts/competitors-scanner.mts --import)
 * and, later, an upload in Settings and connectors per source type.
 */

export interface CollectedPage {
  /** Absolute http(s) URL the text was read from — every fact and quote links back to it. */
  url: string;
  title?: string;
  text: string;
  kind?: PageKind;
  /** Publish/capture date the source states, ISO; null when it states none. */
  observedAt?: string | null;
}

/** Longer texts (a 200-page PDF) are cut; the AI step truncates far below this anyway. */
export const MAX_IMPORTED_PAGE_CHARS = 200_000;

export type ImportResult =
  | { scanId: string; sourceId: string; pages: number; dropped: number }
  | { error: "running" | "no_pages" | "no_competitor" };

/**
 * Store a collector's pages as a queued scan of the competitor's source of
 * that type (created on first use) and return the scan to launch. Pages
 * without a usable URL or text are dropped and counted.
 */
export async function importPages(opts: {
  workspaceId: string;
  competitorId: string;
  /** Any source type — a website bundle (pages collected by hand or a browser-side collector) diffs against the scanner's own crawl of the same source. */
  sourceType: SourceType;
  /** The source's own address (a help-center home, a docs root); default = the competitor's website. */
  sourceUrl?: string | null;
  pages: CollectedPage[];
  startedById: string | null;
}): Promise<ImportResult> {
  const competitor = await db.competitor.findFirst({ where: { id: opts.competitorId, workspaceId: opts.workspaceId }, select: { id: true, websiteUrl: true } });
  if (!competitor) return { error: "no_competitor" };
  const active = await db.competitorScan.findFirst({ where: { workspaceId: opts.workspaceId, status: { in: ["queued", "running"] } }, select: { id: true } });
  if (active) return { error: "running" };

  const seen = new Set<string>();
  const rows: { url: string; title: string | null; kind: PageKind; text: string; chars: number; contentHash: string; observedAt: Date | null }[] = [];
  let dropped = 0;
  for (const p of opts.pages) {
    const text = (p.text ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_IMPORTED_PAGE_CHARS);
    let url: URL;
    try {
      url = new URL(p.url);
    } catch {
      dropped++;
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || !text) {
      dropped++;
      continue;
    }
    const key = pageKey(url);
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    const observedAt = p.observedAt ? new Date(p.observedAt) : null;
    rows.push({
      url: key,
      title: p.title?.trim().slice(0, 300) || null,
      kind: isPageKind(p.kind) ? p.kind : "page",
      text,
      chars: text.length,
      contentHash: contentHash(text),
      observedAt: observedAt && !Number.isNaN(observedAt.getTime()) ? observedAt : null,
    });
  }
  if (rows.length === 0) return { error: "no_pages" };

  const source = await db.competitorSource.upsert({
    where: { competitorId_type: { competitorId: competitor.id, type: opts.sourceType } },
    create: { workspaceId: opts.workspaceId, competitorId: competitor.id, type: opts.sourceType, url: opts.sourceUrl?.trim() || competitor.websiteUrl, lastStatus: "running" },
    update: { lastStatus: "running", ...(opts.sourceUrl?.trim() ? { url: opts.sourceUrl.trim() } : {}) },
    select: { id: true },
  });
  const scan = await db.competitorScan.create({
    data: { workspaceId: opts.workspaceId, sourceId: source.id, trigger: "import", fetchMode: "bundle", startedById: opts.startedById, status: "queued" },
    select: { id: true },
  });
  // In batches: a help center is hundreds of rows.
  for (let i = 0; i < rows.length; i += 100) {
    await db.scanPage.createMany({ data: rows.slice(i, i + 100).map((r) => ({ scanId: scan.id, sourceId: source.id, ...r })) });
  }
  await recordCompetitorEvent(opts.workspaceId, opts.startedById, "cmp_scan_started", { scanId: scan.id, competitorId: competitor.id, trigger: "import", sourceType: opts.sourceType, pages: rows.length, dropped });
  return { scanId: scan.id, sourceId: source.id, pages: rows.length, dropped };
}
