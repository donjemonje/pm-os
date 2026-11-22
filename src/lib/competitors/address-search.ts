import { alertedKeyAfter, shouldAlertUndecided, undecidedAlertKey } from "./address-alert";
import { sendUndecidedAlert } from "./address-alert-send";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  ADDRESS_PICK_MAX_TOKENS,
  ADDRESS_PICK_SYSTEM_PROMPT,
  addressPickTool,
  checkManualAddress,
  injectedAddressPick,
  isScannedAddress,
  knownAddresses,
  manualAddressMustAnswer,
  parseAddressPick,
  pickEntries,
  readAddressSearch,
  renderAddressPick,
  screenCandidates,
  searchLane,
  SEARCH_STALE_MS,
  SEARCH_WAITS_NOTE,
  SKIP_KIND,
  type AddressSearchResult,
  type FoundVia,
} from "./addresses";
import { findCandidates as findWith, type Finding } from "./address-finding";
import { callTool } from "./ai";
import { recordCompetitorEvent } from "./analytics";
import { ACTIVE_SCAN_STATUSES, isAddressKind, type AddressKind } from "./config";
import { fetchPlain } from "./fetcher";
import { contentHash } from "./html";
import { modelFor, thinkingFor } from "./models";
import { isPublicWebsite } from "./netguard";
import { MAX_PAGE_CHARS } from "./pages";
import { aiStepEnabled, getGlobalScanSettings, noteStoredChars, testAiAnswers } from "./settings";
import { InvalidUrlError, normalizeWebsite, pageKey } from "./url";

/**
 * The search for a company's OTHER ADDRESSES, and the two things a PM does with them — add one, remove one
 * (Website Scanning, "Other addresses of a company"). The rules are addresses.ts; getting from the company's site
 * to the candidates is address-finding.ts; this is the database side and PMOS AI.
 *
 * When it runs: with every scan of a company's main website — so also when a competitor or the organization's own
 * site is added, because adding queues a first scan (companies add a help center later, so every scan looks again).
 *
 * Who requests the company's site follows the scan lanes (addresses.ts searchLane; Website Scanning PRD: remote
 * scanning has a global on/off, default OFF, and when off every scan goes to the local lane):
 *   - the scan station read the main website and handed in what the search needs with its scan (the route
 *     local/scans/<id>/addresses): the search runs from that report and requests nothing;
 *   - no report, remote scanning ON: the server requests the site itself — when the company is added and at the
 *     end of a scan. A site that refuses the server is handed to the station by the scan lanes, and that scan
 *     brings the report;
 *   - no report, remote scanning OFF: the server requests NOTHING from the company's site. The search waits for
 *     the station's next scan of the main website.
 *
 * What it does with the material: the links of the home page (1); the addresses of /llms.txt, which is also stored
 * as a page of the website source for the map step (2); the common names in front of the domain and one made-up
 * name, keeping the guesses that prove something (3); leave out what the company already has and what a PM removed;
 * ask PMOS AI what each new address is (4); every address it names a help center, developer docs or release notes
 * becomes a source of the company and its first scan is queued at once, like an onboarding scan. No approval step:
 * PM-OS gives results, the team edits them.
 *
 * It never blocks anything: a search that fails — a site that does not answer, PMOS AI without capacity, an answer
 * with a code outside the closed set — records "could not decide", adds nothing and is tried again after the next
 * scan of the website. It never fails the add of a competitor and never changes how a scan ended.
 *
 * Security: when the server requests, every address is checked with the public-address guard (netguard.ts) before
 * anything is fetched from it, and is fetched with the scanner's own fetcher — its timeouts, its user agent, its
 * redirect guard. The station runs the same guard on its own machine (scripts/pmos-local-scan/addresses.mjs).
 *
 * Nothing here may import next/headers: the scanner CLI runs it (`--own-site`, and at the end of a scan).
 */

export type { Finding } from "./address-finding";

/**
 * Steps 1–3 for one site, requested by THE SERVER (address-finding.ts findCandidates with the scanner's fetcher and
 * the public-address guard). Only searchAddresses calls it, and only in the "server" lane — remote scanning ON.
 */
export function findCandidates(site: { url: string; host: string }, home: { html: string; finalUrl: string } | null, token: string = randomBytes(4).toString("hex")): Promise<Finding> {
  return findWith(site, home, token, { fetch: fetchPlain, isPublic: isPublicWebsite });
}

/**
 * The site's /llms.txt as ONE stored page of the website source, refreshed by every search: the map step reads it
 * (analysis/plan.ts). It is never a page of the reading plan and never crawled — the scanner's own page list does
 * not take ".txt" addresses — so the station's list of pages is not disturbed. A changed text replaces the old
 * one; a site that no longer has the file gets the page marked removed.
 */
export async function storeLlmsTxt(workspaceId: string, source: { id: string; url: string }, llms: Finding["llms"]): Promise<"written" | "unchanged" | "removed" | "none"> {
  if (llms === null) return "none";
  const url = pageKey(new URL("/llms.txt", source.url), source.url);
  const page = await db.sourcePage.findUnique({ where: { sourceId_url: { sourceId: source.id, url } }, select: { id: true, hash: true, text: true, chars: true, state: true } });
  const now = new Date();
  if (llms === "gone") {
    if (!page || page.state === "removed") return "none";
    await db.sourcePage.update({ where: { id: page.id }, data: { state: "removed", removedAt: now, text: null } });
    if (page.text != null) noteStoredChars(-page.chars);
    return "removed";
  }
  const text = llms.text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_PAGE_CHARS);
  const hash = contentHash(text);
  if (!page) {
    await db.sourcePage.create({ data: { workspaceId, sourceId: source.id, url, title: "llms.txt", kind: "page", hash, text, chars: text.length, state: "present", discoveredVia: "discovery", lastReadAt: now } });
    noteStoredChars(text.length);
    return "written";
  }
  if (page.hash === hash && page.text === text && page.state === "present") return "unchanged";
  await db.sourcePage.update({ where: { id: page.id }, data: { title: "llms.txt", hash, text, chars: text.length, state: "present", removedAt: null, notFoundStreak: 0, lastReadAt: now, ...(page.hash !== hash ? { changedAt: now } : {}) } });
  noteStoredChars(text.length - (page.text == null ? 0 : page.chars));
  return "written";
}

export type SearchOutcome =
  | { skipped: "no_company" | "running" }
  | { status: "done" | "undecided"; candidates: number; added: Array<{ sourceId: string; kind: AddressKind; url: string; via: FoundVia }>; alreadyThere: number; removedByPm: number; note: string };

/** One address per site per company (addresses.ts knownAddresses — a removed one counts): look, then create, under a lock held to the end of the transaction. */
async function createAddressSource(
  competitor: { id: string; workspaceId: string; host: string },
  address: { url: string; host: string; kind: AddressKind; foundVia: string; foundText: string | null },
): Promise<{ id: string } | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`competitor-sources:${competitor.id}`}))`;
    const sources = await tx.competitorSource.findMany({ where: { competitorId: competitor.id } });
    if (knownAddresses(sources, competitor.host).some((k) => k.host === address.host)) return null;
    return tx.competitorSource.create({
      data: { workspaceId: competitor.workspaceId, competitorId: competitor.id, type: address.kind, url: address.url, foundVia: address.foundVia, foundText: address.foundText },
      select: { id: true },
    });
  });
}

/** Queue a new address's first scan, like an onboarding scan. A scan that cannot be queued never undoes the add. */
async function scanAddress(competitor: { id: string; workspaceId: string }, sourceId: string, kind: AddressKind, userId: string | null): Promise<void> {
  try {
    // Loaded here: scan.ts imports the analysis engine, and the engine's plan imports this folder.
    const { createAndRouteScan } = await import("./scan");
    await createAndRouteScan(competitor.workspaceId, competitor.id, "onboarding", userId, kind, sourceId);
  } catch (e) {
    console.error("[competitors] the first scan of a new address failed to start", sourceId, e);
  }
}

/**
 * Take a company's search: one at a time per company. Returns the moment of the claim, or null when a search of
 * the company is working (one that stopped reporting SEARCH_STALE_MS ago is taken over).
 *
 * `takeOver`: the claim is taken whatever is working — for the scan station's report, which is the newest thing
 * known about the company's site and comes once per scan. A search that was working finds its claim gone when it
 * ends and stores no result (the sources it added stay: one address per site per company, under a lock).
 */
export async function claimAddressSearch(competitorId: string, takeOver = false): Promise<Date | null> {
  const at = new Date();
  const claim = await db.competitor.updateMany({
    where: { id: competitorId, ...(takeOver ? {} : { OR: [{ addressSearchStartedAt: null }, { addressSearchStartedAt: { lt: new Date(at.getTime() - SEARCH_STALE_MS) } }] }) },
    data: { addressSearchStartedAt: at },
  });
  return claim.count ? at : null;
}

/**
 * Search one company's other addresses (see the head of this file). One search per company at a time: a second
 * request while one works is skipped. Never throws.
 */
export async function searchAddresses(
  competitorId: string,
  opts: {
    /** "added" = the company was just added; "scan" = a scan of its website ended; "manual" = asked by hand (the scanner CLI `--addresses`). */
    trigger: "added" | "scan" | "manual";
    userId?: string | null;
    /** The home page, when the caller already fetched it — used only when the server requests the site itself (remote scanning ON). */
    home?: { html: string; finalUrl: string } | null;
    /**
     * What the scan station handed in with its scan of the company's main website, already turned into candidates
     * (address-finding.ts assembleFinding): the search runs from it and requests nothing from the site. `scanId` is
     * that scan; `note` says what the station could not do (it stopped asking after a slow-down answer).
     */
    station?: { finding: Finding; scanId: string; note?: string } | null;
    /** The caller already took the company's search (claimAddressSearch) — a route does, so its answer already says "looking". */
    claimedAt?: Date | null;
  },
): Promise<SearchOutcome> {
  const userId = opts.userId ?? null;
  let claimedAt: Date | null = null;
  try {
    const competitor = await db.competitor.findUnique({ where: { id: competitorId }, include: { sources: true } });
    if (!competitor || competitor.deletedAt) return { skipped: "no_company" };
    claimedAt = opts.claimedAt ?? (await claimAddressSearch(competitorId));
    if (!claimedAt) return { skipped: "running" };

    const website = competitor.sources.find((s) => s.type === "website") ?? null;
    const site = { url: website?.url ?? competitor.websiteUrl, host: competitor.host };
    let result: Extract<SearchOutcome, { status: string }> = { status: "done", candidates: 0, added: [], alreadyThere: 0, removedByPm: 0, note: "" };
    let finding: Finding | null = null;
    let tokens = 0;
    // For the internal alert of an undecided result (address-alert.ts): the candidates PMOS AI was to judge, and whether the test knob kept it off.
    let alertCandidates: Array<{ url: string; via: string }> = [];
    let aiOffByKnob = false;
    // The search follows the scan lanes (Website Scanning PRD; Daniel 2026-11-16): the station's report when there is
    // one; else the server's own requests, only while remote scanning is ON; else nothing is requested at all.
    const lane = searchLane({ remoteOn: (await getGlobalScanSettings()).remoteScanEnabled, stationReport: Boolean(opts.station) });
    if (lane === "wait") {
      // Remote scanning is OFF and no station report came: the search has not run. It is recorded as waiting — the
      // pages say "looking" while a scan of the main website is waiting or being read — unless an earlier search
      // already left a result: that one stands until the station's next scan brings a new one.
      const earlier = readAddressSearch(competitor.addressSearch);
      const waiting: AddressSearchResult = { status: "waiting", at: new Date().toISOString(), trigger: opts.trigger, candidates: 0, added: 0, note: SEARCH_WAITS_NOTE, scanId: null };
      await db.competitor.updateMany({
        where: { id: competitorId, addressSearchStartedAt: claimedAt },
        data: { addressSearchStartedAt: null, ...(earlier && earlier.status !== "waiting" ? {} : { addressSearch: waiting as unknown as Prisma.InputJsonValue }) },
      });
      claimedAt = null;
      return { status: "undecided", candidates: 0, added: [], alreadyThere: 0, removedByPm: 0, note: SEARCH_WAITS_NOTE };
    }
    try {
      finding = opts.station ? opts.station.finding : await findCandidates(site, opts.home ?? null);
      if (website) await storeLlmsTxt(competitor.workspaceId, website, finding.llms);
      const screened = screenCandidates(finding.candidates, knownAddresses(competitor.sources, competitor.host));
      result = { ...result, candidates: screened.fresh.length, alreadyThere: screened.alreadyThere.length, removedByPm: screened.removedByPm.length };
      alertCandidates = screened.fresh.map((c) => ({ url: c.url, via: c.via }));
      if (screened.fresh.length) {
        // 4. PMOS AI says what each new address is. Closed sets; an unusable answer adds nothing.
        const entries = pickEntries(screened.fresh);
        const codes = entries.map((e) => e.code);
        const answers = await testAiAnswers(competitorId);
        // TEST KNOB (COMPETITORS_AI=off): nothing automatic reaches a model — only a search asked by hand, or one whose answer a test injected.
        if (!answers && !aiStepEnabled() && opts.trigger !== "manual") {
          aiOffByKnob = true;
          result = { ...result, status: "undecided", note: "PMOS AI is switched off (test knob): the candidates were not judged" };
        } else {
          const r = await callTool<Record<string, unknown>>(ADDRESS_PICK_SYSTEM_PROMPT, "", renderAddressPick({ name: competitor.name, site: site.url }, entries), addressPickTool(codes), {
            model: modelFor("read"), maxTokens: ADDRESS_PICK_MAX_TOKENS, thinking: thinkingFor("read"), injected: answers ? injectedAddressPick(answers.addresses, entries) : undefined,
          });
          tokens = r.usage.input + r.usage.output;
          const parsed = parseAddressPick(r.value, codes);
          if (parsed.problems.length) {
            result = { ...result, status: "undecided", note: `PMOS AI's answer is unusable: ${parsed.problems.slice(0, 3).join("; ")}` };
          } else {
            for (const e of entries) {
              const kind = parsed.picks.get(e.code);
              if (!kind || kind === SKIP_KIND) continue;
              const c = e.candidate;
              const source = await createAddressSource(competitor, { url: c.url, host: c.host, kind, foundVia: c.via, foundText: c.text || null });
              if (!source) continue;
              result.added.push({ sourceId: source.id, kind, url: c.url, via: c.via });
              await scanAddress(competitor, source.id, kind, userId);
            }
            if (parsed.undecided.length) result = { ...result, note: `PMOS AI left ${parsed.undecided.length} address${parsed.undecided.length === 1 ? "" : "es"} unanswered — asked again by the next search` };
          }
        }
      }
    } catch (e) {
      // A site that does not answer, PMOS AI without capacity, anything else: nothing is added, the next search tries again.
      result = { ...result, status: "undecided", note: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300) };
      console.error("[competitors] the search for other addresses could not decide", competitorId, e);
    }
    if (opts.station?.note) result = { ...result, note: [result.note, opts.station.note].filter(Boolean).join(" · ").slice(0, 300) };

    // An undecided result is PM-OS's to look at, not the customer's: one alert email per company and set of candidates.
    const alert = { status: result.status, aiOffByKnob, key: undecidedAlertKey(alertCandidates.map((c) => c.url)), earlierKey: readAddressSearch(competitor.addressSearch)?.alertedKey ?? null };
    const sent = shouldAlertUndecided(alert) ? await sendUndecidedAlert({ workspaceId: competitor.workspaceId, competitorId, company: competitor.name, website: site.url, candidates: alertCandidates, note: result.note }) : false;
    const alertedKey = alertedKeyAfter({ ...alert, sent });
    const stored: AddressSearchResult = { status: result.status, at: new Date().toISOString(), trigger: opts.trigger, candidates: result.candidates, added: result.added.length, note: result.note, scanId: opts.station?.scanId ?? null, ...(alertedKey ? { alertedKey } : {}) };
    await db.competitor.updateMany({ where: { id: competitorId, addressSearchStartedAt: claimedAt }, data: { addressSearchStartedAt: null, addressSearch: stored as unknown as Prisma.InputJsonValue } });
    claimedAt = null;
    const kinds = new Map<string, number>();
    for (const a of result.added) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    await recordCompetitorEvent(competitor.workspaceId, userId, "cmp_sources_found", {
      competitorId, own: competitor.isOwn, trigger: opts.trigger, lane, outcome: result.status,
      found: finding?.candidates.length ?? 0, byLink: finding?.byMethod.link ?? 0, byLlms: finding?.byMethod.llms ?? 0, byGuess: finding?.byMethod.guess ?? 0, overLimit: finding?.dropped ?? 0,
      alreadyThere: result.alreadyThere, removedByPm: result.removedByPm, asked: result.candidates, chosen: result.added.length,
      kinds: [...kinds.entries()].map(([k, n]) => `${k}:${n}`).join(","), llmsTxt: finding?.llms && finding.llms !== "gone" ? true : false, homeUnread: Boolean(finding?.homeUnread), tokens,
    });
    return result;
  } catch (e) {
    console.error("[competitors] the search for other addresses failed", competitorId, e);
    if (claimedAt) await db.competitor.updateMany({ where: { id: competitorId, addressSearchStartedAt: claimedAt }, data: { addressSearchStartedAt: null } }).catch(() => undefined);
    return { status: "undecided", candidates: 0, added: [], alreadyThere: 0, removedByPm: 0, note: "the search failed" };
  }
}

// ————— A PM adds an address, or removes one —————

export type AddAddressResult = { sourceId: string; restored: boolean } | { error: "invalid" | "private" | "kind" | "main_site" | "exists" | "unreachable" };

/**
 * A PM adds an address by hand: a well-formed public web address, refused when it is the company's main site or an
 * address the company already has. An address a PM removed earlier comes back under the kind given now, with the
 * pages it had. Its first scan is queued at once.
 *
 * Must it answer? That follows the scan lanes (addresses.ts manualAddressMustAnswer). Remote scanning ON: the
 * server asks it once and refuses an address that does not answer (bot protection counts as answering). Remote
 * scanning OFF: the server requests nothing from it — the address is taken as it is, and its first scan, read by
 * the station, says if it does not answer.
 */
export async function addAddress(competitor: { id: string; workspaceId: string; host: string; isOwn: boolean }, input: { address: string; kind: unknown }, userId: string | null): Promise<AddAddressResult> {
  if (!isAddressKind(input.kind)) return { error: "kind" };
  let normalized: { url: string; host: string };
  try {
    normalized = normalizeWebsite(input.address);
  } catch (e) {
    return { error: e instanceof InvalidUrlError && e.reason === "private" ? "private" : "invalid" };
  }
  const sources = await db.competitorSource.findMany({ where: { competitorId: competitor.id }, orderBy: { createdAt: "asc" } });
  const checked = checkManualAddress(normalized, input.kind, competitor.host, sources);
  if ("error" in checked) return checked;
  const { site, kind, removed } = checked;
  // The name must resolve to public addresses only (a name lookup — nothing is requested from the site).
  if (!(await isPublicWebsite(site.url))) return { error: "private" };
  if (manualAddressMustAnswer((await getGlobalScanSettings()).remoteScanEnabled)) {
    const probe = await fetchPlain(site.url);
    if (probe.status === 0) return { error: "unreachable" };
  }

  let sourceId: string;
  if (removed) {
    await db.competitorSource.update({ where: { id: removed.id }, data: { type: kind, url: site.url, removedAt: null, removedById: null, foundVia: "manual", foundText: null, lastStatus: "never", lastError: null } });
    sourceId = removed.id;
  } else {
    const created = await createAddressSource(competitor, { url: site.url, host: site.host, kind, foundVia: "manual", foundText: null });
    if (!created) return { error: "exists" };
    sourceId = created.id;
  }
  await recordCompetitorEvent(competitor.workspaceId, userId, "cmp_source_added", { competitorId: competitor.id, own: competitor.isOwn, sourceId, kind, via: "manual", restored: Boolean(removed) });
  await scanAddress(competitor, sourceId, kind, userId);
  return { sourceId, restored: Boolean(removed) };
}

export type RemoveAddressResult = { ok: true } | { error: "not_found" | "scan_running" };

/**
 * A PM removes an address: it is never scanned again, leaves every list, and a later search never adds it back —
 * the row stays as that memory. Its waiting scans are cancelled; a scan that is reading it right now refuses the
 * removal (as removing a competitor does). Its pages leave the current picture at once (marked removed, text
 * dropped, hash kept), and an analysis is queued so that what they said leaves the table too.
 */
export async function removeAddress(competitor: { id: string; workspaceId: string; host: string; isOwn: boolean }, sourceId: string, userId: string | null): Promise<RemoveAddressResult> {
  const source = await db.competitorSource.findFirst({ where: { id: sourceId, competitorId: competitor.id } });
  if (!source || !isScannedAddress(source, competitor.host)) return { error: "not_found" };
  const running = await db.competitorScan.findFirst({ where: { sourceId, status: "running" }, select: { id: true } });
  if (running) return { error: "scan_running" };
  const at = new Date();
  const waiting = await db.competitorScan.findMany({ where: { sourceId, status: { in: [...ACTIVE_SCAN_STATUSES] } }, select: { id: true, runId: true } });
  const pages = await db.sourcePage.aggregate({ where: { sourceId, state: { not: "removed" }, text: { not: null } }, _sum: { chars: true }, _count: true });
  await db.$transaction([
    db.localScanRequest.updateMany({ where: { sourceId, state: { in: ["waiting", "running"] } }, data: { state: "cancelled", finishedAt: at } }),
    db.competitorScan.updateMany({ where: { id: { in: waiting.map((s) => s.id) } }, data: { status: "cancelled", finishedAt: at, badge: null, error: "the address was removed" } }),
    db.competitorSource.update({ where: { id: sourceId }, data: { removedAt: at, removedById: userId, lastStatus: "never", lastError: null } }),
    db.sourcePage.updateMany({ where: { sourceId, state: { not: "removed" } }, data: { state: "removed", removedAt: at, text: null, previousText: null, previousHash: null } }),
  ]);
  noteStoredChars(-(pages._sum.chars ?? 0));
  await recordCompetitorEvent(competitor.workspaceId, userId, "cmp_source_removed", { competitorId: competitor.id, own: competitor.isOwn, sourceId, kind: source.type, foundVia: source.foundVia ?? "unknown", pages: pages._count, cancelledScans: waiting.length });
  // The email of a Scan run may be due now that its scan was cancelled.
  const inRuns = waiting.filter((s) => s.runId).map((s) => s.id);
  if (inRuns.length) {
    const { notifyRunsOfScans } = await import("./runs");
    await notifyRunsOfScans(inRuns);
  }
  if (pages._count > 0) {
    try {
      const { queueAnalysis } = await import("./analysis/engine");
      await queueAnalysis(competitor.workspaceId, competitor.id, "sources", { startedById: userId });
    } catch (e) {
      console.error("[competitors] the analysis after an address was removed could not be queued", competitor.id, e);
    }
  }
  return { ok: true };
}
