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
import { getCompetitorsConfig } from "./store";
import { Frontier, readRobots, readSitemap } from "./crawl";
import { browserAvailable, closeBrowser, fetchPage, PAGE_PAUSE_MS, sleep, type FetchErrorKind, type FetchMode, type FetchedPage } from "./fetcher";
import { contentHash, titleOf } from "./html";
import type { StatusValue } from "./config";

/**
 * One scan of one source, end to end: crawl → diff → PMOS AI → statuses,
 * facts, suggestions → scan log. Runs inside the scanner job (Cloud Run) or
 * in-process in local dev; both call runScan(scanId).
 */

export type PageOutcome = "new" | "changed" | "unchanged" | "failed" | "skipped";
export interface PageLogEntry {
  url: string;
  status: number;
  outcome: PageOutcome;
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

const HEARTBEAT_EVERY = 5;
/** Texts are kept for this many scans per source; older rows keep the hash only. */
const KEEP_TEXT_SCANS = 2;

class ScanLog {
  readonly lines: LogLine[] = [];
  readonly pages: PageLogEntry[] = [];
  private readonly scanId: string;
  constructor(scanId: string) {
    this.scanId = scanId;
  }
  add(level: LogLine["level"], msg: string, url?: string) {
    this.lines.push({ at: new Date().toISOString(), level, msg, ...(url ? { url } : {}) });
  }
  async flush(extra: Prisma.CompetitorScanUpdateInput = {}) {
    await db.competitorScan.update({
      where: { id: this.scanId },
      data: {
        heartbeatAt: new Date(),
        log: this.lines as unknown as Prisma.InputJsonValue,
        pages: this.pages as unknown as Prisma.InputJsonValue,
        pagesFetched: this.pages.filter((p) => p.outcome !== "skipped").length,
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
  log.add("info", `Scan started (${scan.trigger}) for ${competitor.name} — ${source.url}, limit ${config.maxPagesPerScan} pages`);

  let finalStatus: "ok" | "partial" | "failed" = "ok";
  let errorKind: string | null = null;
  let error: string | null = null;
  let mode: FetchMode = "plain";
  let aiCalls = 0;
  let statusesChanged = 0;
  let factsChanged = 0;
  let suggestions = 0;

  try {
    // ——— 1. Frontier: robots, sitemap, home ———
    const rules = await readRobots(source.url);
    log.add("info", `robots.txt: ${rules.disallow.length} disallow rule${rules.disallow.length === 1 ? "" : "s"}, ${rules.sitemaps.length} sitemap${rules.sitemaps.length === 1 ? "" : "s"}`);
    const frontier = new Frontier(competitor.host, rules);
    frontier.add(new URL(source.url), "home");
    const sitemapUrls = rules.sitemaps.length ? rules.sitemaps : [new URL("/sitemap.xml", source.url).href];
    const fromSitemap = await readSitemap(sitemapUrls, competitor.host);
    let added = 0;
    for (const u of fromSitemap) if (frontier.add(u, "sitemap")) added++;
    log.add("info", `sitemap: ${fromSitemap.length} URLs listed, ${added} inside the site and allowed`);

    // Previous hashes of this source, to tell changed from unchanged.
    const previousPages = await db.scanPage.findMany({
      where: { sourceId: source.id, scanId: { not: scanId } },
      orderBy: { fetchedAt: "desc" },
      select: { url: true, contentHash: true },
    });
    const prevHash = new Map<string, string>();
    for (const p of previousPages) if (!prevHash.has(p.url)) prevHash.set(p.url, p.contentHash);
    const firstScan = prevHash.size === 0;

    // ——— 2. Fetch loop ———
    const fetched: FetchedPage[] = [];
    const changedPages: PageText[] = [];
    let homeFailed = false;
    let count = 0;
    let attempts = 0;
    // Failed fetches (stale sitemap entries → 404) don't eat the page budget,
    // but attempts are capped so a broken site cannot loop.
    const maxAttempts = config.maxPagesPerScan + 15;
    while (count < config.maxPagesPerScan && attempts < maxAttempts) {
      const cand = frontier.next();
      if (!cand) break;
      if (attempts > 0) await sleep(PAGE_PAUSE_MS);
      attempts++;
      let page = await fetchPage(cand.url, mode);

      // Bot wall or JS-only page → switch the whole site to browser mode, once.
      if (page.needsBrowser && mode === "plain") {
        if (browserAvailable()) {
          mode = "browser";
          log.add("warn", page.error === "botwall" ? "Bot protection answered the plain fetch — switching to the browser" : "Page has no text without JavaScript — switching to the browser", cand.url);
          page = await fetchPage(cand.url, mode);
        } else if (page.error === "botwall") {
          log.add("error", "Bot protection blocks the plain fetch and no browser is available in this environment", cand.url);
        }
      }

      if (page.error) {
        log.pages.push({ url: cand.url, status: page.status, outcome: "failed", chars: 0, ms: page.ms, via: cand.via, error: page.errorDetail ?? page.error });
        log.add("warn", `Failed: ${page.errorDetail ?? page.error}`, cand.url);
        if (cand.via === "home") {
          homeFailed = true;
          errorKind = errorKindOf(page.error);
          error = page.errorDetail ?? page.error;
          break;
        }
        continue;
      }

      count++;
      const hash = contentHash(page.text);
      const prev = prevHash.get(cand.url);
      const outcome: PageOutcome = prev == null ? "new" : prev === hash ? "unchanged" : "changed";
      log.pages.push({ url: cand.url, status: page.status, outcome, chars: page.text.length, ms: page.ms, via: cand.via });
      fetched.push(page);
      await db.scanPage.create({
        data: { scanId, sourceId: source.id, url: cand.url, contentHash: hash, text: page.text, chars: page.text.length },
      });
      if (outcome !== "unchanged") changedPages.push({ url: cand.url, title: titleOf(page.html), text: page.text });
      frontier.addLinksFrom(page.html, page.finalUrl);
      if (count % HEARTBEAT_EVERY === 0) await log.flush({ fetchMode: mode });
    }
    if (frontier.remaining > 0 && count >= config.maxPagesPerScan) {
      log.add("info", `Page limit reached (${config.maxPagesPerScan}) — ${frontier.remaining} discovered pages not fetched`);
    }
    log.add("info", `Fetched ${fetched.length} pages via ${mode}: ${changedPages.length} new or changed, ${fetched.length - changedPages.length} unchanged, ${log.pages.filter((p) => p.outcome === "failed").length} failed`);
    await log.flush({ fetchMode: mode });

    if (homeFailed) {
      finalStatus = "failed";
      log.add("error", `The home page could not be read — scan failed (${error})`);
    } else if (fetched.length === 0) {
      finalStatus = "failed";
      errorKind = "other";
      error = "no page could be read";
    } else if (changedPages.length === 0) {
      log.add("info", "Nothing changed since the last scan — PMOS AI not called");
    } else {
      // ——— 3. PMOS AI ———
      const r = await aiStep(workspaceId, competitor.id, competitor.name, scanId, changedPages, firstScan, log);
      aiCalls = r.aiCalls;
      statusesChanged = r.statusesChanged;
      factsChanged = r.factsChanged;
      suggestions = r.suggestions;
      if (r.failed) {
        finalStatus = "partial";
        errorKind = "ai";
        error = r.failed;
      }
    }

    // ——— 4. Prune page texts older than the last KEEP_TEXT_SCANS scans ———
    const keep = await db.competitorScan.findMany({
      where: { sourceId: source.id, status: { in: ["ok", "partial", "running"] } },
      orderBy: { startedAt: "desc" },
      take: KEEP_TEXT_SCANS,
      select: { id: true },
    });
    await db.scanPage.updateMany({
      where: { sourceId: source.id, scanId: { notIn: keep.map((k) => k.id) }, text: { not: null } },
      data: { text: null },
    });
  } catch (e) {
    finalStatus = "failed";
    errorKind = errorKind ?? "other";
    error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    log.add("error", `Scan aborted: ${error}`);
  } finally {
    await closeBrowser().catch(() => undefined);
  }

  const durationMs = Date.now() - t0;
  log.add("info", `Scan ${finalStatus} in ${Math.round(durationMs / 1000)} s · ${aiCalls} AI call${aiCalls === 1 ? "" : "s"} · ${statusesChanged} status change${statusesChanged === 1 ? "" : "s"} · ${factsChanged} fact change${factsChanged === 1 ? "" : "s"} · ${suggestions} suggestion${suggestions === 1 ? "" : "s"}`);
  await log.flush({
    status: finalStatus,
    finishedAt: new Date(),
    fetchMode: mode,
    aiCalls,
    statusesChanged,
    factsChanged,
    suggestions,
    errorKind: errorKind ?? "none",
    error,
  });
  await db.competitorSource.update({
    where: { id: source.id },
    data: { lastScanAt: new Date(), lastStatus: finalStatus, lastError: finalStatus === "ok" ? null : error },
  });
  await recordCompetitorEvent(workspaceId, scan.startedById, "cmp_scan_finished", {
    scanId,
    competitorId: competitor.id,
    status: finalStatus,
    pagesFetched: log.pages.filter((p) => p.outcome !== "skipped").length,
    pagesChanged: log.pages.filter((p) => p.outcome === "new" || p.outcome === "changed").length,
    statusesChanged,
    factsChanged,
    suggestions,
    durationMs,
    errorKind: errorKind ?? "none",
  });
}

// ————— AI step —————

interface AiStepResult {
  aiCalls: number;
  statusesChanged: number;
  factsChanged: number;
  suggestions: number;
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
  const res: AiStepResult = { aiCalls: 0, statusesChanged: 0, factsChanged: 0, suggestions: 0, failed: null };
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
        let quote = ans?.quote || null;
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
        // A capability a competitor has and the catalog lacks: if accepted it is a gap by default.
        await db.capability.create({
          data: { workspaceId, domainId, name: s.name, position: 9999, origin: "ai", state: "suggested", ourStatus: "missing", suggestedById: competitorId, suggestedQuote: s.quote ? `${s.quote} — ${s.url}` : null },
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
        const existing = await db.profileFact.findUnique({ where: { competitorId_kind_value: { competitorId, kind: f.kind, value: f.value } } });
        if (existing) continue;
        await db.profileFact.create({ data: { workspaceId, competitorId, kind: f.kind, value: f.value, sourceUrl: f.url || null, scanId, changedAt: now } });
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
