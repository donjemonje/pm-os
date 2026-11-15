import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { queueAnalysis } from "./analysis/engine";
import { recordCompetitorEvent } from "./analytics";
import {
  ACTIVE_SCAN_STATUSES,
  CRAWL_DELAY_CAP_MS,
  HEARTBEAT_MS,
  PAGE_RETRIES,
  scanPauseMs,
  type OutcomeCategory,
  type PageKind,
  type ScanBadge,
  type ScanLane,
  type SourceType,
} from "./config";
import { COMPETITORS_COPY as C } from "./copy";
import { Frontier, readRobots, readSitemap } from "./crawl";
import { acquireBrowser, browserAvailable, fetchPage, isRetryable, outcomeCategoryOf, releaseBrowser, sleep, type FetchErrorKind, type FetchMode, type FetchedPage } from "./fetcher";
import { createLocalRequest, finishLocalRequest, hasActiveScannerKey } from "./local";
import { finalizePageStates, knownPages, markLinked, recordPage, type PageOutcome as StoreOutcome, type PageReadStatus, type RecordPageResult } from "./pages";
import { getGlobalScanSettings, now, scanTimeLimitMs, storageFull, storageLimitChars } from "./settings";
import { isPdfUrl, pageKey, sourceSiteHost } from "./url";

/**
 * One scan of one source, in two halves (Website Scanning PRD 2026-11-04).
 * A scan ENDS when the pages are stored. What the pages say — capabilities,
 * features, the table's cells, the profile facts — is read by the analysis:
 * its own queued run after the scan (analysis/engine.ts), queued here at the
 * end of every scan that read at least one page.
 *
 *   collect — where the pages come from.
 *     remote  the crawler reads the whole site: known pages of earlier scans
 *             first (a stale scan's pending pages before everything), then the
 *             home page, the sitemap and every link found; robots.txt, the
 *             pause, the ceiling (2,000 pages / 3 h) and "stop on 429" apply.
 *             Nothing is trusted as unchanged: every page is fetched and hashed.
 *     local   a PM's browser read the pages and posted them to the hand-in
 *             route, which stored them with recordPage() as they arrived; here
 *             the scan only reads back what the route logged.
 *     bundle  a collector handed pages in before the scan (import.ts).
 *
 *   process — the same for every lane: page states (missing / removed /
 *             unlinked) → fact liveness (which facts' pages were seen) →
 *             queue the analysis run → badge and log. No PMOS AI call here.
 *
 * Runs inside the scanner job (Cloud Run) or in-process in local dev; both
 * call runScan(scanId). The local lane's "done" call runs it too.
 */

export type PageOutcome = StoreOutcome | "skipped";
export interface PageLogEntry {
  url: string;
  status: number;
  outcome: PageOutcome;
  /** Why it failed — one of the user-facing categories. */
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

const FLUSH_EVERY = 5;

export class ScanLog {
  readonly lines: LogLine[] = [];
  readonly pages: PageLogEntry[] = [];
  readonly outcomes: OutcomeCounts = {};
  notAttempted = 0;
  private readonly scanId: string;
  constructor(scanId: string, initial?: { lines?: LogLine[]; pages?: PageLogEntry[]; outcomes?: OutcomeCounts }) {
    this.scanId = scanId;
    if (initial?.lines) this.lines.push(...initial.lines);
    if (initial?.pages) this.pages.push(...initial.pages);
    if (initial?.outcomes) Object.assign(this.outcomes, initial.outcomes);
  }
  add(level: LogLine["level"], msg: string, url?: string) {
    this.lines.push({ at: new Date().toISOString(), level, msg, ...(url ? { url } : {}) });
  }
  count(category: OutcomeCategory, n = 1) {
    this.outcomes[category] = (this.outcomes[category] ?? 0) + n;
  }
  get read(): number {
    return this.pages.filter((p) => p.outcome === "new" || p.outcome === "changed" || p.outcome === "unchanged").length;
  }
  get changed(): number {
    return this.pages.filter((p) => p.outcome === "new" || p.outcome === "changed").length;
  }
  get failedUrls(): Set<string> {
    return new Set(this.pages.filter((p) => p.outcome === "failed").map((p) => p.url));
  }
  async flush(extra: Prisma.CompetitorScanUpdateInput = {}) {
    await db.competitorScan.update({
      where: { id: this.scanId },
      data: {
        heartbeatAt: new Date(),
        log: this.lines as unknown as Prisma.InputJsonValue,
        pages: this.pages as unknown as Prisma.InputJsonValue,
        outcomes: this.outcomes as unknown as Prisma.InputJsonValue,
        pagesFetched: this.read,
        pagesChanged: this.changed,
        pagesNotAttempted: this.notAttempted,
        ...extra,
      },
    });
  }
}

/** Append one page the local lane posted: the route records the page and logs it here so the process half can read it back. */
export async function appendHandedInPage(scanId: string, entry: PageLogEntry, linked: Iterable<string> = [], lines: LogLine[] = []): Promise<void> {
  const scan = await db.competitorScan.findUniqueOrThrow({ where: { id: scanId }, select: { pages: true, linkedUrls: true, log: true } });
  const log = [...(Array.isArray(scan.log) ? (scan.log as unknown as LogLine[]) : []), ...lines];
  const all = Array.isArray(scan.pages) ? (scan.pages as unknown as PageLogEntry[]) : [];
  const earlier = all.find((p) => p.url === entry.url);
  const pages = all.filter((p) => p.url !== entry.url);
  // A station may hand the same page in twice within one scan; the second post reads "unchanged" against the first.
  // The site did not change in between — keep the first post's new/changed verdict.
  if (earlier && entry.outcome === "unchanged" && (earlier.outcome === "new" || earlier.outcome === "changed")) entry = { ...entry, outcome: earlier.outcome };
  pages.push(entry);
  const linkedUrls = new Set<string>(Array.isArray(scan.linkedUrls) ? (scan.linkedUrls as string[]) : []);
  for (const l of linked) linkedUrls.add(l);
  // Counted from the page list, which is deduped by URL — a page handed in twice is one page (Tomer's review 2026-11-10).
  const outcomes: OutcomeCounts = {};
  for (const p of pages) if (p.outcome === "failed" && p.category) outcomes[p.category] = (outcomes[p.category] ?? 0) + 1;
  await db.competitorScan.update({
    where: { id: scanId },
    data: {
      heartbeatAt: new Date(),
      pages: pages as unknown as Prisma.InputJsonValue,
      outcomes: outcomes as unknown as Prisma.InputJsonValue,
      linkedUrls: [...linkedUrls] as unknown as Prisma.InputJsonValue,
      ...(lines.length ? { log: log as unknown as Prisma.InputJsonValue } : {}),
      pagesFetched: pages.filter((p) => p.outcome === "new" || p.outcome === "changed" || p.outcome === "unchanged").length,
      pagesChanged: pages.filter((p) => p.outcome === "new" || p.outcome === "changed").length,
    },
  });
}

// ————— Creating scans —————

export type CreateScanResult =
  | { scanId: string; state: "queued" | "pending_local" | "started" | "no_station" }
  | { error: "no_source" | "removed" };

/**
 * Create a scan of a competitor's website and route it (PRD): the remote
 * lane when it is ON (started at once when a slot is free, else queued), the
 * local lane when OFF. A scan of a site that is already scanning is queued
 * behind the running one — never two scans on one site.
 *
 * `sourceId` names one source of the company — one of its other addresses
 * (a company may have several of one type; lib/competitors/addresses.ts).
 * Without it the scan is of the company's source of `sourceType`, its
 * oldest one. An address a PM removed is never scanned.
 */
export async function createAndRouteScan(
  workspaceId: string,
  competitorId: string,
  trigger: "manual" | "scheduled" | "onboarding",
  startedById: string | null,
  sourceType: SourceType = "website",
  sourceId: string | null = null,
): Promise<CreateScanResult> {
  const source = await db.competitorSource.findFirst({
    where: sourceId ? { id: sourceId, workspaceId, competitorId } : { workspaceId, competitorId, type: sourceType },
    orderBy: { createdAt: "asc" },
    include: { competitor: { select: { deletedAt: true } } },
  });
  if (!source || source.removedAt) return { error: "no_source" };
  if (source.competitor.deletedAt) return { error: "removed" };
  const t = await now();
  const active = await db.competitorScan.findFirst({ where: { sourceId: source.id, status: { in: [...ACTIVE_SCAN_STATUSES] } }, select: { id: true } });
  // One scan waits behind the running one, never a pile (no daily limit any more: repeated calls must not queue hours of reading).
  const queued = active ? await db.competitorScan.findFirst({ where: { sourceId: source.id, status: "queued", id: { not: active.id } }, select: { id: true } }) : null;
  if (queued) return { scanId: queued.id, state: "queued" };
  const scan = await db.competitorScan.create({
    data: { workspaceId, sourceId: source.id, trigger, startedById, status: "queued", startedAt: t, heartbeatAt: t },
    select: { id: true },
  });
  await recordCompetitorEvent(workspaceId, startedById, "cmp_scan_started", { scanId: scan.id, competitorId, trigger, sourceType: source.type });
  if (active) {
    // Behind the running scan of the same site; the finishing scan (or the tick) picks it up.
    return { scanId: scan.id, state: "queued" };
  }
  await db.competitorSource.update({ where: { id: source.id }, data: { lastStatus: "running" } });
  const { routeScan, startQueuedScans } = await import("./tick");
  const routed = await routeScan(scan.id);
  if (routed !== "queued") return { scanId: scan.id, state: routed };
  const { launchScan } = await import("./run");
  const started = await startQueuedScans(launchScan);
  return { scanId: scan.id, state: started > 0 ? "started" : "queued" };
}

/**
 * Compatibility entry for Scan runs (runs.ts): the row only; the run executes
 * it itself. Refuses when a scan of the source is active.
 */
export async function createScan(
  workspaceId: string,
  competitorId: string,
  trigger: "manual" | "scheduled",
  startedById: string | null,
  sourceType: SourceType = "website",
  run: { runId: string } | null = null,
): Promise<{ scanId: string } | { error: "running" | "no_source" }> {
  const source = await db.competitorSource.findFirst({ where: { workspaceId, competitorId, type: sourceType, competitor: { deletedAt: null } } });
  if (!source) return { error: "no_source" };
  const active = await db.competitorScan.findFirst({ where: { sourceId: source.id, status: { in: [...ACTIVE_SCAN_STATUSES] } }, select: { id: true } });
  if (active) return { error: "running" };
  const t = await now();
  const scan = await db.competitorScan.create({
    data: { workspaceId, sourceId: source.id, trigger, startedById, status: "queued", runId: run?.runId ?? null, startedAt: t, heartbeatAt: t },
    select: { id: true },
  });
  await db.competitorSource.update({ where: { id: source.id }, data: { lastStatus: "running" } });
  await recordCompetitorEvent(workspaceId, startedById, "cmp_scan_started", { scanId: scan.id, competitorId, trigger });
  return { scanId: scan.id };
}

// ————— Collect —————

interface CollectContext {
  scanId: string;
  workspaceId: string;
  source: { id: string; type: string; url: string };
  competitor: { id: string; name: string; host: string };
  log: ScanLog;
  t0: number;
  /** The stale scan this one resumes, if any: its unattempted pages go first. */
  resumedFromId: string | null;
}

interface Collected {
  /** Pages read this scan (new, changed or unchanged). */
  count: number;
  /** Of those, the pages that are new or whose text changed. */
  changed: number;
  seenUrls: Set<string>;
  /** Home page could not be read; the kind says Blocked vs Unreachable. */
  homeFailed: FetchErrorKind | null;
  /** The scan stopped early: ceiling or slow down. */
  stoppedBy: "cap" | "slowdown" | "storage" | null;
  mode: FetchMode | ScanLane;
  errorKind: string | null;
  error: string | null;
  robotsDisallowed: string[];
  /** Attempted pages that were refused (denied / login / bot wall). */
  denied: number;
  attempted: number;
}

function emptyCollected(mode: Collected["mode"]): Collected {
  return { count: 0, changed: 0, seenUrls: new Set(), homeFailed: null, stoppedBy: null, mode, errorKind: null, error: null, robotsDisallowed: [], denied: 0, attempted: 0 };
}

function statusOf(error: FetchErrorKind | undefined): PageReadStatus {
  switch (error) {
    case undefined:
      return "ok";
    case "notfound":
      return "notfound";
    case "botwall":
    case "http4xx":
      return "blocked";
    case "login":
      return "login";
    case "slowdown":
      return "slowdown";
    case "noindex":
      return "robots";
    case "unreadable":
      return "unreadable";
    case "timeout":
    case "http5xx":
      return "timeout";
    default:
      return "other";
  }
}

function noteResult(log: ScanLog, out: Collected, r: RecordPageResult, page: FetchedPage, via: string) {
  if (r.outcome === "failed") {
    const category = r.category ?? outcomeCategoryOf(page.error);
    log.count(category);
    log.pages.push({ url: r.url, status: page.status, outcome: "failed", category, chars: 0, ms: page.ms, via, error: page.errorDetail ?? page.error });
    log.add("warn", `Not read (${category}): ${page.errorDetail ?? page.error ?? "unknown"}`, r.url);
    if (category === "denied" || category === "login") out.denied++;
    return;
  }
  out.count++;
  out.seenUrls.add(r.url);
  log.pages.push({ url: r.url, status: page.status, outcome: r.outcome, chars: r.chars, ms: page.ms, via });
  if (r.outcome !== "unchanged") out.changed++;
}

/** The website: the remote lane crawls under the scanner rules. */
async function collectWebsite(ctx: CollectContext): Promise<Collected> {
  const { scanId, workspaceId, source, log, t0 } = ctx;
  // The site that bounds the crawl is the source's own: the company's host for its website, the source's address for
  // a help center, developer docs or release notes on another host (url.ts sourceSiteHost).
  const competitor = { ...ctx.competitor, host: sourceSiteHost(source, ctx.competitor.host) };
  const out = emptyCollected("plain");
  let mode: FetchMode = "plain";
  const limits = { ms: await scanTimeLimitMs() };

  // ——— 1. Frontier: known pages (pending ones first), home, robots, sitemap ———
  const rules = await readRobots(source.url);
  const pauseMs = rules.crawlDelaySec ? Math.min(CRAWL_DELAY_CAP_MS, Math.max(scanPauseMs(), rules.crawlDelaySec * 1000)) : scanPauseMs();
  log.add("info", `robots.txt: ${rules.disallow.length} disallow rule${rules.disallow.length === 1 ? "" : "s"}, ${rules.sitemaps.length} sitemap${rules.sitemaps.length === 1 ? "" : "s"}${rules.crawlDelaySec ? `, Crawl-delay ${rules.crawlDelaySec} s (pause ${pauseMs / 1000} s)` : ""}`);
  const frontier = new Frontier(competitor.host, rules, source.url);
  const known = await knownPages(source.id);
  let pendingFirst = 0;
  for (const k of known) {
    if (k.state === "removed") continue; // removed pages leave the crawl until a link or the sitemap rediscovers them
    const first = ctx.resumedFromId != null && k.lastAttemptScanId !== ctx.resumedFromId;
    if (frontier.add(new URL(k.url), "known", { first }) && first) pendingFirst++;
  }
  frontier.add(new URL(source.url), "home");
  const sitemapUrls = rules.sitemaps.length ? rules.sitemaps : [new URL("/sitemap.xml", source.url).href];
  const fromSitemap = await readSitemap(sitemapUrls, competitor.host);
  let added = 0;
  for (const u of fromSitemap) if (frontier.add(u, "sitemap")) added++;
  log.add("info", `${known.length} known page${known.length === 1 ? "" : "s"}${pendingFirst ? ` (${pendingFirst} pending from the stale scan, read first)` : ""}; sitemap: ${fromSitemap.length} URLs listed, ${added} new inside the site and allowed`);

  // ——— 2. Fetch loop ———
  let n = 0;
  while (true) {
    const cand = frontier.next();
    if (!cand) break;
    // No page limit (Daniel 2026-11-09): a site is read whole. Time and the PM-OS store are the only stops — checked only
    // while a page is left, so a limit met right after the last page never reports a stop with nothing not attempted.
    if (Date.now() - t0 > limits.ms) {
      frontier.putBack(cand);
      out.stoppedBy = "cap";
      break;
    }
    if (await storageFull()) {
      frontier.putBack(cand);
      out.stoppedBy = "storage";
      break;
    }
    if (n > 0) await sleep(pauseMs);
    n++;
    out.attempted++;
    let page = await fetchPage(cand.url, mode, competitor.host);
    if (page.binary) {
      // A download (installer, archive, office file): not a page of the site — skipped, counted for nothing.
      out.attempted--;
      log.add("info", `Not a web page (${page.errorDetail ?? "binary content"}) — skipped`, cand.url);
      continue;
    }
    // Bot wall or JS-only page → switch the whole site to the browser, once (always on in production).
    if (page.needsBrowser && mode === "plain" && !isPdfUrl(cand.url)) {
      if (browserAvailable()) {
        mode = "browser";
        out.mode = mode;
        log.add("warn", page.error === "botwall" ? "Bot protection answered the plain fetch — switching to the browser" : "Page has no text without JavaScript — switching to the browser", cand.url);
        page = await fetchPage(cand.url, mode, competitor.host);
      } else if (page.error === "botwall") {
        log.add("error", "Bot protection blocks the plain fetch and no browser is available in this environment", cand.url);
      }
    }
    // Retry transient failures within the scan (PRD: a page is pending until done; 1-3 attempts).
    for (let attempt = 0; attempt < PAGE_RETRIES && page.error && isRetryable(page.error); attempt++) {
      await sleep(pauseMs);
      log.add("info", `Retry ${attempt + 1} after ${page.errorDetail ?? page.error}`, cand.url);
      page = await fetchPage(cand.url, mode, competitor.host);
    }
    if (page.error === "slowdown") {
      // The site said slow down: stop this scan, everything left is "not attempted", the next scan continues.
      log.count("slowdown");
      log.pages.push({ url: cand.url, status: page.status, outcome: "failed", category: "slowdown", chars: 0, ms: page.ms, via: cand.via, error: page.errorDetail });
      log.add("warn", "The site answered 429 Too Many Requests — stopping this scan; the next one continues from here", cand.url);
      await recordPage({ scanId, sourceId: source.id, workspaceId, url: cand.url, status: "slowdown", via: cand.via, httpStatus: page.status, ms: page.ms });
      out.stoppedBy = "slowdown";
      break;
    }
    const r = await recordPage(
      { scanId, sourceId: source.id, workspaceId, url: cand.url, status: statusOf(page.error), html: page.html || null, text: page.kind === "document" ? page.text : null, kind: page.kind, via: cand.via, httpStatus: page.status, ms: page.ms, errorDetail: page.errorDetail ?? null },
    );
    noteResult(log, out, r, page, cand.via);
    if (cand.via === "home" && page.error && page.error !== "notfound") {
      out.homeFailed = page.error;
      out.errorKind = page.error;
      out.error = page.errorDetail ?? page.error;
      // A home page that cannot be read says something about the whole site: stop here.
      break;
    }
    if (!page.error && page.html) frontier.addLinksFrom(page.html, page.finalUrl);
    if (n % FLUSH_EVERY === 0) await log.flush({ fetchMode: mode });
  }

  // ——— 3. Bookkeeping ———
  await markLinked(source.id, scanId, frontier.linked);
  out.robotsDisallowed = frontier.robotsSkipped;
  if (frontier.robotsSkippedCount) {
    log.count("robots", frontier.robotsSkippedCount);
    log.add("info", `Kept out by robots.txt: ${frontier.robotsSkippedCount} page${frontier.robotsSkippedCount === 1 ? "" : "s"} (${frontier.robotsSkipped.slice(0, 5).join(", ")}${frontier.robotsSkipped.length > 5 ? ", …" : ""})`);
  }
  const left = frontier.remainingUrls();
  if (left.length) {
    log.notAttempted = left.length;
    if (out.stoppedBy === "cap") {
      log.count("cap", left.length);
      log.add("warn", `Time limit reached (${timeLimitLabel(limits.ms)}) — ${left.length} discovered page${left.length === 1 ? "" : "s"} not attempted; the next run continues from them`);
    } else if (out.stoppedBy === "storage") {
      log.count("storage", left.length);
      log.add("warn", `PM-OS storage limit reached (${await storageLimitLabel()} of page text, all organizations) — ${left.length} discovered page${left.length === 1 ? "" : "s"} not attempted; contact support@pm-os.io to raise it`);
    } else if (out.stoppedBy === "slowdown") {
      log.add("warn", `${left.length} discovered page${left.length === 1 ? "" : "s"} not attempted after the slow-down answer`);
    } else if (out.homeFailed) {
      log.add("warn", `${left.length} known page${left.length === 1 ? "" : "s"} not attempted — the home page could not be read`);
    }
  }
  out.mode = mode;
  return out;
}

/**
 * Pages handed in by a collector before the scan was launched (ScanPage rows
 * of this scan): store each through the page store and diff. No fetching, so
 * none of the politeness limits apply.
 */
async function collectBundle(ctx: CollectContext): Promise<Collected> {
  const { scanId, workspaceId, source, log } = ctx;
  const out = emptyCollected("bundle");
  const rows = await db.scanPage.findMany({
    where: { scanId },
    orderBy: { fetchedAt: "asc" },
    select: { url: true, title: true, kind: true, text: true, chars: true },
  });
  log.add("info", `${rows.length} page${rows.length === 1 ? "" : "s"} handed in by the collector`);
  for (const r of rows) {
    if (!r.text) {
      log.pages.push({ url: r.url, status: 0, outcome: "skipped", chars: 0, ms: 0, via: "bundle", error: "empty" });
      continue;
    }
    out.attempted++;
    const rec = await recordPage({ scanId, sourceId: source.id, workspaceId, url: r.url, status: "ok", text: r.text, title: r.title, kind: r.kind as PageKind, via: "handin" });
    noteResult(log, out, rec, { url: r.url, finalUrl: r.url, status: 200, html: "", text: r.text, kind: "page", mode: "plain", ms: 0, needsBrowser: false }, "bundle");
  }
  if (out.count === 0) {
    out.errorKind = "other";
    out.error = "the collector handed in no page text";
  }
  return out;
}

/**
 * The local lane: the hand-in route already stored every page with
 * recordPage() and logged it on the scan; read the log back.
 */
async function collectLocal(ctx: CollectContext): Promise<Collected> {
  const { scanId, source, log } = ctx;
  const out = emptyCollected("local");
  for (const p of log.pages) {
    if (p.outcome === "skipped") continue;
    out.attempted++;
    if (p.outcome === "failed") {
      if (p.category === "denied" || p.category === "login") out.denied++;
      continue;
    }
    out.count++;
    out.seenUrls.add(p.url);
  }
  out.changed = log.pages.filter((p) => p.outcome === "new" || p.outcome === "changed").length;
  const row = await db.competitorScan.findUnique({ where: { id: scanId }, select: { pagesNotAttempted: true, linkedUrls: true, errorKind: true } });
  // Now that every handed-in page has its row, apply the inbound links the station's pages carried (feeds "unlinked").
  const linked = Array.isArray(row?.linkedUrls) ? (row!.linkedUrls as string[]) : [];
  if (linked.length) await markLinked(source.id, scanId, linked);
  log.notAttempted = row?.pagesNotAttempted ?? 0;
  if (row?.errorKind === "storage") {
    // The hand-in route refused a page because the PM-OS store is full: the station stopped there.
    out.stoppedBy = "storage";
    out.errorKind = "storage";
    out.error = "PM-OS storage limit reached";
    if (log.notAttempted) log.count("storage", log.notAttempted);
    log.add("warn", `PM-OS storage limit reached (${await storageLimitLabel()} of page text, all organizations) — ${log.notAttempted} discovered page${log.notAttempted === 1 ? "" : "s"} not attempted; contact support@pm-os.io to raise it`);
  } else if (log.pages.some((p) => p.category === "slowdown")) {
    // The site answered 429: the station handed the signal in and stopped; what it had left is not a time-limit stop.
    out.stoppedBy = "slowdown";
    if (log.notAttempted) log.add("warn", `${log.notAttempted} discovered page${log.notAttempted === 1 ? "" : "s"} not attempted after the slow-down answer`);
  } else if (log.notAttempted) {
    out.stoppedBy = "cap";
    log.count("cap", log.notAttempted);
  }
  log.add("info", `${out.count} page${out.count === 1 ? "" : "s"} handed in from the station, ${out.attempted - out.count} not read${log.notAttempted ? `, ${log.notAttempted} not attempted` : ""}`);
  if (out.count === 0 && out.attempted === 0 && !out.errorKind) {
    out.errorKind = "other";
    out.error = "no page could be read";
  }
  return out;
}

/** "8 h", "45 min" or "20 s" for the scan log. */
function timeLimitLabel(ms: number): string {
  if (ms >= 3600_000 && ms % 3600_000 === 0) return `${ms / 3600_000} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** "10 GB" (or "48 KB" under a test knob) for the scan log. */
async function storageLimitLabel(): Promise<string> {
  const chars = await storageLimitChars();
  if (chars >= 1024 ** 3) return `${Math.round(chars / 1024 ** 3)} GB`;
  if (chars >= 1024 ** 2) return `${Math.round(chars / 1024 ** 2)} MB`;
  return `${Math.round(chars / 1024)} KB`;
}

// ————— Run —————

export async function runScan(scanId: string): Promise<void> {
  const scan = await db.competitorScan.findUnique({
    where: { id: scanId },
    include: { source: { include: { competitor: true } } },
  });
  if (!scan || !(ACTIVE_SCAN_STATUSES as readonly string[]).includes(scan.status)) return;
  const { source } = scan;
  const competitor = source.competitor;
  const workspaceId = scan.workspaceId;
  const lane: ScanLane = scan.fetchMode === "bundle" ? "bundle" : (scan.lane as ScanLane);
  // Claim the scan atomically (Tomer's review): a finishing scan, the tick and a Scan run may all try to start the
  // same queued scan; only the one that flips queued → running proceeds. The local lane's claim is its request row
  // (handed_in → done) so two /done calls, or the stale sweep's relaunch and a late job, cannot both process the pages.
  if (lane === "local") {
    const claimed = await db.localScanRequest.updateMany({ where: { scanId, state: "handed_in" }, data: { state: "done", finishedAt: new Date() } });
    if (!claimed.count) return;
  } else {
    const claimed = await db.competitorScan.updateMany({ where: { id: scanId, status: "queued" }, data: { status: "running", heartbeatAt: new Date() } });
    if (!claimed.count) return;
  }
  // The local lane logged its pages on the row already; everything else starts a fresh log.
  const log = lane === "local"
    ? new ScanLog(scanId, { lines: Array.isArray(scan.log) ? (scan.log as unknown as LogLine[]) : [], pages: Array.isArray(scan.pages) ? (scan.pages as unknown as PageLogEntry[]) : [], outcomes: (scan.outcomes ?? {}) as OutcomeCounts })
    : new ScanLog(scanId);
  const t0 = Date.now();
  const heartbeat = setInterval(() => void db.competitorScan.update({ where: { id: scanId }, data: { heartbeatAt: new Date() } }).catch(() => undefined), HEARTBEAT_MS);
  if (lane === "remote") acquireBrowser();
  const sourceLabel = C.profile.sourceTypes[source.type] ?? source.type;
  // A remote scan may resume the last stale scan of the source: its pending pages go first.
  const staleBefore = lane === "remote" ? await db.competitorScan.findFirst({ where: { sourceId: source.id, status: "stale" }, orderBy: { startedAt: "desc" }, select: { id: true } }) : null;
  await db.competitorScan.update({ where: { id: scanId }, data: { status: "running", lane, ...(lane === "remote" ? { startedAt: new Date() } : {}), resumedFromId: staleBefore?.id ?? null } });
  log.add("info", lane === "remote"
    ? `Scan started (${scan.trigger}) for ${competitor.name} — ${source.url}${staleBefore ? ", resuming the stale scan's pending pages first" : ""}`
    : lane === "local"
      ? `Processing ${competitor.name} — pages handed in from the station`
      : `Scan started (${scan.trigger}) for ${competitor.name} — ${sourceLabel} pages handed in by a collector`);

  let finalStatus: "ok" | "partial" | "failed" = "ok";
  let badge: ScanBadge = "full";
  let errorKind: string | null = null;
  let error: string | null = null;
  let mode: Collected["mode"] = lane;
  let robotsDisallowed: string[] = [];
  let removedPages: string[] = [];
  let handToLocal = false;
  /** The analysis run this scan queued (null: none — the scan read nothing, or the test knob switched PMOS AI off). */
  let analysisId: string | null = null;

  try {
    const ctx: CollectContext = { scanId, workspaceId, source, competitor, log, t0, resumedFromId: staleBefore?.id ?? null };
    const col = lane === "bundle" ? await collectBundle(ctx) : lane === "local" ? await collectLocal(ctx) : await collectWebsite(ctx);
    mode = col.mode;
    errorKind = col.errorKind;
    error = col.error;
    robotsDisallowed = col.robotsDisallowed;
    const { count, changed, seenUrls, homeFailed, stoppedBy } = col;
    const notRead = log.pages.filter((p) => p.outcome === "failed" && p.category !== "notfound").length;
    const full = !homeFailed && !stoppedBy && notRead === 0 && robotsDisallowed.length === 0 && count > 0;

    // ——— Page states: missing / removed / unlinked (removed needs proof: two consecutive not-found answers) ———
    const states = await finalizePageStates(source.id, scanId, full && lane !== "bundle");
    removedPages = states.removedUrls;
    if (states.removedUrls.length) log.add("info", `Removed (not found twice in a row): ${states.removedUrls.length} page${states.removedUrls.length === 1 ? "" : "s"} (${states.removedUrls.slice(0, 3).map((u) => u.replace(/^https?:\/\/[^/]+/, "")).join(", ")}${states.removedUrls.length > 3 ? ", …" : ""})`);
    if (states.missing) log.add("info", `${states.missing} page${states.missing === 1 ? "" : "s"} missing (not found once — nothing happens until the next scan)`);
    if (states.unlinked) log.add("info", `${states.unlinked} page${states.unlinked === 1 ? "" : "s"} unlinked (still answer, nothing points at them)`);
    log.add("info", `${lane === "remote" ? "Fetched" : "Read"} ${count} pages${lane === "remote" ? ` via ${mode}` : ""}: ${changed} new or changed, ${count - changed} unchanged, ${log.pages.filter((p) => p.outcome === "failed").length} not read${log.notAttempted ? `, ${log.notAttempted} not attempted` : ""}`);
    await log.flush({ fetchMode: mode === "local" || mode === "bundle" ? mode : mode, robotsDisallowed: robotsDisallowed as unknown as Prisma.InputJsonValue, removedPages: removedPages as unknown as Prisma.InputJsonValue });

    if (homeFailed) {
      finalStatus = "failed";
      log.add("error", `The home page could not be read — scan failed (${error})`);
    } else if (count === 0 && stoppedBy === "storage") {
      // The PM-OS store was full before the first page: nothing was read, but the site is fine.
      finalStatus = "partial";
      errorKind = "storage";
      error = error ?? "PM-OS storage limit reached — no page was read; contact support@pm-os.io to raise it";
      log.add("warn", error);
    } else if (count === 0) {
      finalStatus = "failed";
      errorKind = errorKind ?? "other";
      error = error ?? "no page could be read";
    } else if ((await getGlobalScanSettings()).analysisDisabled) {
      // Administration → Competitors → "Disable analysis" (Daniel 2026-11-11): the scan ends here, with its pages saved.
      // No analysis is queued; the pages stay unread until a later analysis (page hash) picks them up.
      log.add("info", "Analysis is disabled in Administration — the scan ends after saving the pages; PMOS AI not called");
      await markFactsSeen(competitor.id, scanId, seenUrls, removedPages, log, source.url);
    } else {
      // The scan ends at the pages. What they say is read by the analysis: its own queued run, after the scan.
      // Queued after every scan that read a page, also when no page changed — such a run makes no research call and
      // is how a new row of ours gets looked for at this competitor.
      await markFactsSeen(competitor.id, scanId, seenUrls, removedPages, log, source.url);
      const q = await queueAnalysis(workspaceId, competitor.id, "scan", { scanId, startedById: scan.startedById });
      if ("skipped" in q) {
        log.add("warn", "PMOS AI analysis skipped (COMPETITORS_AI=off, test knob)");
      } else {
        analysisId = q.id;
        log.add("info", q.created ? `Analysis queued (${q.id})` : `Analysis already queued (${q.id})`);
      }
    }

    // ——— Badge (PRD): Blocked = the site refused us on most pages or at the door; Unreachable = no answer at all ———
    const refusedAtDoor = homeFailed === "botwall" || homeFailed === "http4xx" || homeFailed === "login";
    if (homeFailed) {
      badge = refusedAtDoor ? "blocked" : "unreachable";
    } else if (count === 0 && col.stoppedBy !== "storage") {
      // Remote: the site did not answer (or refused everything). Local: the station handed in nothing — a station problem, not the site's.
      badge = col.denied > 0 ? "blocked" : lane === "local" ? "incomplete" : "unreachable";
    } else if (col.denied > 0 && col.denied * 2 >= col.attempted) {
      badge = "blocked";
    } else if (!full) {
      badge = "incomplete";
    } else {
      // The badge is about pages (PRD: Incomplete = pages not read, with reasons).
      badge = "full";
    }
    // Blocked in the remote lane hands the site to the local lane (a PM's browser), when a station is enrolled.
    handToLocal = badge === "blocked" && lane === "remote";
  } catch (e) {
    finalStatus = "failed";
    badge = "unreachable";
    errorKind = errorKind ?? "other";
    error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    log.add("error", `Scan aborted: ${error}`);
  } finally {
    clearInterval(heartbeat);
    if (lane === "remote") await releaseBrowser().catch(() => undefined);
  }

  const durationMs = Date.now() - t0;
  log.add("info", `Scan ${finalStatus} (${badge}) in ${Math.round(durationMs / 1000)} s · ${log.read} page${log.read === 1 ? "" : "s"} read, ${log.changed} new or changed`);
  const finishedAt = new Date();
  await log.flush({
    status: finalStatus,
    badge,
    finishedAt,
    fetchMode: mode,
    errorKind: errorKind ?? "none",
    error,
    robotsDisallowed: robotsDisallowed as unknown as Prisma.InputJsonValue,
    removedPages: removedPages as unknown as Prisma.InputJsonValue,
  });
  await db.competitorSource.update({
    where: { id: source.id },
    data: { lastScanAt: await now(), lastStatus: finalStatus, lastError: finalStatus === "ok" ? null : error },
  });
  if (lane === "local") await finishLocalRequest(scanId);
  await recordCompetitorEvent(workspaceId, scan.startedById, "cmp_scan_finished", {
    scanId,
    competitorId: competitor.id,
    sourceType: source.type,
    lane,
    status: finalStatus,
    badge,
    pagesFetched: log.read,
    pagesChanged: log.changed,
    pagesNotAttempted: log.notAttempted,
    analysisId,
    durationMs,
    errorKind: errorKind ?? "none",
  });

  if (handToLocal && (await hasActiveScannerKey())) {
    // The remote lane was refused: the same site goes to a PM's browser. Customers see "Scan pending".
    const follow = await db.competitorScan.create({ data: { workspaceId, sourceId: source.id, trigger: scan.trigger, startedById: scan.startedById, status: "queued", lane: "local", startedAt: await now(), heartbeatAt: new Date() }, select: { id: true } });
    await createLocalRequest(follow.id);
    log.add("info", `Handed to the local lane (${follow.id})`);
    await db.competitorScan.update({ where: { id: scanId }, data: { log: log.lines as unknown as Prisma.InputJsonValue } });
  }

  // A scan of a Scan run that ended: the run's one email may be due now (a parked local scan ends long after its run).
  if (scan.runId) {
    const { notifyRunsOfScans } = await import("./runs");
    await notifyRunsOfScans([scanId]);
  }

  // A freed slot is used at once: a scan queued behind this one gets its lane, and the next queued remote scan starts now, not at the next tick.
  try {
    const { promoteQueued, startQueuedScans } = await import("./tick");
    const { launchScan } = await import("./run");
    await promoteQueued(source.id);
    await startQueuedScans(launchScan);
  } catch (e) {
    console.error("[competitors] could not start the next queued scan", e);
  }

  // The company's other addresses — help center, developer docs, release notes — are looked for again after every
  // scan of its main website that read a page: companies add these later. The scan has ended; whatever the search
  // does, it changes nothing about it (address-search.ts never throws, and an address it adds gets a scan of its own).
  if (source.type === "website" && log.read > 0) {
    try {
      const { searchAddresses } = await import("./address-search");
      await searchAddresses(competitor.id, { trigger: "scan", userId: scan.startedById });
    } catch (e) {
      console.error("[competitors] the search for other addresses after the scan failed", scanId, e);
    }
  }
}

/** Whether the remote lane may run at all (Administration switch). */
export async function remoteLaneOn(): Promise<boolean> {
  return (await getGlobalScanSettings()).remoteScanEnabled;
}

/**
 * Facts whose source page was read in this scan are "seen"; facts whose page
 * failed or disappeared become "source no longer reachable" (cleared when
 * seen again). Staleness (3 scans unseen) is derived at read time, per source.
 */
async function markFactsSeen(competitorId: string, scanId: string, seenUrls: Set<string>, removedPages: string[], log: ScanLog, siteUrl: string): Promise<void> {
  const facts = await db.profileFact.findMany({ where: { competitorId, manual: false, dismissedAt: null }, select: { id: true, sourceUrl: true, unreachableAt: true } });
  const removed = new Set(removedPages);
  const failed = new Set(log.pages.filter((p) => p.outcome === "failed").map((p) => p.url));
  let gone = 0;
  for (const f of facts) {
    // The same key the page store uses (the home page is "https://site/" with its slash) — a bare-stripped URL never matched it.
    let url: string | null = null;
    try {
      url = f.sourceUrl ? pageKey(new URL(f.sourceUrl), siteUrl) : null;
    } catch {
      url = null;
    }
    if (url && seenUrls.has(url)) {
      await db.profileFact.update({ where: { id: f.id }, data: { lastSeenScanId: scanId, unreachableAt: null } });
    } else if (url && (removed.has(url) || failed.has(url)) && !f.unreachableAt) {
      await db.profileFact.update({ where: { id: f.id }, data: { unreachableAt: new Date() } });
      gone++;
    }
  }
  if (gone) log.add("info", `${gone} fact${gone === 1 ? "" : "s"} marked "source no longer reachable"`);
}
