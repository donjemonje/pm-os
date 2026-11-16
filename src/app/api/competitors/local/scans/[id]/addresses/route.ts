import { after, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { stationStep } from "@/lib/competitors/address-finding";
import { claimAddressSearch, searchAddresses } from "@/lib/competitors/address-search";
import { stationSearchesWith } from "@/lib/competitors/addresses";
import { verifyScanToken } from "@/lib/competitors/local";
import type { LogLine } from "@/lib/competitors/scan";

type Params = { params: Promise<{ id: string }> };

/** The whole request: the home page (2 MB), /llms.txt and the start of every answer. Checked before the body is parsed. */
const MAX_BODY_BYTES = 30 * 1024 * 1024;

/**
 * POST — with its scan of a company's MAIN website the station brings what the search for the company's other
 * addresses needs (help center, developer docs, release notes): the search follows the scan lanes, so while the
 * station reads the site the server requests nothing from it (Website Scanning PRD; lib/competitors/addresses.ts
 * searchLane). Scan token as bearer. The station only fetches and reports; every rule stays here.
 *
 * Two calls per scan, right after the station handed the home page in:
 *
 *   1. { home: { url, finalUrl, html, plainHtml? }, llms: { status, finalUrl, xRobots, html, binary?, error? } | null }
 *      → { ask: string[] }   the exact addresses to ask, the made-up name first: what the company named (the links
 *      of its home page, the addresses of its llms.txt), the guessed names in front of its domain, one made-up name.
 *        home       the home page as the station handed it in (rendered with its browser where needed);
 *                   `plainHtml` is the plain answer when the page was rendered
 *        llms       what /llms.txt answered (redirects inside the site only); null when it was not asked
 *
 *   2. the same body plus { answers: [{ url, status, finalUrl, xRobots, html, binary?, error? }], stopped? }
 *      → { ok: true, candidates }   and the search runs from the report after the answer is sent: the pure rules
 *      (address-finding.ts assembleFinding — the same ones the server applies to its own requests), PMOS AI's pick,
 *      the new sources and their first scans (address-search.ts searchAddresses).
 *        answers    one per address asked: status 0 = no answer; `html` is the start of the body; `binary` = not
 *                   text; `error` only when there is no page ("timeout" | "other" | "private" | "notfound")
 *        stopped    "slowdown" when an address answered 429 and the station stopped asking
 *
 * The server keeps nothing between the two calls: the list of the first call is computed again in the second, and
 * an answer for an address that is not in it is ignored. Only a scan of a website source takes these calls (422
 * otherwise); a scan that ended answers 409, a cancelled one 410, like the page hand-in.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const tok = await verifyScanToken(req.headers.get("authorization"), id);
  if (!tok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (req.headers.get("content-length") == null) return NextResponse.json({ error: "Content-Length is required" }, { status: 411 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "request is larger than 30 MB" }, { status: 413 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const scan = await db.competitorScan.findUnique({
    where: { id },
    select: { status: true, trigger: true, startedById: true, log: true, source: { select: { type: true, url: true, competitor: { select: { id: true, host: true, deletedAt: true } } } } },
  });
  if (!scan) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (scan.source.competitor.deletedAt || scan.status === "cancelled") return NextResponse.json({ error: "The scan was cancelled" }, { status: 410 });
  if (scan.status !== "running" && scan.status !== "pending_local" && scan.status !== "queued") return NextResponse.json({ error: "The scan already ended" }, { status: 409 });
  if (!stationSearchesWith({ sourceType: scan.source.type })) return NextResponse.json({ error: "only a scan of a company's main website brings its other addresses" }, { status: 422 });

  const competitorId = scan.source.competitor.id;
  const site = { url: scan.source.url, host: scan.source.competitor.host };
  const step = stationStep(site, id, body);
  if ("error" in step) return NextResponse.json({ error: step.error }, { status: 400 });
  // 1. The station asks for its list.
  if (!("finding" in step)) {
    await db.competitorScan.update({ where: { id }, data: { heartbeatAt: new Date() } });
    return NextResponse.json({ ask: step.ask });
  }

  // 2. The station brought the answers: the candidates, then the search — after the answer is sent.
  const { ask, finding, answered } = step;
  const notAsked = ask.length - answered;
  const note = step.stopped === "slowdown" && notAsked > 0
    ? `an address answered "slow down" (429): ${notAsked} of ${ask.length} addresses were not asked — the next scan of the website looks again`
    : notAsked > 0 ? `${notAsked} of ${ask.length} addresses were not asked — the next scan of the website looks again` : "";
  const line: LogLine = {
    at: new Date().toISOString(),
    level: note ? "warn" : "info",
    msg: `Other addresses: the station handed in the home page's links, llms.txt (${finding.llms === null ? "not read" : finding.llms === "gone" ? "none" : "found"}) and ${answered} of ${ask.length} answers — ${finding.candidates.length} candidate${finding.candidates.length === 1 ? "" : "s"} (${finding.byMethod.link} by link, ${finding.byMethod.llms} by llms.txt, ${finding.byMethod.guess} by guess)${note ? `; ${note}` : ""}`,
  };
  const log = [...(Array.isArray(scan.log) ? (scan.log as unknown as LogLine[]) : []), line];
  await db.competitorScan.update({ where: { id }, data: { heartbeatAt: new Date(), log: log as unknown as Prisma.InputJsonValue } });

  // Taken before the answer: a scan that ends in the next second finds the search working and does not start its own.
  const claimedAt = await claimAddressSearch(competitorId).catch(() => null);
  const trigger = scan.trigger === "onboarding" ? "added" : "scan";
  const userId = scan.startedById;
  after(async () => {
    let claim = claimedAt;
    // Another search of this company is working (the one that started when it was added): wait for it, ten seconds at most.
    for (let i = 0; !claim && i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      claim = await claimAddressSearch(competitorId).catch(() => null);
    }
    if (!claim) {
      console.warn(`[competitors] scan ${id}: the station's report on other addresses was not used — another search of the company is working; the next scan of the website looks again`);
      return;
    }
    await searchAddresses(competitorId, { trigger, userId, station: { finding, scanId: id, note }, claimedAt: claim });
  });
  return NextResponse.json({ ok: true, candidates: finding.candidates.length });
}
