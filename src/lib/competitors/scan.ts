import type { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  classifyCapabilities,
  extractFacts,
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
  type StatusValue,
} from "./config";
import { getCompetitorsConfig } from "./store";
import { Frontier, readRobots, readSitemap } from "./crawl";
import { browserAvailable, closeBrowser, fetchPage, outcomeCategoryOf, sleep, type FetchErrorKind, type FetchMode, type FetchedPage } from "./fetcher";
import { contentHash, titleOf } from "./html";
import { checkPii } from "./pii";

/**
 * One scan of one source, end to end: crawl under the scanner rules → diff →
 * PMOS AI → statuses, facts, suggestions → scan log with outcome counts and
 * the user-facing badge. Runs inside the scanner job (Cloud Run) or
 * in-process in local dev; both call runScan(scanId).
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

/** Create the Scan row; the caller launches it. Refuses when a scan already runs in the workspace. */
export async function createScan(
  workspaceId: string,
  competitorId: string,
  trigger: "manual" | "scheduled",
  startedById: string | null,
): Promise<{ scanId: string } | { error: "running" | "no_source" }> {
  const active = await db.competitorScan.findFirst({
    where: { workspaceId, status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  if (active) return { error: "running" };
  const source = await db.competitorSource.findFirst({ where: { workspaceId, competitorId, type: "website" } });
  if (!source) return { error: "no_source" };
  const scan = await db.competitorScan.create({
    data: { workspaceId, sourceId: source.id, trigger, startedById, status: "queued" },
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
  await db.competitorScan.update({ where: { id: scanId }, data: { status: "running", startedAt: new Date() } });
  log.add("info", `Scan started (${scan.trigger}) for ${competitor.name} — ${source.url}, limit ${config.maxPagesPerScan} pages, budget ${Math.round(SCAN_TIME_BUDGET_MS / 60000)} min`);

  let finalStatus: "ok" | "partial" | "failed" = "ok";
  let badge: ScanBadge = "full";
  let errorKind: string | null = null;
  let error: string | null = null;
  let mode: FetchMode = "plain";
  let aiCalls = 0;
  let statusesChanged = 0;
  let factsChanged = 0;
  let suggestions = 0;
  let piiHits = 0;
  let robotsDisallowed: string[] = [];
  let removedPages: string[] = [];

  try {
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

    // Previous pages of this source: hashes (changed vs unchanged), validators
    // (conditional requests) and the URL set (removed pages).
    const previousPages = await db.scanPage.findMany({
      where: { sourceId: source.id, scanId: { not: scanId } },
      orderBy: { fetchedAt: "desc" },
      select: { url: true, contentHash: true, etag: true, lastModified: true, text: true, scanId: true },
    });
    const lastScanId = previousPages[0]?.scanId ?? null;
    const prev = new Map<string, { hash: string; etag: string | null; lastModified: string | null; text: string | null }>();
    for (const p of previousPages) if (!prev.has(p.url)) prev.set(p.url, { hash: p.contentHash, etag: p.etag, lastModified: p.lastModified, text: p.text });
    const lastScanUrls = new Set(previousPages.filter((p) => p.scanId === lastScanId).map((p) => p.url));
    const firstScan = prev.size === 0;

    // ——— 2. Fetch loop ———
    const fetched: FetchedPage[] = [];
    const changedPages: PageText[] = [];
    const seenUrls = new Set<string>();
    let homeFailed = false;
    let capReached = false;
    let budgetReached = false;
    let count = 0;
    let attempts = 0;
    // Failed fetches (stale sitemap entries → 404) don't eat the page budget,
    // but attempts are capped so a broken site cannot loop.
    const maxAttempts = config.maxPagesPerScan + 15;
    while (true) {
      if (count >= config.maxPagesPerScan || attempts >= maxAttempts) {
        capReached = frontier.remaining > 0;
        break;
      }
      if (Date.now() - t0 > SCAN_TIME_BUDGET_MS) {
        budgetReached = true;
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
          log.add("warn", page.error === "botwall" ? "Bot protection answered the plain fetch — switching to the browser" : "Page has no text without JavaScript — switching to the browser", cand.url);
          page = await fetchPage(cand.url, mode);
        } else if (page.error === "botwall") {
          log.add("error", "Bot protection blocks the plain fetch and no browser is available in this environment", cand.url);
        }
      }

      if (page.notModified) {
        // 304: the previous text still stands — costs nothing, counts as a read page.
        const p = prev.get(cand.url);
        count++;
        seenUrls.add(cand.url);
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
          homeFailed = true;
          errorKind = errorKindOf(page.error);
          error = page.errorDetail ?? page.error;
          break;
        }
        continue;
      }

      count++;
      seenUrls.add(cand.url);
      const hash = contentHash(page.text);
      const before = prev.get(cand.url);
      const outcome: PageOutcome = before == null ? "new" : before.hash === hash ? "unchanged" : "changed";
      log.pages.push({ url: cand.url, status: page.status, outcome, chars: page.text.length, ms: page.ms, via: cand.via });
      fetched.push(page);
      await db.scanPage.create({
        data: { scanId, sourceId: source.id, url: cand.url, contentHash: hash, text: page.text, chars: page.text.length, etag: page.etag ?? null, lastModified: page.lastModified ?? null },
      });
      if (outcome !== "unchanged") changedPages.push({ url: cand.url, title: titleOf(page.html), text: page.text });
      frontier.addLinksFrom(page.html, page.finalUrl);
      if (count % HEARTBEAT_EVERY === 0) await log.flush({ fetchMode: mode });
    }

    // Pages kept out before any request: robots.txt and the people-page policy.
    robotsDisallowed = frontier.robotsSkipped;
    if (frontier.robotsSkipped.length) {
      log.count("robots", frontier.robotsSkipped.length);
      log.add("info", `Blocked by robots.txt: ${frontier.robotsSkipped.length} path${frontier.robotsSkipped.length === 1 ? "" : "s"} (${frontier.robotsSkipped.slice(0, 5).join(", ")}${frontier.robotsSkipped.length > 5 ? ", …" : ""})`);
    }
    if (frontier.policySkipped.length) {
      log.count("policy", frontier.policySkipped.length);
      log.add("info", `Skipped by policy (people pages): ${frontier.policySkipped.length} (${frontier.policySkipped.slice(0, 5).join(", ")}${frontier.policySkipped.length > 5 ? ", …" : ""})`);
    }
    if (capReached) {
      log.count("cap", frontier.remaining);
      log.add("info", `Page limit reached (${config.maxPagesPerScan}) — ${frontier.remaining} discovered pages not fetched`);
    }
    if (budgetReached) {
      log.count("cap", frontier.remaining + 1);
      log.add("warn", `Time budget reached (${Math.round(SCAN_TIME_BUDGET_MS / 60000)} min) — ${frontier.remaining + 1} discovered pages not fetched`);
    }
    // Pages the last scan read that this one did not see — a removed pricing page is a signal.
    if (!homeFailed && lastScanUrls.size) {
      const failedNow = new Set(log.pages.filter((p) => p.outcome === "failed").map((p) => p.url));
      removedPages = [...lastScanUrls].filter((u) => !seenUrls.has(u) && (failedNow.has(u) || !capReached && !budgetReached)).slice(0, 100);
      if (removedPages.length) log.add("info", `Removed since the last scan: ${removedPages.length} page${removedPages.length === 1 ? "" : "s"} (${removedPages.slice(0, 3).map((u) => u.replace(/^https?:\/\/[^/]+/, "")).join(", ")}${removedPages.length > 3 ? ", …" : ""})`);
    }
    log.add("info", `Fetched ${count} pages via ${mode}: ${changedPages.length} new or changed, ${count - changedPages.length} unchanged, ${log.pages.filter((p) => p.outcome === "failed").length} failed`);
    await log.flush({ fetchMode: mode, robotsDisallowed: robotsDisallowed as unknown as Prisma.InputJsonValue, removedPages: removedPages as unknown as Prisma.InputJsonValue });

    if (homeFailed) {
      finalStatus = "failed";
      log.add("error", `The home page could not be read — scan failed (${error})`);
    } else if (count === 0) {
      finalStatus = "failed";
      errorKind = "other";
      error = "no page could be read";
    } else if (changedPages.length === 0) {
      log.add("info", "Nothing changed since the last scan — PMOS AI not called");
      await markFactsSeen(competitor.id, scanId, seenUrls, removedPages, log);
    } else {
      // ——— 3. PMOS AI ———
      const r = await aiStep(workspaceId, competitor.id, competitor.name, scanId, changedPages, firstScan, log);
      aiCalls = r.aiCalls;
      statusesChanged = r.statusesChanged;
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

    // ——— 4. Prune page texts older than the last KEEP_TEXT_SCANS scans ———
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
  log.add("info", `Scan ${finalStatus} (${badge}) in ${Math.round(durationMs / 1000)} s · ${aiCalls} AI call${aiCalls === 1 ? "" : "s"} · ${statusesChanged} status change${statusesChanged === 1 ? "" : "s"} · ${factsChanged} fact change${factsChanged === 1 ? "" : "s"} · ${suggestions} suggestion${suggestions === 1 ? "" : "s"}${piiHits ? ` · ${piiHits} PII hit${piiHits === 1 ? "" : "s"} dropped` : ""}`);
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
 * seen again). Staleness (3 scans unseen) is derived at read time.
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
  statusesChanged: number;
  factsChanged: number;
  suggestions: number;
  piiHits: number;
  failed: string | null;
}

async function loadCatalog(workspaceId: string): Promise<{ forAi: CatalogForAi; byName: Map<string, { id: string; domainId: string }>; domainIdByName: Map<string, string> }> {
  const domains = await db.competitorDomain.findMany({
    where: { workspaceId },
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

async function aiStep(
  workspaceId: string,
  competitorId: string,
  competitorName: string,
  scanId: string,
  pages: PageText[],
  firstScan: boolean,
  log: ScanLog,
): Promise<AiStepResult> {
  const res: AiStepResult = { aiCalls: 0, statusesChanged: 0, factsChanged: 0, suggestions: 0, piiHits: 0, failed: null };
  /** Rule 6: a snippet that names a person is dropped, never stored. */
  const clean = (text: string | null | undefined, what: string, url?: string): string | null => {
    const r = checkPii(text);
    if (!r.hit) return text || null;
    res.piiHits++;
    log.add("warn", `PII check dropped a ${what} (${r.kind})`, url);
    return null;
  };
  try {
    const catalog = await loadCatalog(workspaceId);

    if (catalog.byName.size === 0) {
      log.add("warn", "The capability catalog is empty — add domains and capabilities in Settings → Competitors; this scan only collects profile facts");
    } else {
      // Statuses
      const prevRows = await db.capabilityStatus.findMany({ where: { competitorId }, include: { capability: { select: { name: true } } } });
      const previous: PreviousStatus[] = prevRows.map((p) => ({ capability: p.capability.name, value: p.value as StatusValue, confidence: p.confidence }));
      log.add("info", `Classifying ${catalog.byName.size} capabilities from ${pages.length} changed pages`);
      const cls = await classifyCapabilities(competitorName, catalog.forAi, previous, pages);
      res.aiCalls++;
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
        if (value === "unknown" && prev && prev.value !== "unknown") {
          value = prev.value as StatusValue;
          confidence = prev.confidence;
          quote = prev.quote;
          sourceUrl = prev.sourceUrl;
        }
        if (!prev) {
          await db.capabilityStatus.create({
            data: { workspaceId, competitorId, capabilityId: cap.id, value, confidence, quote, sourceUrl, scanId, changedAt: firstScan ? null : now },
          });
          if (!firstScan && value !== "unknown") res.statusesChanged++;
        } else if (prev.value !== value) {
          await db.statusHistory.create({ data: { statusId: prev.id, value: prev.value, quote: prev.quote, sourceUrl: prev.sourceUrl, scanId: prev.scanId } });
          await db.capabilityStatus.update({ where: { id: prev.id }, data: { value, confidence, quote, sourceUrl, scanId, changedAt: now } });
          res.statusesChanged++;
          log.add("info", `${name}: ${prev.value} → ${value}`, sourceUrl ?? undefined);
        } else if (quote && quote !== prev.quote) {
          await db.capabilityStatus.update({ where: { id: prev.id }, data: { confidence, quote, sourceUrl, scanId } });
        }
      }
      // Suggestions
      for (const s of cls.value.suggestions) {
        const domainId = catalog.domainIdByName.get(s.domain);
        if (!domainId) continue;
        const exists = await db.capability.findFirst({ where: { workspaceId, name: { equals: s.name, mode: "insensitive" } }, select: { id: true } });
        if (exists) continue;
        const quote = clean(s.quote, "suggestion quote", s.url);
        // A capability a competitor has and the catalog lacks: if accepted it is a gap by default.
        await db.capability.create({
          data: { workspaceId, domainId, name: s.name, position: 9999, origin: "ai", state: "suggested", ourStatus: "missing", suggestedById: competitorId, suggestedQuote: quote ? `${quote} — ${s.url}` : null },
        });
        res.suggestions++;
        log.add("info", `Suggested new capability: ${s.name} (${s.domain})`, s.url || undefined);
      }
    }

    // Facts
    {
      const ext = await extractFacts(competitorName, pages);
      res.aiCalls++;
      const now = new Date();
      for (const f of ext.value) {
        if (!clean(f.value, `${f.kind} fact`, f.url)) continue;
        const existing = await db.profileFact.findUnique({ where: { competitorId_kind_value: { competitorId, kind: f.kind, value: f.value } } });
        if (existing) {
          await db.profileFact.update({ where: { id: existing.id }, data: { lastSeenScanId: scanId, unreachableAt: null, ...(existing.sourceUrl ? {} : { sourceUrl: f.url || null }) } });
          continue;
        }
        await db.profileFact.create({ data: { workspaceId, competitorId, kind: f.kind, value: f.value, sourceUrl: f.url || null, scanId, lastSeenScanId: scanId, changedAt: now } });
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
