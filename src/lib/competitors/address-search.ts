import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  ADDRESS_PICK_MAX_TOKENS,
  ADDRESS_PICK_SYSTEM_PROMPT,
  addressPickTool,
  addressRefusal,
  answeredPage,
  controlAddress,
  guessCandidates,
  guessVerdict,
  injectedAddressPick,
  isScannedAddress,
  knownAddresses,
  linkCandidates,
  linksWithText,
  llmsCandidates,
  llmsTxtLinks,
  looksLikeLlmsTxt,
  MAX_CANDIDATES,
  mergeCandidates,
  OPENING_CHARS,
  parseAddressPick,
  pickEntries,
  renderAddressPick,
  screenCandidates,
  SEARCH_STALE_MS,
  siteAddressOf,
  SKIP_KIND,
  type AddressSearchResult,
  type Answer,
  type Candidate,
  type FoundVia,
  type RawCandidate,
} from "./addresses";
import { callTool } from "./ai";
import { recordCompetitorEvent } from "./analytics";
import { ACTIVE_SCAN_STATUSES, isAddressKind, type AddressKind } from "./config";
import { fetchPlain, type FetchedPage } from "./fetcher";
import { contentHash, htmlToText, titleOf } from "./html";
import { modelFor, thinkingFor } from "./models";
import { isPublicWebsite } from "./netguard";
import { MAX_PAGE_CHARS } from "./pages";
import { aiStepEnabled, noteStoredChars, testAiAnswers } from "./settings";
import { InvalidUrlError, normalizeWebsite, pageKey, siteHost } from "./url";

/**
 * The search for a company's OTHER ADDRESSES, and the two things a PM does with them — add one, remove one
 * (Website Scanning, "Other addresses of a company"). The rules are addresses.ts; this is the network and the
 * database side.
 *
 * When it runs: when a competitor is added, when the organization's own site is added, and again at the end of
 * every scan of the main website (companies add a help center later). Always server-side: the station is not
 * involved in the finding.
 *
 * What it does: fetch the home page, take its links (1); fetch /llms.txt, store it as a page of the website source
 * for the map step, take its addresses (2); ask the common names in front of the domain and one made-up name, keep
 * the guesses that prove something (3); leave out what the company already has and what a PM removed; ask PMOS AI
 * what each new address is (4); every address it names a help center, developer docs or release notes becomes a
 * source of the company and its first scan is queued at once, like an onboarding scan. No approval step: PM-OS
 * gives results, the team edits them.
 *
 * It never blocks anything: a search that fails — a site that does not answer, PMOS AI without capacity, an answer
 * with a code outside the closed set — records "could not decide", adds nothing and is tried again after the next
 * scan of the website. It never fails the add of a competitor and never changes how a scan ended.
 *
 * Security: every address is checked with the public-address guard (netguard.ts) before anything is fetched from
 * it, and is fetched with the scanner's own fetcher — its timeouts, its user agent, its redirect guard.
 *
 * Nothing here may import next/headers: the scanner CLI runs it (`--own-site`, and at the end of a scan).
 */

/** Addresses fetched at once during a search. */
const FETCHES_AT_ONCE = 4;

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCHES_AT_ONCE, items.length) }, worker));
  return out;
}

const NO_ANSWER = (url: string, error: string): Answer => ({ url, status: 0, error, finalUrl: url, title: "", text: "" });

function answerOf(url: string, page: FetchedPage): Answer {
  return { url, status: page.status, error: page.binary ? "binary" : page.error ?? null, finalUrl: page.finalUrl || url, title: page.html ? titleOf(page.html) : "", text: page.text };
}

/** Ask one address: the public-address guard first, then one plain GET (redirects are followed to public hosts only). */
async function ask(url: string): Promise<Answer> {
  if (!(await isPublicWebsite(url))) return NO_ANSWER(url, "private");
  return answerOf(url, await fetchPlain(url));
}

export interface Finding {
  /** The addresses that may be worth scanning: they answer (or the company itself links to them), one per site. */
  candidates: Candidate[];
  /** Candidates left out because there were more than MAX_CANDIDATES. */
  dropped: number;
  /** How many candidates each way found, before they were merged. */
  byMethod: Record<FoundVia, number>;
  /** The site's llms.txt: its text, "gone" when the site answers not-found for it, null when it could not be read this time. */
  llms: { url: string; text: string } | "gone" | null;
  /** The home page could not be read: no links were taken. */
  homeUnread: string | null;
}

/**
 * Steps 1–3 for one site: what the network says, no database. `home` is the home page when the caller already
 * fetched it (the add route probes the site); `token` names the made-up host of the verification.
 */
export async function findCandidates(site: { url: string; host: string }, home: { html: string; finalUrl: string } | null, token: string = randomBytes(4).toString("hex")): Promise<Finding> {
  // 1. The company's own links.
  let homePage = home;
  let homeUnread: string | null = null;
  let homeAnswer: Answer | null = null;
  if (!homePage) {
    if (await isPublicWebsite(site.url)) {
      const page = await fetchPlain(site.url, { host: site.host });
      homeAnswer = answerOf(site.url, page);
      if (page.html && !page.error) homePage = { html: page.html, finalUrl: page.finalUrl || site.url };
      else homeUnread = page.errorDetail ?? page.error ?? "no answer";
    } else {
      homeUnread = "not a public address";
    }
  }
  const fromLinks = homePage ? linkCandidates(linksWithText(homePage.html, homePage.finalUrl), site.host) : [];

  // 2. llms.txt — redirects stay inside the site: another site's file says nothing about this one.
  let llms: Finding["llms"] = null;
  let fromLlms: RawCandidate[] = [];
  const llmsUrl = new URL("/llms.txt", site.url).href;
  if (await isPublicWebsite(llmsUrl)) {
    const page = await fetchPlain(llmsUrl, { host: site.host });
    if (page.status >= 200 && page.status < 300 && !page.binary && !page.error && looksLikeLlmsTxt(page.html)) {
      llms = { url: llmsUrl, text: page.html };
      fromLlms = llmsCandidates(llmsTxtLinks(page.html, llmsUrl), site.host);
    } else if (page.error === "notfound" || (page.status >= 200 && page.status < 300 && !page.binary)) {
      // Not found, or the site's own page served for an address it does not have: there is no llms.txt.
      llms = "gone";
    }
  }

  // What the company itself named is asked once each: where does it land, what does it show.
  const named = mergeCandidates([...fromLinks, ...fromLlms].map((c) => ({ ...c, title: "", opening: "" })), MAX_CANDIDATES);
  const namedAnswers = await inBatches(named.candidates, (c) => ask(c.url));
  const found: Array<RawCandidate & { title: string; opening: string }> = [];
  named.candidates.forEach((c, i) => {
    const a = namedAnswers[i];
    // The company links to it, so it stays a candidate unless the address is plainly not there or leads back.
    if (a.status === 0 || a.error === "notfound" || a.error === "private") return;
    let landed: URL;
    try {
      landed = new URL(a.finalUrl);
    } catch {
      return;
    }
    if (addressRefusal(landed, site.host)) return;
    const page = answeredPage(a);
    found.push({ ...c, url: siteAddressOf(landed), host: siteHost(landed), title: page ? a.title : "", opening: page ? a.text.slice(0, OPENING_CHARS) : "" });
  });

  // 3. Common names in front of the domain, verified against a made-up name. A name the company already named is not guessed.
  const namedHosts = new Set([...named.candidates.map((c) => c.host), ...found.map((c) => c.host)]);
  const guesses = guessCandidates(site).filter((g) => !namedHosts.has(g.host));
  let guessed = 0;
  if (guesses.length) {
    const [control, ...answers] = await inBatches([controlAddress(site, token), ...guesses.map((g) => g.url)], ask);
    // The home page as an answer, for "the page that answers is not the main site again".
    if (!homeAnswer && homePage) homeAnswer = { url: site.url, status: 200, error: null, finalUrl: homePage.finalUrl, title: titleOf(homePage.html), text: htmlToText(homePage.html) };
    guesses.forEach((g, i) => {
      const verdict = guessVerdict(answers[i], control, { host: site.host, home: homeAnswer });
      if (!verdict.counts) return;
      guessed++;
      found.push({ ...g, url: verdict.url, host: verdict.host, title: answers[i].title, opening: answers[i].text.slice(0, OPENING_CHARS) });
    });
  }

  const merged = mergeCandidates(found, MAX_CANDIDATES);
  return {
    candidates: merged.candidates,
    dropped: named.dropped + merged.dropped,
    byMethod: { link: fromLinks.length, llms: fromLlms.length, guess: guessed },
    llms,
    homeUnread,
  };
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
 */
export async function claimAddressSearch(competitorId: string): Promise<Date | null> {
  const at = new Date();
  const claim = await db.competitor.updateMany({
    where: { id: competitorId, OR: [{ addressSearchStartedAt: null }, { addressSearchStartedAt: { lt: new Date(at.getTime() - SEARCH_STALE_MS) } }] },
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
    /** The home page, when the caller already fetched it. */
    home?: { html: string; finalUrl: string } | null;
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
    try {
      finding = await findCandidates(site, opts.home ?? null);
      if (website) await storeLlmsTxt(competitor.workspaceId, website, finding.llms);
      const screened = screenCandidates(finding.candidates, knownAddresses(competitor.sources, competitor.host));
      result = { ...result, candidates: screened.fresh.length, alreadyThere: screened.alreadyThere.length, removedByPm: screened.removedByPm.length };
      if (screened.fresh.length) {
        // 4. PMOS AI says what each new address is. Closed sets; an unusable answer adds nothing.
        const entries = pickEntries(screened.fresh);
        const codes = entries.map((e) => e.code);
        const answers = await testAiAnswers(competitorId);
        // TEST KNOB (COMPETITORS_AI=off): nothing automatic reaches a model — only a search asked by hand, or one whose answer a test injected.
        if (!answers && !aiStepEnabled() && opts.trigger !== "manual") {
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

    const stored: AddressSearchResult = { status: result.status, at: new Date().toISOString(), trigger: opts.trigger, candidates: result.candidates, added: result.added.length, note: result.note };
    await db.competitor.updateMany({ where: { id: competitorId, addressSearchStartedAt: claimedAt }, data: { addressSearchStartedAt: null, addressSearch: stored as unknown as Prisma.InputJsonValue } });
    claimedAt = null;
    const kinds = new Map<string, number>();
    for (const a of result.added) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    await recordCompetitorEvent(competitor.workspaceId, userId, "cmp_sources_found", {
      competitorId, own: competitor.isOwn, trigger: opts.trigger, outcome: result.status,
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
 * A PM adds an address by hand: validated like a website (a public site that answers — bot protection counts as
 * answering), refused when it is the company's main site or an address the company already has. An address a PM
 * removed earlier comes back under the kind given now, with the pages it had. Its first scan is queued at once.
 */
export async function addAddress(competitor: { id: string; workspaceId: string; host: string; isOwn: boolean }, input: { address: string; kind: unknown }, userId: string | null): Promise<AddAddressResult> {
  if (!isAddressKind(input.kind)) return { error: "kind" };
  const kind = input.kind;
  let site: { url: string; host: string };
  try {
    site = normalizeWebsite(input.address);
  } catch (e) {
    return { error: e instanceof InvalidUrlError && e.reason === "private" ? "private" : "invalid" };
  }
  if (site.host === competitor.host) return { error: "main_site" };
  const sources = await db.competitorSource.findMany({ where: { competitorId: competitor.id }, orderBy: { createdAt: "asc" } });
  // Its other addresses on this site — never a source a collector fed (addresses.ts knownAddresses).
  const same = sources.filter((s) => isScannedAddress({ ...s, removedAt: null }, competitor.host) && siteHost(new URL(s.url)) === site.host);
  if (same.some((s) => !s.removedAt)) return { error: "exists" };
  if (!(await isPublicWebsite(site.url))) return { error: "private" };
  const probe = await fetchPlain(site.url);
  if (probe.status === 0) return { error: "unreachable" };

  const removed = same.find((s) => s.removedAt);
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
