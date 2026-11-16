/**
 * PM-OS local scan station — which scans run now (Daniel 2026-11-16: "let's allow parallel scanning, up to a queue of 10").
 *
 * The rule, in one place, with no I/O so it can be tested (tests/unit/competitors-station-schedule.test.ts):
 *
 *   - the station reads up to MAX_PARALLEL sites at the same time (--max-parallel). 10 is a safety net for the Mac and
 *     for PM-OS, not a working limit: different sites have no reason to wait for each other;
 *   - never two scans of the same site together — the second waits for the first. The pause between pages (2 s) is what
 *     keeps a site from blocking us, and it only means something when one scan talks to that site;
 *   - scans the station cannot start yet wait in order: the ones it was reading when it last stopped first, then as
 *     PM-OS lists them (oldest request first). A scan held back by its site does not hold back the ones after it;
 *   - the Claude runner reads one site at a time whatever the limit says (one Chrome, one browser session).
 *
 * The poller (poller.mjs) calls pickNext() at the start and every time a scan ends or a check-in brings new scans.
 */

/** How many scans the station runs at the same time unless --max-parallel says otherwise. */
export const MAX_PARALLEL = 10;

/**
 * The site a scan talks to: the hostname without a leading "www.", plus a non-default port — the same rule the poller
 * and the server use for "inside the site". Subdomains are other sites (docs.acme.com is not acme.com).
 */
export function siteKey(siteUrl) {
  try {
    const u = new URL(siteUrl);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return String(siteUrl ?? "").trim().toLowerCase();
  }
}

/**
 * How many scans may run together with this runner.
 *   fetch   the asked number (--max-parallel), MAX_PARALLEL when it is missing or not a whole number of 1 or more;
 *   claude  always 1: Claude drives the one Chrome on this Mac through one extension session — two scans would fight
 *           over its tabs, and the runner keeps no saved place to tell them apart after a stop.
 */
export function parallelLimit(runner, asked) {
  if (runner === "claude") return 1;
  const n = Math.floor(Number(asked));
  return Number.isFinite(n) && n >= 1 ? n : MAX_PARALLEL;
}

/**
 * The station's waiting list, in the order scans will start: `firstIds` (the scans the station already holds — a saved
 * place, or an earlier turn in the list), in that order, then everything else as PM-OS listed it (oldest first).
 * A scan listed twice is one scan; `skipIds` (scans running or just handed in on this station) are left out.
 */
export function orderWaiting(waiting, firstIds = [], skipIds = []) {
  const skip = new Set(skipIds);
  const byId = new Map();
  for (const job of waiting ?? []) if (job && typeof job.scanId === "string" && !skip.has(job.scanId) && !byId.has(job.scanId)) byId.set(job.scanId, job);
  const out = [];
  for (const id of firstIds) {
    const job = byId.get(id);
    if (!job) continue;
    out.push(job);
    byId.delete(id);
  }
  return [...out, ...byId.values()];
}

/**
 * Which waiting scans start now.
 *   waiting      scans not started, in start order (orderWaiting)
 *   running      scans being read now — anything with a siteUrl
 *   maxParallel  parallelLimit()
 * Returns `start` (in order) and `held`: every scan that stays waiting, in order, with the reason —
 *   "site"   another scan of the same site is running, or is ahead of it in this very list;
 *   "limit"  maxParallel scans are running.
 */
export function pickNext(waiting, running, maxParallel) {
  const busy = new Set((running ?? []).map((r) => siteKey(r.siteUrl)));
  let slots = Math.max(0, maxParallel - (running ?? []).length);
  const start = [];
  const held = [];
  for (const job of waiting ?? []) {
    const site = siteKey(job.siteUrl);
    if (busy.has(site)) {
      held.push({ job, why: "site" });
      continue;
    }
    if (slots <= 0) {
      held.push({ job, why: "limit" });
      continue;
    }
    start.push(job);
    busy.add(site);
    slots--;
  }
  return { start, held };
}

/**
 * The scan fields of the status file (status.json, read by the menu bar icon) while at least one scan runs.
 *   running   the scans being read, oldest first: { scanId, competitor, siteUrl, pagesRead, startedAt, offline }
 *   waiting   how many scans this station still has to start
 * The fields the menu bar app has always read keep their meaning for the OLDEST running scan (competitor, site,
 * pagesRead, scanStartedAt) and `waiting` is still "scans not started yet". New: `running` (how many are being read)
 * and `scans` (one entry per running scan). One scan waiting for the network makes the station "offline".
 */
export function statusOf(running, waiting) {
  const first = running[0];
  const n = running.length;
  const offline = running.some((r) => r.offline);
  return {
    state: offline ? "offline" : "scanning",
    message: offline
      ? n === 1 ? "Network lost — the scan waits" : `Network lost — ${n} scans wait`
      : n === 1 ? `Scanning ${first.competitor}` : `Scanning ${n} sites: ${running.map((r) => r.competitor).join(", ")}`,
    competitor: first.competitor,
    site: first.siteUrl,
    pagesRead: first.pagesRead ?? 0,
    scanStartedAt: first.startedAt,
    waiting,
    running: n,
    scans: running.map((r) => ({ scanId: r.scanId, competitor: r.competitor, site: r.siteUrl, pagesRead: r.pagesRead ?? 0, startedAt: r.startedAt, state: r.offline ? "offline" : "scanning" })),
  };
}

/** The scan fields of the status file when nothing is being read. */
export const NO_SCAN = { competitor: null, site: null, pagesRead: null, scanStartedAt: null, waiting: 0, running: 0, scans: [] };
