import { db } from "../../db";
import { folderSkip, sourceSkip } from "../analysis/kinds";
import { aiStepEnabled, getGlobalScanSettings } from "../settings";
import { notifyNewsBatch } from "./email";
import type { NewsPage } from "./intake";
import { addNewAbilities, loadKnowledgeList } from "./knowledge";
import { intakeBatch } from "./run";

/**
 * NEWS AFTER A SCAN — a real scan feeds the news intake (News Feed & Notifications PRD; Daniel 2026-11-22).
 *
 * When a scan of one of a company's addresses has ended, the pages of that address that are NEW or CHANGED since
 * the company's knowledge base was made — and that the intake has not read in their current text — go to the
 * intake as one batch: a new page whole, a changed page as its changed text only (intake.ts planRequests). What the
 * intake finds is stored, the new abilities join the knowledge base, and the batch's one email goes out at once.
 *
 * Which pages are due is decided from the pages, not from the scan (SourcePage.newsHash = the hash of the text the
 * intake last read): a batch that failed leaves its pages due, and the next scan of the address takes them again.
 * Nothing is remembered anywhere else.
 *
 * Never news: the organization's own site; a company with no knowledge base yet (the set-up phase, and the first
 * scans of a company that was just added); pages from before the knowledge base was made; a jobs or events
 * address; careers, legal and localized pages.
 *
 * The text before a change: the scanner holds it on the page (previousText) only until the analysis has read the
 * change, then drops it. It is read here right when the scan ends, so it is normally there; when it is gone (a
 * batch that is retried after the analysis ran), the page is sent whole — the intake still finds only what the
 * list does not hold, at the cost of more text.
 *
 * Runs after the scan is recorded as ended, so a scan never waits for PMOS AI. Never throws.
 */

/** The intake's word for the kind of page, from the address it was found under and the map's word on the page. */
export function newsPageKind(sourceType: string, url: string, readAs: string | null): string {
  if (readAs === "release_notes" || sourceType === "changelog") return "release_notes";
  if (sourceType === "helpcenter") return "help";
  if (sourceType === "apidocs" || sourceType === "code") return "api_docs";
  if (sourceType === "blog") return "blog";
  if (sourceType === "press") return "news";
  const path = url.toLowerCase().replace(/^https?:\/\/[^/]+/, "");
  if (/changelog|release-notes|releasenotes|whats-new|product-updates/.test(path)) return "release_notes";
  if (/\/pricing\b|\/plans\b/.test(path)) return "pricing";
  if (/press-release|\/press\b|\/news\b|newsroom/.test(path)) return "news";
  if (/\/blog\b/.test(path)) return "blog";
  return "product";
}

export interface DuePage {
  id: string;
  url: string;
  hash: string;
  newsHash: string | null;
  firstSeenAt: Date;
  changedAt: Date | null;
}

/**
 * Is a page due for the intake? Its current text was not read by the intake, and it appeared or changed after the
 * knowledge base was made. `status`: "new" = it appeared after (sent whole); "changed" = it was there before. Pure.
 */
export function dueStatus(page: DuePage, readyAt: Date): "new" | "changed" | null {
  if (page.newsHash === page.hash) return null;
  if (folderSkip(page.url)) return null;
  if (page.firstSeenAt.getTime() > readyAt.getTime()) return page.newsHash === null ? "new" : "changed";
  if (page.changedAt && page.changedAt.getTime() > readyAt.getTime()) return "changed";
  return null;
}

export interface NewsAfterScan {
  /** Why nothing was read, or null when a batch ran. */
  skipped: string | null;
  pages: number;
  new: number;
  covered: number;
  other: number;
  failedPages: number;
  emailed: boolean;
}

const none = (skipped: string): NewsAfterScan => ({ skipped, pages: 0, new: 0, covered: 0, other: 0, failedPages: 0, emailed: false });

/** `byHand`: asked for by a person (the knowledge command) — it runs also while the PMOS AI step is switched off by the test knob, as a hand-started analysis does (analysis/gate.ts). */
export async function newsAfterScan(scanId: string, opts: { byHand?: boolean } = {}): Promise<NewsAfterScan> {
  try {
    const scan = await db.competitorScan.findUnique({
      where: { id: scanId },
      select: { status: true, workspaceId: true, source: { select: { id: true, type: true, competitor: { select: { id: true, name: true, isOwn: true, deletedAt: true, knowledgeReadyAt: true } } } } },
    });
    if (!scan) return none("no such scan");
    const company = scan.source.competitor;
    if (company.isOwn) return none("the organization's own site is never news");
    if (company.deletedAt) return none("the company was removed");
    if (!company.knowledgeReadyAt) return none("the company has no knowledge base yet");
    if (scan.status !== "ok" && scan.status !== "partial") return none(`the scan ended ${scan.status}`);
    if (sourceSkip(scan.source.type)) return none(`a ${scan.source.type} address is never read`);
    if (!opts.byHand && !aiStepEnabled()) return none("PMOS AI is switched off (COMPETITORS_AI=off, test knob)");
    if ((await getGlobalScanSettings()).analysisDisabled) return none("analysis is disabled in Administration");

    const readyAt = company.knowledgeReadyAt;
    const candidates = await db.sourcePage.findMany({
      where: { sourceId: scan.source.id, state: { in: ["present", "unlinked"] }, text: { not: null }, OR: [{ firstSeenAt: { gt: readyAt } }, { changedAt: { gt: readyAt } }] },
      // By address, so pages that sit together on the site go to PMOS AI together.
      orderBy: { url: "asc" },
      select: { id: true, url: true, hash: true, newsHash: true, firstSeenAt: true, changedAt: true },
    });
    const due = candidates.map((p) => ({ page: p, status: dueStatus(p, readyAt) })).filter((d): d is { page: DuePage; status: "new" | "changed" } => d.status !== null);
    if (due.length === 0) return none("no page is new or changed since the knowledge base was made");
    // Every due page goes: how much one request holds is the intake's business (the reading's limit, intake.ts planRequests).
    const taken = due;

    const list = await loadKnowledgeList(company.id);
    if (list.features.length === 0) return none("the company's knowledge base is empty");
    const texts = await db.sourcePage.findMany({ where: { id: { in: taken.map((d) => d.page.id) } }, select: { id: true, url: true, title: true, text: true, previousText: true, readAs: true, hash: true } });
    const byId = new Map(texts.map((t) => [t.id, t]));
    const pages: Array<NewsPage & { id: string; hash: string }> = [];
    for (const d of taken) {
      const t = byId.get(d.page.id);
      if (!t?.text) continue;
      pages.push({
        id: t.id,
        hash: t.hash,
        url: t.url,
        title: t.title ?? "",
        kind: newsPageKind(scan.source.type, t.url, t.readAs),
        publishedAt: null,
        text: t.text,
        // A changed page whose earlier text is gone is sent whole (see the header).
        previousText: d.status === "changed" ? t.previousText : null,
      });
    }

    const batch = await intakeBatch({ id: company.id, workspaceId: scan.workspaceId, name: company.name }, pages, { simulated: false, list });
    // A page is read when its request came back and reported it, or when it held nothing new to send.
    const failed = new Set<NewsPage>(batch.requests.flatMap((r) => (r.error ? r.pages.map((p) => p.page) : r.unanswered.map((p) => p.page))));
    const read = pages.filter((p) => !failed.has(p));
    for (const p of read) await db.sourcePage.updateMany({ where: { id: p.id, hash: p.hash }, data: { newsHash: p.hash } });

    await addNewAbilities(batch.batchId);
    const all = batch.requests.flatMap((r) => r.pieces);
    let emailed = false;
    try {
      emailed = (await notifyNewsBatch(batch.batchId)).sent;
    } catch (e) {
      console.error("[competitors] news: the notification could not be sent", e instanceof Error ? e.message : e);
    }
    return {
      skipped: null,
      pages: pages.length,
      new: all.filter((p) => p.verdict === "new").length,
      covered: all.filter((p) => p.verdict === "covered").length,
      other: all.filter((p) => p.verdict === "other").length,
      failedPages: batch.failedPages,
      emailed,
    };
  } catch (e) {
    console.error("[competitors] news after scan failed", scanId, e instanceof Error ? e.message : e);
    return none(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
