import type { Prisma } from "@prisma/client";
import { db } from "../db";
import type { PageText } from "./ai";
import { REMOVED_AFTER_NOT_FOUND, type OutcomeCategory, type PageKind, type PageState } from "./config";
import { contentHash, htmlToText, titleOf } from "./html";
import { pageKey } from "./url";

/**
 * The page store of the Website Scanning story (PRD 2026-11-04). ONE writer
 * for both lanes: the remote crawler and the local hand-in route call
 * recordPage() with what they got (raw HTML, or text for PDFs and handed-in
 * pages), and the server extracts the text, normalizes, hashes and decides
 * new / changed / unchanged / not read. Hashes are therefore comparable
 * across lanes and fetch modes.
 *
 *   SourcePage — one row per URL of a source while the competitor is tracked:
 *                hash, title, state (present / missing / removed / unlinked),
 *                the current text. No retention (Daniel 2026-11-04): a change
 *                replaces the text; the previous text is held only until the
 *                analysis of that change has run (releasePreviousTexts), so the
 *                change insight can be computed, then dropped.
 *
 * Page states: a 404/410 (or a not-found page in the local lane) marks the
 * page "missing" once and "removed" on the second consecutive one; a page
 * that answers again clears the mark. Timeouts and blocks count for nothing.
 * "unlinked" = still answers but nothing points at it any more, decided only
 * after a Full scan.
 */

/** What a lane says about one page it tried to read. */
/** "unreadable" = PM-OS itself could not read a file it fetched (a broken or oversize PDF): our failure, not the site's — logged as an error. */
export type PageReadStatus = "ok" | "notfound" | "blocked" | "login" | "timeout" | "slowdown" | "robots" | "other" | "unreadable";

export interface RecordPageInput {
  scanId: string;
  sourceId: string;
  workspaceId: string;
  url: string;
  /** The source's website address: http/https and www/bare copies of its host are one page (pageKey). */
  siteUrl?: string | null;
  status: PageReadStatus;
  /** Raw HTML (the server extracts the text). */
  html?: string | null;
  /** Text when there is no HTML: a PDF's text, a handed-in page text. */
  text?: string | null;
  title?: string | null;
  kind?: PageKind;
  /** "home" | "sitemap" | "link" | "known" | "handin" */
  via?: string;
  httpStatus?: number;
  ms?: number;
  errorDetail?: string | null;
}

export type PageOutcome = "new" | "changed" | "unchanged" | "failed";

export interface RecordPageResult {
  url: string;
  outcome: PageOutcome;
  /** For not-read pages: the user-facing reason. */
  category?: OutcomeCategory;
  pageId: string | null;
  state: PageState | null;
  /** The page as PMOS AI reads it (only when read). */
  pageText: PageText | null;
  chars: number;
  hash: string | null;
}

export function categoryOf(status: Exclude<PageReadStatus, "ok">): OutcomeCategory {
  switch (status) {
    case "notfound":
      return "notfound";
    case "blocked":
      return "denied";
    case "login":
      return "login";
    case "slowdown":
      return "slowdown";
    case "robots":
      return "robots";
    case "unreadable":
      return "unreadable";
    case "timeout":
    case "other":
    default:
      return "timeout";
  }
}

/** Longer texts (a 200-page PDF) are cut; the AI step truncates far below this anyway. */
export const MAX_PAGE_CHARS = 200_000;

/** Record what a lane read (or failed to read) for one URL. */
export async function recordPage(input: RecordPageInput, sourceLabel: string): Promise<RecordPageResult> {
  const key = pageKey(new URL(input.url), input.siteUrl);
  const now = new Date();
  const existing = await db.sourcePage.findUnique({ where: { sourceId_url: { sourceId: input.sourceId, url: key } } });

  if (input.status !== "ok") {
    const category = categoryOf(input.status);
    if (!existing) {
      // A URL we never read and cannot read now (a stale sitemap entry, say) is not a page of the site.
      return { url: key, outcome: "failed", category, pageId: null, state: null, pageText: null, chars: 0, hash: null };
    }
    if (input.status === "notfound") {
      const streak = existing.notFoundStreak + 1;
      const state: PageState = streak >= REMOVED_AFTER_NOT_FOUND ? "removed" : "missing";
      await db.sourcePage.update({
        where: { id: existing.id },
        data: { notFoundStreak: streak, state, lastAttemptScanId: input.scanId, removedAt: state === "removed" ? existing.removedAt ?? now : null },
      });
      return { url: key, outcome: "failed", category, pageId: existing.id, state, pageText: null, chars: 0, hash: existing.hash };
    }
    // Timeout, block, login, slow down: "not read", counts for nothing.
    await db.sourcePage.update({ where: { id: existing.id }, data: { lastAttemptScanId: input.scanId } });
    return { url: key, outcome: "failed", category, pageId: existing.id, state: existing.state as PageState, pageText: null, chars: 0, hash: existing.hash };
  }

  const rawText = (input.text ?? (input.html ? htmlToText(input.html) : "")).replace(/\r\n?/g, "\n").trim().slice(0, MAX_PAGE_CHARS);
  const title = (input.title ?? (input.html ? titleOf(input.html) : "")).trim().slice(0, 300) || null;
  const kind: PageKind = input.kind ?? "page";
  const hash = contentHash(rawText);
  const pageText: PageText = { url: key, title: title ?? "", text: rawText, kind, sourceLabel };

  if (!existing) {
    const created = await db.sourcePage.create({
      data: {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        url: key,
        title,
        kind,
        hash,
        text: rawText,
        chars: rawText.length,
        state: "present",
        notFoundStreak: 0,
        discoveredVia: input.via ?? "link",
        lastReadAt: now,
        lastReadScanId: input.scanId,
        lastAttemptScanId: input.scanId,
        lastLinkedScanId: input.via === "link" || input.via === "sitemap" ? input.scanId : null,
      },
      select: { id: true },
    });
    return { url: key, outcome: "new", pageId: created.id, state: "present", pageText, chars: rawText.length, hash };
  }

  const unchanged = existing.hash === hash;
  if (unchanged) {
    await db.sourcePage.update({
      where: { id: existing.id },
      data: {
        // A page removed by a website change keeps its hash but lost its text: same text again → put it back.
        ...(existing.text == null ? { text: rawText, chars: rawText.length } : {}),
        state: existing.state === "unlinked" ? "unlinked" : "present",
        notFoundStreak: 0,
        removedAt: null,
        title: title ?? existing.title,
        lastReadAt: now,
        lastReadScanId: input.scanId,
        lastAttemptScanId: input.scanId,
        ...(input.via === "link" || input.via === "sitemap" ? { lastLinkedScanId: input.scanId } : {}),
      },
    });
    return { url: key, outcome: "unchanged", pageId: existing.id, state: existing.state === "unlinked" ? "unlinked" : "present", pageText, chars: rawText.length, hash };
  }

  // Changed: the new text replaces the old one. The old text is held (previousText) until the analysis of this
  // change has run; the first unanalyzed previous text wins when the page changes again before that.
  await db.sourcePage.update({
    where: { id: existing.id },
    data: {
      hash,
      title,
      kind,
      text: rawText,
      chars: rawText.length,
      changedAt: now,
      previousText: existing.previousText ?? existing.text,
      previousHash: existing.previousHash ?? existing.hash,
      state: existing.state === "unlinked" ? "unlinked" : "present",
      notFoundStreak: 0,
      removedAt: null,
      lastReadAt: now,
      lastReadScanId: input.scanId,
      lastAttemptScanId: input.scanId,
      ...(input.via === "link" || input.via === "sitemap" ? { lastLinkedScanId: input.scanId } : {}),
    },
  });
  return { url: key, outcome: "changed", pageId: existing.id, state: existing.state === "unlinked" ? "unlinked" : "present", pageText, chars: rawText.length, hash };
}

/** The text a changed page had before its last unanalyzed change — for the change insight. */
export async function previousText(pageId: string): Promise<string | null> {
  const p = await db.sourcePage.findUnique({ where: { id: pageId }, select: { previousText: true } });
  return p?.previousText ?? null;
}

/** The handover is done: the analysis of this scan's changes ran, the previous texts are dropped (hashes stay). */
export async function releasePreviousTexts(sourceId: string, scanId: string): Promise<number> {
  const r = await db.sourcePage.updateMany({ where: { sourceId, lastReadScanId: scanId, previousText: { not: null } }, data: { previousText: null, previousHash: null } });
  return r.count;
}

export interface KnownPage {
  id: string;
  url: string;
  state: PageState;
  hash: string;
  lastAttemptScanId: string | null;
  lastReadScanId: string | null;
}

/** Every page the source has: seeds the frontier (known pages are re-read every scan) and the "removed" bookkeeping. */
export async function knownPages(sourceId: string): Promise<KnownPage[]> {
  const rows = await db.sourcePage.findMany({
    where: { sourceId },
    select: { id: true, url: true, state: true, hash: true, lastAttemptScanId: true, lastReadScanId: true },
    orderBy: { firstSeenAt: "asc" },
  });
  return rows.map((r) => ({ ...r, state: r.state as PageState }));
}

/** Mark the pages that something pointed at this scan (inbound link or sitemap entry). */
export async function markLinked(sourceId: string, scanId: string, urls: Iterable<string>): Promise<void> {
  const list = [...urls];
  for (let i = 0; i < list.length; i += 500) {
    await db.sourcePage.updateMany({ where: { sourceId, url: { in: list.slice(i, i + 500) } }, data: { lastLinkedScanId: scanId } });
  }
}

export interface PageStateSummary {
  missing: number;
  removed: number;
  unlinked: number;
  /** URLs that became "removed" in this scan (first 100). */
  removedUrls: string[];
}

/**
 * After a scan: pages that answered this scan but nothing linked to are
 * "unlinked" (only when the scan was Full — an Incomplete scan did not see
 * every link); pages linked again leave "unlinked". Returns the counts the
 * log and the analysis story read.
 */
export async function finalizePageStates(sourceId: string, scanId: string, full: boolean): Promise<PageStateSummary> {
  if (full) {
    await db.sourcePage.updateMany({
      where: { sourceId, lastReadScanId: scanId, state: "present", OR: [{ lastLinkedScanId: null }, { lastLinkedScanId: { not: scanId } }], discoveredVia: { not: "home" } },
      data: { state: "unlinked" },
    });
    await db.sourcePage.updateMany({ where: { sourceId, lastReadScanId: scanId, state: "unlinked", lastLinkedScanId: scanId }, data: { state: "present" } });
  }
  const [missing, removed, unlinked, removedNow] = await Promise.all([
    db.sourcePage.count({ where: { sourceId, state: "missing" } }),
    db.sourcePage.count({ where: { sourceId, state: "removed" } }),
    db.sourcePage.count({ where: { sourceId, state: "unlinked" } }),
    db.sourcePage.findMany({ where: { sourceId, state: "removed", lastAttemptScanId: scanId, notFoundStreak: REMOVED_AFTER_NOT_FOUND }, select: { url: true }, take: 100 }),
  ]);
  return { missing, removed, unlinked, removedUrls: removedNow.map((r) => r.url) };
}

/** The pages PMOS AI reads when nothing changed but the catalog grew: every current text of the source. */
export async function currentPageTexts(sourceId: string, sourceLabel: string): Promise<PageText[]> {
  const rows = await db.sourcePage.findMany({ where: { sourceId, state: { in: ["present", "unlinked"] }, text: { not: null } }, select: { url: true, title: true, text: true, kind: true } });
  return rows.map((r) => ({ url: r.url, title: r.title ?? "", text: r.text ?? "", kind: r.kind, sourceLabel }));
}

export type PageStateFilter = Prisma.SourcePageWhereInput;
