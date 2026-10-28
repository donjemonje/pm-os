import type { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  classifyCapabilities,
  extractFacts,
  factDateOf,
  type CatalogForAi,
  type PageText,
  type PreviousStatus,
} from "./ai";
import { recordCompetitorEvent } from "./analytics";
import {
  CRAWL_DELAY_CAP_MS,
  KEEP_TEXT_SCANS,
  SCAN_PAUSE_MS,
  SCAN_TIME_BUDGET_MS,
  type OutcomeCategory,
  type ScanBadge,
  type SourceType,
  type StatusValue,
} from "./config";
import { COMPETITORS_COPY as C } from "./copy";
import { getCompetitorsConfig } from "./store";
import { Frontier, readRobots, readSitemap } from "./crawl";
import { browserAvailable, closeBrowser, fetchPage, outcomeCategoryOf, sleep, type FetchErrorKind, type FetchMode, type FetchedPage } from "./fetcher";
import { contentHash, titleOf } from "./html";
import { checkPii } from "./pii";

/**
 * One scan of one source, end to end, in two halves:
 *
 *   collect — where the pages come from. The website source is crawled here
 *   under the scanner rules (robots, pause, page cap, time budget, bot-wall
 *   fallback). Every other source type has its pages handed in beforehand by
 *   a collector (lib/competitors/import.ts: an import, an upload, a later
 *   connector) and the collect half only reads them back and diffs them.
 *
 *   process — the same for every source: new/changed/unchanged against the
 *   previous scan → PMOS AI → statuses, suggestions, facts → fact liveness →
 *   text retention → badge and log.
 *
 * Runs inside the scanner job (Cloud Run) or in-process in local dev; both
 * call runScan(scanId).
 */

export type PageOutcome = "new" | "changed" | "unchanged" | "failed" | "skipped";
export interface PageLogEntry {
  url: string;
  status: number;
  outcome: PageOutcome;
  /** Why it failed or was skipped — one of the user-facing categories. */
  category?: OutcomeCategory;
  chars: number;
  ms: number;
  via: string;
  error?: string;
}
export interface LogLine {
  at: string;
  level: "info" | "warn" | "error";
  msg: string;
  url?: string;
}
export type OutcomeCounts = Partial<Record<OutcomeCategory, number>>;

const HEARTBEAT_EVERY = 5;

class ScanLog {
  readonly lines: LogLine[] = [];
  readonly pages: PageLogEntry[] = [];
  readonly outcomes: OutcomeCounts = {};
  private readonly scanId: string;
  constructor(scanId: string) {
    this.scanId = scanId;
  }
  add(level: LogLine["level"], msg: string, url?: string) {
    this.lines.push({ at: new Date().toISOString(), level, msg, ...(url ? { url } : {}) });
  }
  count(category: OutcomeCategory, n = 1) {
    this.outcomes[category] = (this.outcomes[category] ?? 0) + n;
  }
  async flush(extra: Prisma.CompetitorScanUpdateInput = {}) {
    await db.competitorScan.update({
      where: { id: this.scanId },
      data: {
        heartbeatAt: new Date(),
        log: this.lines as unknown as Prisma.InputJsonValue,
        pages: this.pages as unknown as Prisma.InputJsonValue,
        outcomes: this.outcomes as unknown as Prisma.InputJsonValue,
        pagesFetched: this.pages.filter((p) => p.outcome !== "skipped" && p.outcome !== "failed").length,
        pagesChanged: this.pages.filter((p) => p.outcome === "new" || p.outcome === "changed").length,
        ...extra,
      },
    });
  }
}

function errorKindOf(e: FetchErrorKind | undefined): string {
  return e ?? "other";
}

/** Create the Scan row for a source; the caller launches it. Refuses when a scan already runs in the workspace. */
export async function createScan(
  workspaceId: string,
  competitorId: string,
  trigger: "manual" | "scheduled",
  startedById: string | null,
  sourceType: SourceType = "website",
  /** A Scan run queues several scans at once: it checks for an active scan itself and passes its id here. */
  run: { runId: string } | null = null,
): Promise<{ scanId: string } | { error: "running" | "no_source" }> {
  if (!run) {
    const active = await db.competitorScan.findFirst({
      where: { workspaceId, status: { in: ["queued", "running"] } },
      select: { id: true },
    });
    if (active) return { error: "running" };
  }
  const source = await db.competitorSource.findFirst({ where: { workspaceId, competitorId, type: sourceType } });
  if (!source) return { error: "no_source" };
  const scan = await db.competitorScan.create({
    data: { workspaceId, sourceId: source.id, trigger, startedById, status: "queued", runId: run?.runId ?? null },
    select: { id: true },
  });
  await db.competitorSource.update({ where: { id: source.id }, data: { lastStatus: "running" } });
  await recordCompetitorEvent(workspaceId, startedById, "cmp_scan_started", { scanId: scan.id, competitorId, trigger });
  return { scanId: scan.id };
}

/** Manual scans of a source since local midnight — the per-day limit (PM-OS admins are exempt). */
export async function manualScansToday(sourceId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.competitorScan.count({ where: { sourceId, trigger: "manual", startedAt: { gte: start } } });
}

// ————— Collect —————

interface PreviousPage {
  hash: string;
  etag: string | null;
  lastModified: string | null;
  text: string | null;
}

interface CollectContext {
  scanId: string;
  source: { id: string; type: string; url: string };
  competitor: { id: string; name: string; host: string };
  sourceLabel: string;
  /** Previous pages of this source by URL (hash, validators, retained text). */
  prev: Map<string, PreviousPage>;
  log: ScanLog;
  t0: number;
  maxPages: number;
}

interface Collected {
  /** Pages read this scan (new, changed or unchanged). */
  count: number;
  changedPages: PageText[];
  /** Every page read this scan — re-classified when the catalog grew. */
  allPages: PageText[];
  seenUrls: Set<string>;
  homeFailed: boolean;
  capReached: boolean;
  budgetReached: boolean;
  mode: FetchMode | "bundle";
  errorKind: string | null;
  error: string | null;
  robotsDisallowed: string[];
}

/** The website: crawl under the scanner rules. */
async function collectWebsite(ctx: CollectContext): Promise<Collected> {
  const { scanId, source, competitor, log, prev, t0 } = ctx;
  const out: Collected = { count: 0, changedPages: [], allPages: [], seenUrls: new Set(), homeFailed: false, capReached: false, budgetReached: false, mode: "plain", errorKind: null, error: null, robotsDisallowed: [] };
  let mode: FetchMode = "plain";

  // ——— 1. Frontier: robots, sitemap, home ———
  const rules = await readRobots(source.url);
  const pauseMs = rules.crawlDelaySec ? Math.min(CRAWL_DELAY_CAP_MS, Math.max(SCAN_PAUSE_MS, rules.crawlDelaySec * 1000)) : SCAN_PAUSE_MS;
  log.add("info", `robots.txt: ${rules.disallow.length} disallow rule${rules.disallow.length === 1 ? "" : "s"}, ${rules.sitemaps.length} sitemap${rules.sitemaps.length === 1 ? "" : "s"}${rules.crawlDelaySec ? `, Crawl-delay ${rules.crawlDelaySec} s (pause ${pauseMs / 1000} s)` : ""}`);
  const frontier = new Frontier(competitor.host, rules);
  frontier.add(new URL(source.url), "home");
  const sitemapUrls = rules.sitemaps.length ? rules.sitemaps : [new URL("/sitemap.xml", source.url).href];
  const fromSitemap = await readSitemap(sitemapUrls, competitor.host);
  let added = 0;
  for (const u of fromSitemap) if (frontier.add(u, "sitemap")) added++;
  log.add("info", `sitemap: ${fromSitemap.length} URLs listed, ${added} inside the site and allowed`);

  // ——— 2. Fetch loop ———
  const fetched: FetchedPage[] = [];
  let attempts = 0;
  // Failed fetches (stale sitemap entries → 404) don't eat the page budget,
  // but attempts are capped so a broken site cannot loop.
  const maxAttempts = ctx.maxPages + 15;
  while (true) {
    if (out.count >= ctx.maxPages || attempts >= maxAttempts) {
      out.capReached = frontier.remaining > 0;
      break;
    }
    if (Date.now() - t0 > SCAN_TIME_BUDGET_MS) {
      out.budgetReached = true;
      break;
    }
    const cand = frontier.next();
    if (!cand) break;
    if (attempts > 0) await sleep(pauseMs);
    attempts++;
    const validators = mode === "plain" ? { etag: prev.get(cand.url)?.etag, lastModified: prev.get(cand.url)?.lastModified } : {};
    let page = await fetchPage(cand.url, mode, validators);

    // Bot wall or JS-only page → switch the whole site to browser mode, once.
    // (Open question 9: whether this fallback stays.)
    if (page.needsBrowser && mode === "plain") {
      if (browserAvailable()) {
        mode = "browser";
        out.mode = mode;
        log.add("warn", page.error === "botwall" ? "Bot protection answered the plain fetch — switching to the browser" : "Page has no text without JavaScript — switching to the browser", cand.url);
        page = await fetchPage(cand.url, mode);
      } else if (page.error === "botwall") {
        log.add("error", "Bot protection blocks the plain fetch and no browser is available in this environment", cand.url);
      }
    }

    if (page.notModified) {
      // 304: the previous text still stands — costs nothing, counts as a read page.
      const p = prev.get(cand.url);
      out.count++;
      out.seenUrls.add(cand.url);
      if (p?.text) out.allPages.push({ url: cand.url, title: "", text: p.text, sourceLabel: ctx.sourceLabel });
      log.pages.push({ url: cand.url, status: 304, outcome: "unchanged", chars: p?.text?.length ?? 0, ms: page.ms, via: cand.via });
      await db.scanPage.create({
        data: { scanId, sourceId: source.id, url: cand.url, contentHash: p?.hash ?? "", text: p?.text ?? null, chars: p?.text?.length ?? 0, etag: page.etag ?? p?.etag ?? null, lastModified: page.lastModified ?? p?.lastModified ?? null },
      });
      continue;
    }

    if (page.error) {
      const category = outcomeCategoryOf(page.error);
      log.count(category);
      log.pages.push({ url: cand.url, status: page.status, outcome: page.error === "noindex" ? "skipped" : "failed", category, chars: 0, ms: page.ms, via: cand.via, error: page.errorDetail ?? page.error });
      log.add("warn", `${page.error === "noindex" ? "Skipped" : "Failed"}: ${page.errorDetail ?? page.error}`, cand.url);
      if (cand.via === "home") {
        out.homeFailed = true;
        out.errorKind = errorKindOf(page.error);
        out.error = page.errorDetail ?? page.error;
        break;
      }
      continue;
    }

    out.count++;
    out.seenUrls.add(cand.url);
    const hash = contentHash(page.text);
    const before = prev.get(cand.url);
    const outcome: PageOutcome = before == null ? "new" : before.hash === hash ? "unchanged" : "changed";
    log.pages.push({ url: cand.url, status: page.status, outcome, chars: page.text.length, ms: page.ms, via: cand.via });
    fetched.push(page);
    const title = titleOf(page.html);
    await db.scanPage.create({
      data: { scanId, sourceId: source.id, url: cand.url, title: title || null, contentHash: hash, text: page.text, chars: page.text.length, etag: page.etag ?? null, lastModified: page.lastModified ?? null },
    });
    const pt: PageText = { url: cand.url, title, text: page.text, sourceLabel: ctx.sourceLabel };
    out.allPages.push(pt);
    if (outcome !== "unchanged") out.changedPages.push(pt);
    frontier.addLinksFrom(page.html, page.finalUrl);
    if (out.count % HEARTBEAT_EVERY === 0) await log.flush({ fetchMode: mode });
  }

  // Pages kept out before any request: robots.txt and the people-page policy.
  out.robotsDisallowed = frontier.robotsSkipped;
  if (frontier.robotsSkipped.length) {
    log.count("robots", frontier.robotsSkipped.length);
    log.add("info", `Blocked by robots.txt: ${frontier.robotsSkipped.length} path${frontier.robotsSkipped.length === 1 ? "" : "s"} (${frontier.robotsSkipped.slice(0, 5).join(", ")}${frontier.robotsSkipped.length > 5 ? ", …" : ""})`);
  }
  if (frontier.policySkipped.length) {
    log.count("policy", frontier.policySkipped.length);
    log.add("info", `Skipped by policy (people pages): ${frontier.policySkipped.length} (${frontier.policySkipped.slice(0, 5).join(", ")}${frontier.policySkipped.length > 5 ? ", …" : ""})`);
  }
  if (out.capReached) {
    log.count("cap", frontier.remaining);
    log.add("info", `Page limit reached (${ctx.maxPages}) — ${frontier.remaining} discovered pages not fetched`);
  }
  if (out.budgetReached) {
    log.count("cap", frontier.remaining + 1);
    log.add("warn", `Time budget reached (${Math.round(SCAN_TIME_BUDGET_MS / 60000)} min) — ${frontier.remaining + 1} discovered pages not fetched`);
  }
  out.mode = mode;
  return out;
}

/**
 * Pages handed in by a collector before the scan was launched (rows of this
 * scan already in ScanPage): read them back and diff against the previous
 * scan of the source. No fetching, so none of the politeness limits apply.
 */
async function collectBundle(ctx: CollectContext): Promise<Collected> {
  const { scanId, log, prev } = ctx;
  const out: Collected = { count: 0, changedPages: [], allPages: [], seenUrls: new Set(), homeFailed: false, capReached: false, budgetReached: false, mode: "bundle", errorKind: null, error: null, robotsDisallowed: [] };
  const rows = await db.scanPage.findMany({
    where: { scanId },
    orderBy: { fetchedAt: "asc" },
    select: { url: true, title: true, kind: true, contentHash: true, text: true, chars: true, observedAt: true },
  });
  log.add("info", `${rows.length} page${rows.length === 1 ? "" : "s"} handed in by the collector`);
  for (const r of rows) {
    if (!r.text) {
      log.pages.push({ url: r.url, status: 0, outcome: "skipped", chars: 0, ms: 0, via: "bundle", error: "empty" });
      continue;
    }
    out.count++;
    out.seenUrls.add(r.url);
    const before = prev.get(r.url);
    const outcome: PageOutcome = before == null ? "new" : before.hash === r.contentHash ? "unchanged" : "changed";
    log.pages.push({ url: r.url, status: 200, outcome, chars: r.chars, ms: 0, via: "bundle" });
    const pt: PageText = { url: r.url, title: r.title ?? "", text: r.text, kind: r.kind, sourceLabel: ctx.sourceLabel, observedAt: r.observedAt?.toISOString() ?? null };
    out.allPages.push(pt);
    if (outcome !== "unchanged") out.changedPages.push(pt);
  }
  if (out.count === 0) {
    out.errorKind = "other";
    out.error = "the collector handed in no page text";
  }
  return out;
}

// ————— Run —————

export async function runScan(scanId: string): Promise<void> {
  const scan = await db.competitorScan.findUnique({
    where: { id: scanId },
    include: { source: { include: { competitor: true } } },
  });
  if (!scan || (scan.status !== "queued" && scan.status !== "running")) return;
  const { source } = scan;
  const competitor = source.competitor;
  const workspaceId = scan.workspaceId;
  const log = new ScanLog(scanId);
  const t0 = Date.now();
  const config = await getCompetitorsConfig(workspaceId);
  const isWebsite = source.type === "website";
  // Pages handed in by a collector (importPages) are read back, whatever the source type; only a plain website scan crawls.
  const handedIn = scan.fetchMode === "bundle";
  const sourceLabel = C.profile.sourceTypes[source.type] ?? source.type;
  await db.competitorScan.update({ where: { id: scanId }, data: { status: "running", startedAt: new Date() } });
  log.add("info", !handedIn
    ? `Scan started (${scan.trigger}) for ${competitor.name} — ${source.url}, limit ${config.maxPagesPerScan} pages, budget ${Math.round(SCAN_TIME_BUDGET_MS / 60000)} min`
    : `Scan started (${scan.trigger}) for ${competitor.name} — ${sourceLabel} pages handed in by a collector`);

  let finalStatus: "ok" | "partial" | "failed" = "ok";
  let badge: ScanBadge = "full";
  let errorKind: string | null = null;
  let error: string | null = null;
  let mode: FetchMode | "bundle" = handedIn ? "bundle" : "plain";
  let aiCalls = 0;
  let statusesChanged = 0;
  let statusesSet = 0;
  let factsChanged = 0;
  let suggestions = 0;
  let piiHits = 0;
  let robotsDisallowed: string[] = [];
  let removedPages: string[] = [];

  try {
    // Previous pages of this source: hashes (changed vs unchanged), validators
    // (conditional requests) and the URL set (removed pages).
    // Only scans that finished (ok or partial) established anything: pages a failed or abandoned scan
    // stored never count as "seen", or the next scan would skip PMOS AI over pages it never processed.
    const previousPages = await db.scanPage.findMany({
      where: { sourceId: source.id, scanId: { not: scanId }, scan: { status: { in: ["ok", "partial"] } } },
      orderBy: { fetchedAt: "desc" },
      select: { url: true, contentHash: true, etag: true, lastModified: true, text: true, scanId: true },
    });
    const lastScanId = previousPages[0]?.scanId ?? null;
    const prev = new Map<string, PreviousPage>();
    for (const p of previousPages) if (!prev.has(p.url)) prev.set(p.url, { hash: p.contentHash, etag: p.etag, lastModified: p.lastModified, text: p.text });
    const lastScanUrls = new Set(previousPages.filter((p) => p.scanId === lastScanId).map((p) => p.url));
    const firstScan = prev.size === 0;

    const ctx: CollectContext = { scanId, source, competitor, sourceLabel, prev, log, t0, maxPages: config.maxPagesPerScan };
    const col = handedIn ? await collectBundle(ctx) : await collectWebsite(ctx);
    mode = col.mode;
    errorKind = col.errorKind;
    error = col.error;
    robotsDisallowed = col.robotsDisallowed;
    const { count, changedPages, allPages, seenUrls, homeFailed, capReached, budgetReached } = col;

    // Pages the last scan read that this one did not see — a removed pricing page is a signal.
    // Only a crawl can assert removal: a collector's hand-in brings what it found, not the whole site.
    if (!homeFailed && lastScanUrls.size && mode !== "bundle") {
      const failedNow = new Set(log.pages.filter((p) => p.outcome === "failed").map((p) => p.url));
      removedPages = [...lastScanUrls].filter((u) => !seenUrls.has(u) && (failedNow.has(u) || !capReached && !budgetReached)).slice(0, 100);
      if (removedPages.length) log.add("info", `Removed since the last scan: ${removedPages.length} page${removedPages.length === 1 ? "" : "s"} (${removedPages.slice(0, 3).map((u) => u.replace(/^https?:\/\/[^/]+/, "")).join(", ")}${removedPages.length > 3 ? ", …" : ""})`);
    }
    log.add("info", `${handedIn ? "Read" : "Fetched"} ${count} pages${!handedIn ? ` via ${mode}` : ""}: ${changedPages.length} new or changed, ${count - changedPages.length} unchanged, ${log.pages.filter((p) => p.outcome === "failed").length} failed`);
    await log.flush({ fetchMode: mode, robotsDisallowed: robotsDisallowed as unknown as Prisma.InputJsonValue, removedPages: removedPages as unknown as Prisma.InputJsonValue });

    if (homeFailed) {
      finalStatus = "failed";
      log.add("error", `The home page could not be read — scan failed (${error})`);
    } else if (count === 0) {
      finalStatus = "failed";
      errorKind = errorKind ?? "other";
      error = error ?? "no page could be read";
    } else if (changedPages.length === 0 && (await unclassifiedCapabilities(workspaceId, competitor.id)) === 0) {
      log.add("info", "Nothing changed since the last scan — PMOS AI not called");
      await markFactsSeen(competitor.id, scanId, seenUrls, removedPages, log);
    } else {
      // ——— PMOS AI ———
      // Nothing changed but the catalog grew: classify the new capabilities
      // from the stored pages (that is what the text retention is for).
      const catalogGrew = changedPages.length === 0;
      if (catalogGrew) log.add("info", `No page changed, but ${await unclassifiedCapabilities(workspaceId, competitor.id)} capabilities have no status yet — classifying from the ${allPages.length} stored pages`);
      const r = await aiStep(workspaceId, competitor.id, competitor.name, scanId, sourceLabel, catalogGrew ? allPages : changedPages, firstScan, log, { facts: !catalogGrew });
      aiCalls = r.aiCalls;
      statusesChanged = r.statusesChanged;
      statusesSet = r.statusesSet;
      factsChanged = r.factsChanged;
      suggestions = r.suggestions;
      piiHits = r.piiHits;
      if (r.failed) {
        finalStatus = "partial";
        errorKind = "ai";
        error = r.failed;
      }
      await markFactsSeen(competitor.id, scanId, seenUrls, removedPages, log);
    }

    // ——— Prune page texts older than the last KEEP_TEXT_SCANS scans ———
    const keep = await db.competitorScan.findMany({
      where: { sourceId: source.id, status: { in: ["ok", "partial", "running"] } },
      orderBy: { startedAt: "desc" },
      take: KEEP_TEXT_SCANS,
      select: { id: true },
    });
    const pruned = await db.scanPage.updateMany({
      where: { sourceId: source.id, scanId: { notIn: keep.map((k) => k.id) }, text: { not: null } },
      data: { text: null },
    });
    if (pruned.count) log.add("info", `Page-text cleanup: ${pruned.count} older page text${pruned.count === 1 ? "" : "s"} dropped (hashes kept)`);

    // ——— Badge ———
    const denied = (log.outcomes.denied ?? 0) + (log.outcomes.login ?? 0);
    if (homeFailed) {
      badge = errorKind === "botwall" || errorKind === "http4xx" || errorKind === "login" ? "blocked" : "unreachable";
    } else if (count === 0) {
      badge = "unreachable";
    } else if (denied > 0 && denied >= count) {
      badge = "blocked";
    } else if (capReached || budgetReached || finalStatus === "partial" || log.pages.some((p) => p.outcome === "failed") || robotsDisallowed.length > 0) {
      badge = "incomplete";
    } else {
      badge = "full";
    }
  } catch (e) {
    finalStatus = "failed";
    badge = "unreachable";
    errorKind = errorKind ?? "other";
    error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    log.add("error", `Scan aborted: ${error}`);
  } finally {
    await closeBrowser().catch(() => undefined);
  }

  const durationMs = Date.now() - t0;
  log.add("info", `Scan ${finalStatus} (${badge}) in ${Math.round(durationMs / 1000)} s · ${aiCalls} AI call${aiCalls === 1 ? "" : "s"} · ${statusesChanged} status change${statusesChanged === 1 ? "" : "s"}${statusesSet ? ` · ${statusesSet} cell${statusesSet === 1 ? "" : "s"} with first evidence` : ""} · ${factsChanged} fact change${factsChanged === 1 ? "" : "s"} · ${suggestions} suggestion${suggestions === 1 ? "" : "s"}${piiHits ? ` · ${piiHits} PII hit${piiHits === 1 ? "" : "s"} dropped` : ""}`);
  await log.flush({
    status: finalStatus,
    badge,
    finishedAt: new Date(),
    fetchMode: mode,
    aiCalls,
    statusesChanged,
    factsChanged,
    suggestions,
    piiHits,
    errorKind: errorKind ?? "none",
    error,
    robotsDisallowed: robotsDisallowed as unknown as Prisma.InputJsonValue,
    removedPages: removedPages as unknown as Prisma.InputJsonValue,
  });
  await db.competitorSource.update({
    where: { id: source.id },
    data: { lastScanAt: new Date(), lastStatus: finalStatus, lastError: finalStatus === "ok" ? null : error },
  });
  await recordCompetitorEvent(workspaceId, scan.startedById, "cmp_scan_finished", {
    scanId,
    competitorId: competitor.id,
    sourceType: source.type,
    status: finalStatus,
    badge,
    pagesFetched: log.pages.filter((p) => p.outcome !== "skipped" && p.outcome !== "failed").length,
    pagesChanged: log.pages.filter((p) => p.outcome === "new" || p.outcome === "changed").length,
    statusesChanged,
    factsChanged,
    suggestions,
    piiHits,
    durationMs,
    errorKind: errorKind ?? "none",
  });
}

/**
 * Facts whose source page was read in this scan are "seen"; facts whose page
 * failed or disappeared become "source no longer reachable" (cleared when
 * seen again). Staleness (3 scans unseen) is derived at read time, per source.
 */
async function markFactsSeen(competitorId: string, scanId: string, seenUrls: Set<string>, removedPages: string[], log: ScanLog): Promise<void> {
  const facts = await db.profileFact.findMany({ where: { competitorId, manual: false, dismissedAt: null }, select: { id: true, sourceUrl: true, unreachableAt: true } });
  const removed = new Set(removedPages);
  const failed = new Set(log.pages.filter((p) => p.outcome === "failed").map((p) => p.url));
  let gone = 0;
  for (const f of facts) {
    const url = f.sourceUrl ? f.sourceUrl.replace(/[?#].*$/, "").replace(/\/+$/, "") : null;
    if (url && seenUrls.has(url)) {
      await db.profileFact.update({ where: { id: f.id }, data: { lastSeenScanId: scanId, unreachableAt: null } });
    } else if (url && (removed.has(url) || failed.has(url)) && !f.unreachableAt) {
      await db.profileFact.update({ where: { id: f.id }, data: { unreachableAt: new Date() } });
      gone++;
    }
  }
  if (gone) log.add("info", `${gone} fact${gone === 1 ? "" : "s"} marked "source no longer reachable"`);
}

// ————— AI step —————

interface AiStepResult {
  aiCalls: number;
  /** Cells that got their first value this scan (no previous value to compare with). */
  statusesSet: number;
  statusesChanged: number;
  factsChanged: number;
  suggestions: number;
  piiHits: number;
  failed: string | null;
}

async function loadCatalog(workspaceId: string): Promise<{ forAi: CatalogForAi; byName: Map<string, { id: string; domainId: string }>; domainIdByName: Map<string, string> }> {
  // Only the catalog the team accepted: suggested or dismissed domains are not classified against.
  const domains = await db.competitorDomain.findMany({
    where: { workspaceId, state: "active" },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    include: { capabilities: { where: { state: "active" }, orderBy: [{ position: "asc" }, { name: "asc" }] } },
  });
  const byName = new Map<string, { id: string; domainId: string }>();
  const domainIdByName = new Map<string, string>();
  for (const d of domains) {
    domainIdByName.set(d.name, d.id);
    for (const k of d.capabilities) byName.set(k.name, { id: k.id, domainId: d.id });
  }
  return {
    forAi: {
      domains: domains
        .filter((d) => d.capabilities.length > 0)
        .map((d) => ({ name: d.name, description: d.description, capabilities: d.capabilities.map((k) => ({ name: k.name, description: k.description })) })),
    },
    byName,
    domainIdByName,
  };
}

/** Active capabilities with no status row yet for this competitor (added since its last classification). */
async function unclassifiedCapabilities(workspaceId: string, competitorId: string): Promise<number> {
  return db.capability.count({ where: { workspaceId, state: "active", statuses: { none: { competitorId } } } });
}

async function aiStep(
  workspaceId: string,
  competitorId: string,
  competitorName: string,
  scanId: string,
  sourceLabel: string,
  pages: PageText[],
  firstScan: boolean,
  log: ScanLog,
  opts: { facts: boolean } = { facts: true },
): Promise<AiStepResult> {
  const res: AiStepResult = { aiCalls: 0, statusesSet: 0, statusesChanged: 0, factsChanged: 0, suggestions: 0, piiHits: 0, failed: null };
  /** Rule 6: a snippet that names a person is dropped, never stored. */
  const clean = (text: string | null | undefined, what: string, url?: string): string | null => {
    const r = checkPii(text);
    if (!r.hit) return text || null;
    res.piiHits++;
    log.add("warn", `PII check dropped a ${what} (${r.kind})`, url);
    return null;
  };
  const progress = (what: string) => async (done: number, total: number) => {
    if (total > 1) {
      log.add("info", `${what}: part ${done} of ${total} done`);
      await log.flush();
    }
  };
  try {
    const catalog = await loadCatalog(workspaceId);

    if (catalog.byName.size === 0) {
      log.add("warn", "The capability catalog is empty — add domains and capabilities in Settings → Competitors; this scan only collects profile facts");
    } else {
      // Statuses
      const prevRows = await db.capabilityStatus.findMany({ where: { competitorId }, include: { capability: { select: { name: true } } } });
      const previous: PreviousStatus[] = prevRows.map((p) => ({ capability: p.capability.name, value: p.value as StatusValue, confidence: p.confidence }));
      // Which source set each previous value: a source may lower only what it
      // set itself. Absence in a datasheet is not evidence that the website
      // stopped offering a capability — but the website's next scan may say so.
      const prevScanIds = [...new Set(prevRows.map((p) => p.scanId).filter((id): id is string => Boolean(id)))];
      const sourceOfScan = new Map((await db.competitorScan.findMany({ where: { id: { in: prevScanIds } }, select: { id: true, sourceId: true } })).map((s) => [s.id, s.sourceId]));
      const thisSourceId = (await db.competitorScan.findUnique({ where: { id: scanId }, select: { sourceId: true } }))?.sourceId ?? null;
      const RANK: Record<StatusValue, number> = { has: 3, partial: 2, missing: 1, unknown: 0 };
      log.add("info", `Classifying ${catalog.byName.size} capabilities from ${pages.length} ${firstScan ? "" : "changed "}pages`);
      const pendingSuggestions = (await db.capability.findMany({ where: { workspaceId, origin: "ai", state: "suggested" }, select: { name: true } })).map((c) => c.name);
      const cls = await classifyCapabilities(competitorName, catalog.forAi, previous, pendingSuggestions, pages, (d, t) => void progress("Classification")(d, t));
      res.aiCalls += cls.calls;
      const now = new Date();
      const prevByCap = new Map(prevRows.map((p) => [p.capabilityId, p]));
      const answered = new Map(cls.value.statuses.map((s) => [s.capability, s]));
      for (const [name, cap] of catalog.byName) {
        const prev = prevByCap.get(cap.id);
        const ans = answered.get(name);
        // No evidence in the changed pages: keep what earlier pages established.
        let value: StatusValue = ans?.value ?? "unknown";
        let confidence = ans?.confidence ?? null;
        let quote = clean(ans?.quote, "status quote", ans?.url);
        let sourceUrl = ans?.url || null;
        let product = ans?.product || null;
        const prevSource = prev?.scanId ? sourceOfScan.get(prev.scanId) ?? null : null;
        const otherSourceLowers = Boolean(prev && prev.value !== "unknown" && RANK[value] < RANK[prev.value as StatusValue] && prevSource && prevSource !== thisSourceId);
        if ((value === "unknown" || otherSourceLowers) && prev && prev.value !== "unknown") {
          value = prev.value as StatusValue;
          confidence = prev.confidence;
          quote = prev.quote;
          sourceUrl = prev.sourceUrl;
          product = prev.product;
        }
        if (!prev) {
          // First status for this cell: nothing to compare with, so it is not a "change".
          await db.capabilityStatus.create({
            data: { workspaceId, competitorId, capabilityId: cap.id, value, confidence, quote, sourceUrl, product, scanId, changedAt: null },
          });
          res.statusesSet++;
        } else if (prev.value === "unknown" && value !== "unknown") {
          // First evidence for a cell that had none: discovery, not a change.
          await db.capabilityStatus.update({ where: { id: prev.id }, data: { value, confidence, quote, sourceUrl, product, scanId } });
          res.statusesSet++;
          log.add("info", `${name}: first evidence — ${value}`, sourceUrl ?? undefined);
        } else if (prev.value !== value) {
          await db.statusHistory.create({ data: { statusId: prev.id, value: prev.value, quote: prev.quote, sourceUrl: prev.sourceUrl, scanId: prev.scanId } });
          await db.capabilityStatus.update({ where: { id: prev.id }, data: { value, confidence, quote, sourceUrl, product: product ?? prev.product, scanId, changedAt: now } });
          res.statusesChanged++;
          log.add("info", `${name}: ${prev.value} → ${value}`, sourceUrl ?? undefined);
        } else if (quote && quote !== prev.quote && (!prev.quote || (confidence ?? 0) > (prev.confidence ?? 0))) {
          // Same value: the evidence moves to a later source only when it is more confident.
          await db.capabilityStatus.update({ where: { id: prev.id }, data: { confidence, quote, sourceUrl, product: product ?? prev.product, scanId } });
        } else if (product && !prev.product) {
          await db.capabilityStatus.update({ where: { id: prev.id }, data: { product } });
        }
      }
      // Suggestions
      for (const s of cls.value.suggestions) {
        let domainId = catalog.domainIdByName.get(s.domain);
        let newDomain = false;
        if (!domainId) {
          // No catalog domain fits: the domain itself is suggested (a dashed group in the matrix).
          // A domain the team dismissed is never proposed again; one awaiting review is reused.
          const sameName = await db.competitorDomain.findFirst({ where: { workspaceId, name: { equals: s.domain, mode: "insensitive" } }, select: { id: true, state: true } });
          if (sameName?.state === "dismissed") {
            log.add("info", `Suggestion skipped: ${s.name} — its domain "${s.domain}" was dismissed earlier`, s.url || undefined);
            continue;
          }
          if (sameName) {
            domainId = sameName.id;
          } else if (s.domain) {
            const created = await db.competitorDomain.create({
              data: { workspaceId, name: s.domain, description: clean(s.newDomain?.description, "domain definition", s.url) ?? "", position: 9999, origin: "ai", state: "suggested", suggestedById: competitorId },
              select: { id: true },
            });
            domainId = created.id;
            newDomain = true;
            catalog.domainIdByName.set(s.domain, created.id);
            log.add("info", `Suggested new domain: ${s.domain}`, s.url || undefined);
          } else {
            continue;
          }
        }
        const exists = await db.capability.findFirst({ where: { workspaceId, name: { equals: s.name, mode: "insensitive" } }, select: { id: true } });
        if (exists) continue;
        const quote = clean(s.quote, "suggestion quote", s.url);
        // A capability a competitor has and the catalog lacks: if accepted it is a gap by default.
        await db.capability.create({
          data: { workspaceId, domainId, name: s.name, position: 9999, origin: "ai", state: "suggested", ourStatus: "missing", suggestedById: competitorId, suggestedQuote: quote ? `${quote} — ${s.url}` : null },
        });
        res.suggestions++;
        log.add("info", `Suggested new capability: ${s.name} (${s.domain}${newDomain ? ", new domain" : ""})`, s.url || undefined);
      }
    }

    // Facts (only from changed pages — a catalog-only re-run reads nothing new about the company)
    if (opts.facts) {
      const knownFacts = await db.profileFact.findMany({ where: { competitorId, dismissedAt: null }, select: { kind: true, value: true }, orderBy: { createdAt: "asc" } });
      const ext = await extractFacts(competitorName, knownFacts, pages, (d, t) => void progress("Facts")(d, t));
      res.aiCalls += ext.calls;
      const now = new Date();
      for (const f of ext.value) {
        if (!clean(f.value, `${f.kind} fact`, f.url)) continue;
        const factDate = factDateOf(f.date);
        const existing = await db.profileFact.findUnique({ where: { competitorId_kind_value: { competitorId, kind: f.kind, value: f.value } } });
        if (existing) {
          await db.profileFact.update({
            where: { id: existing.id },
            data: { lastSeenScanId: scanId, unreachableAt: null, ...(existing.sourceUrl ? {} : { sourceUrl: f.url || null, sourceLabel }), ...(existing.factDate || !factDate ? {} : { factDate }) },
          });
          continue;
        }
        // A source's first scan sets the baseline; only later finds are "changes".
        await db.profileFact.create({ data: { workspaceId, competitorId, kind: f.kind, value: f.value, sourceUrl: f.url || null, sourceLabel, factDate, scanId, lastSeenScanId: scanId, changedAt: firstScan ? null : now } });
        res.factsChanged++;
      }
      log.add("info", `Facts: ${ext.value.length} found, ${res.factsChanged} new`);
    }
  } catch (e) {
    res.failed = e instanceof Error ? e.message.slice(0, 300) : String(e);
    log.add("error", `PMOS AI step failed: ${res.failed}`);
  }
  return res;
}
