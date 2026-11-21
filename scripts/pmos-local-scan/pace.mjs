/**
 * PM-OS local scan station — the pace of one scan and the order of its pages (Daniel 2026-11-21).
 *
 * Found on KELA's own site: it answers "slow down" (429) after about 25 requests in a minute. The station stopped the
 * scan there, and the next scan read the 13 pages PM-OS already had before anything new — one new page per scan, 861
 * waiting, for ever. The rules, in one place, with no I/O so they can be tested (tests/unit/competitors-station-pace.test.ts):
 *
 *   - a site that says "slow down" is waited for, not left: the station waits (what the site asks in Retry-After, at
 *     least 1 minute; then 2, then 5 when it says it again on the same page), reads the same page again, and goes on
 *     with a longer pause between pages for the rest of the scan. After the third wait in a row without the page, that
 *     page goes to the end of the line, once, and the scan goes on with the next page: one page that always answers
 *     "slow down" must not cost the rest of the site (KELA's /es, 2026-11-21: 600 pages left behind it). When the very
 *     next page ends the same way, the site is throttling everything and the scan stops as before: the page is "not
 *     read — the site asked us to slow down", the rest is "not attempted" and the next scan continues from them;
 *   - no wait is longer than 5 minutes: PM-OS takes a scan that is silent for 10 minutes for a dead one. A site that
 *     asks for more than that ends the scan now;
 *   - pages PM-OS has never read come first, pages it already has come after them. The home page is always the very
 *     first (its links and the search for the company's other addresses start from it). A scan that is cut short then
 *     always brought something new.
 *
 * The poller (poller.mjs) calls these; it does the waiting and the reading.
 */

/** The waits after a "slow down" answer, in a row, on one page: 1, 2, 5 minutes. --slowdown-waits-ms changes them (tests). */
export const SLOWDOWN_WAITS_MS = [60_000, 120_000, 300_000];
/** No single wait is longer than this: PM-OS calls a scan that is silent for 10 minutes stale. */
export const MAX_SLOWDOWN_WAIT_MS = 300_000;
/** After a "slow down" the pause between pages is doubled, to at least this … */
export const MIN_SLOWED_PAUSE_MS = 5_000;
/** … and never beyond this. */
export const MAX_SLOWED_PAUSE_MS = 30_000;

/** Retry-After as milliseconds: seconds ("120") or an HTTP date. null when absent or unreadable. */
export function retryAfterMs(header, now = Date.now()) {
  const raw = String(header ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** The pause between pages after a "slow down": doubled, between 5 and 30 seconds. A pause of 0 (tests) stays 0. */
export function slowedPause(pauseMs) {
  if (!(pauseMs > 0)) return 0;
  return Math.min(Math.max(pauseMs * 2, MIN_SLOWED_PAUSE_MS), MAX_SLOWED_PAUSE_MS);
}

/**
 * What to do after a "slow down" answer.
 *   inARow        how many "slow down" answers this page has now had, this one included (1 = the first)
 *   retryAfter    what the site asked for, in ms, or null
 *   pauseMs       the pause between pages so far
 * Returns { stop: true } — hand the answer in and end the scan — or { stop: false, waitMs, pauseMs }: wait, read the
 * same page again, and use the new pause from here on.
 * @param {{ inARow: number, retryAfter?: number | null, pauseMs: number, waits?: number[] }} o
 * @returns {{ stop: true, waited: boolean, why: string } | { stop: false, waitMs: number, pauseMs: number }}
 */
export function afterSlowDown({ inARow, retryAfter = null, pauseMs, waits = SLOWDOWN_WAITS_MS }) {
  // `waited`: the page had its waits — the caller may move on to other pages before it gives the site up.
  if (inARow > waits.length) return { stop: true, waited: waits.length > 0, why: `the site said it ${inARow} times in a row` };
  if (retryAfter !== null && retryAfter > MAX_SLOWDOWN_WAIT_MS) return { stop: true, waited: false, why: `the site asked for ${Math.round(retryAfter / 60_000)} minutes` };
  const planned = waits[inARow - 1];
  return { stop: false, waitMs: Math.min(Math.max(planned, retryAfter ?? 0), MAX_SLOWDOWN_WAIT_MS), pauseMs: slowedPause(pauseMs) };
}

/**
 * The queue of one scan. Its first `fresh` entries are the front part: the home page and pages PM-OS has never read.
 * A page found on the way goes to the end of the front part when it is new, to the very end when PM-OS has it.
 * A scan starts with putBack(home): the home page is read first whether PM-OS has it or not.
 * @param {{ queue?: string[], fresh?: number, known?: string[] }} [o]
 */
export function makeQueue({ queue = [], fresh = 0, known = [] } = {}) {
  const has = new Set(known);
  const items = [...queue];
  let front = Math.min(Math.max(fresh, 0), items.length);
  return {
    get length() {
      return items.length;
    },
    get fresh() {
      return front;
    },
    list: () => [...items],
    /** The page that is read next, without taking it. */
    first: () => items[0],
    add(k) {
      if (has.has(k)) items.push(k);
      else items.splice(front++, 0, k);
    },
    next() {
      if (front > 0) front--;
      return items.shift();
    },
    /** The page goes to the very end: the site kept asking to slow down on it, so the other pages are read first. */
    toEnd(k) {
      items.push(k);
    },
    /** The page goes back to be read first (it was not read: the site asked to slow down, or the network dropped). */
    putBack(k) {
      items.unshift(k);
      front++;
    },
  };
}
