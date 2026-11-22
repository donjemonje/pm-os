import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptLegacyPlace, clearPlace, LEGACY_FILE, loadPlace, loadPlaces, markStopped, placeFile, PLACES_DIR, savePlace } from "../../scripts/pmos-local-scan/places.mjs";
import { MAX_PARALLEL, NO_SCAN, orderWaiting, parallelLimit, pickNext, siteKey, statusOf } from "../../scripts/pmos-local-scan/schedule.mjs";

/**
 * The local scan station reads several sites at the same time (Daniel 2026-11-16: "let's allow parallel scanning, up
 * to a queue of 10"). The rule lives in scripts/pmos-local-scan/schedule.mjs, the saved places in places.mjs; the
 * poller only calls them.
 */

interface Job {
  scanId: string;
  siteUrl: string;
  competitorName: string;
}
const job = (scanId: string, siteUrl: string): Job => ({ scanId, siteUrl, competitorName: scanId.toUpperCase() });
const ids = (jobs: Job[]) => jobs.map((j) => j.scanId);
/** n scans of n different sites: s1 … sn. */
const sites = (n: number, from = 1): Job[] => Array.from({ length: n }, (_, i) => job(`s${from + i}`, `https://site${from + i}.example`));

describe("siteKey — what 'the same site' means", () => {
  it("www and the scheme do not make another site; the path does not either", () => {
    expect(siteKey("https://www.Acme.com/pricing")).toBe("acme.com");
    expect(siteKey("http://acme.com")).toBe("acme.com");
  });
  it("a subdomain is another site, and so is another port", () => {
    expect(siteKey("https://docs.acme.com")).toBe("docs.acme.com");
    expect(siteKey("http://127.0.0.1:4101")).toBe("127.0.0.1:4101");
    expect(siteKey("http://127.0.0.1:4102")).not.toBe(siteKey("http://127.0.0.1:4101"));
  });
  it("an address that is not a URL is its own site instead of an error", () => {
    expect(siteKey("not a url")).toBe("not a url");
  });
});

describe("parallelLimit — how many scans at the same time", () => {
  it("is 10 unless --max-parallel says otherwise", () => {
    expect(MAX_PARALLEL).toBe(10);
    expect(parallelLimit("fetch", undefined)).toBe(10);
    expect(parallelLimit("fetch", "4")).toBe(4);
    expect(parallelLimit("fetch", "25")).toBe(25);
  });
  it("a flag that is not a whole number of 1 or more falls back to 10", () => {
    for (const bad of ["0", "-3", "abc", ""]) expect(parallelLimit("fetch", bad)).toBe(10);
  });
  it("the Claude runner reads one site at a time whatever the flag says", () => {
    expect(parallelLimit("claude", undefined)).toBe(1);
    expect(parallelLimit("claude", "10")).toBe(1);
  });
});

describe("pickNext — which waiting scans start now", () => {
  it("nine different sites all start at once", () => {
    const { start, held } = pickNext(sites(9), [], 10);
    expect(ids(start)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
    expect(held).toEqual([]);
  });
  it("more than 10 waiting: the first 10 start, the rest wait their turn in order, held by the limit", () => {
    const { start, held } = pickNext(sites(13), [], 10);
    expect(ids(start)).toEqual(ids(sites(10)));
    expect(held.map((h: { job: Job; why: string }) => [h.job.scanId, h.why])).toEqual([["s11", "limit"], ["s12", "limit"], ["s13", "limit"]]);
  });
  it("counts the scans already running: 8 running, 4 waiting → 2 start", () => {
    const { start, held } = pickNext(sites(4, 21), sites(8), 10);
    expect(ids(start)).toEqual(["s21", "s22"]);
    expect(held.map((h: { why: string }) => h.why)).toEqual(["limit", "limit"]);
  });
  it("10 running: nothing starts", () => {
    const { start, held } = pickNext(sites(2, 21), sites(10), 10);
    expect(start).toEqual([]);
    expect(held.length).toBe(2);
  });
  it("never two scans of one site: the second waits for the running one (www and http are the same site)", () => {
    const running = [job("r1", "https://acme.com")];
    const { start, held } = pickNext([job("w1", "http://www.acme.com/"), job("w2", "https://other.example")], running, 10);
    expect(ids(start)).toEqual(["w2"]);
    expect(held.map((h: { job: Job; why: string }) => [h.job.scanId, h.why])).toEqual([["w1", "site"]]);
  });
  it("two waiting scans of one site: the older starts, the other waits behind it — and does not hold back the scans after it", () => {
    const { start, held } = pickNext([job("a1", "https://acme.com"), job("a2", "https://acme.com"), job("b1", "https://beta.example")], [], 10);
    expect(ids(start)).toEqual(["a1", "b1"]);
    expect(held.map((h: { job: Job; why: string }) => [h.job.scanId, h.why])).toEqual([["a2", "site"]]);
  });
  it("a subdomain is another site and runs next to the main site", () => {
    const { start } = pickNext([job("a", "https://acme.com"), job("d", "https://docs.acme.com")], [], 10);
    expect(ids(start)).toEqual(["a", "d"]);
  });
  it("a scan held by its site says so even when the limit is reached too", () => {
    const { held } = pickNext([job("w", "https://site1.example")], sites(10), 10);
    expect(held[0].why).toBe("site");
  });
  it("a limit of 1 is the old station: one scan at a time, in order", () => {
    expect(ids(pickNext(sites(3), [], 1).start)).toEqual(["s1"]);
    expect(pickNext(sites(2, 2), sites(1), 1).start).toEqual([]);
  });
  it("a whole queue drains in order as running scans end: never more than the limit, never two of one site, every scan runs once", () => {
    // 25 scans over 12 sites (some sites twice or three times), limit 10; the scan that started first ends first.
    let waiting: Job[] = Array.from({ length: 25 }, (_, i) => job(`q${i + 1}`, `https://site${(i * 7) % 12}.example`));
    let running: Job[] = [];
    const started: string[] = [];
    let mostAtOnce = 0;
    for (let step = 0; step < 100 && (waiting.length || running.length); step++) {
      const { start, held } = pickNext(waiting, running, 10);
      running = [...running, ...start];
      started.push(...ids(start));
      waiting = held.map((h: { job: Job }) => h.job);
      expect(running.length).toBeLessThanOrEqual(10);
      expect(new Set(running.map((r) => siteKey(r.siteUrl))).size, "two scans of one site are running").toBe(running.length);
      mostAtOnce = Math.max(mostAtOnce, running.length);
      running = running.slice(1);
    }
    expect(waiting).toEqual([]);
    expect([...started].sort()).toEqual(Array.from({ length: 25 }, (_, i) => `q${i + 1}`).sort());
    expect(mostAtOnce).toBe(10);
    // Two scans of one site keep their order.
    for (let site = 0; site < 12; site++) {
      const mine = started.filter((id) => ((Number(id.slice(1)) - 1) * 7) % 12 === site).map((id) => Number(id.slice(1)));
      expect(mine).toEqual([...mine].sort((a, b) => a - b));
    }
  });
});

describe("orderWaiting — the order scans start in", () => {
  it("as PM-OS lists them (oldest first) when the station holds nothing", () => {
    expect(ids(orderWaiting(sites(3)))).toEqual(["s1", "s2", "s3"]);
  });
  it("the scans the station was reading when it stopped come first, in the order it holds them", () => {
    expect(ids(orderWaiting(sites(5), ["s4", "s2"]))).toEqual(["s4", "s2", "s1", "s3", "s5"]);
  });
  it("a saved place PM-OS no longer lists is not in the list", () => {
    expect(ids(orderWaiting(sites(2), ["gone", "s2"]))).toEqual(["s2", "s1"]);
  });
  it("a scan listed twice is one scan; scans running on this station are left out", () => {
    expect(ids(orderWaiting([...sites(3), ...sites(3)], [], ["s2"]))).toEqual(["s1", "s3"]);
  });
  it("an empty or missing list is an empty list", () => {
    expect(orderWaiting(undefined)).toEqual([]);
    expect(orderWaiting([])).toEqual([]);
  });
});

describe("statusOf — what the menu bar icon reads", () => {
  const live = (scanId: string, pagesRead: number, offline = false) => ({ scanId, competitor: scanId.toUpperCase(), siteUrl: `https://${scanId}.example`, pagesRead, startedAt: `2026-11-16T10:0${pagesRead % 10}:00.000Z`, offline });
  it("one scan: the same fields and words as the one-scan-at-a-time station, plus running = 1", () => {
    expect(statusOf([live("a", 7)], 2)).toMatchObject({ state: "scanning", message: "Scanning A", competitor: "A", site: "https://a.example", pagesRead: 7, waiting: 2, running: 1 });
  });
  it("several scans: the old fields describe the oldest running scan; running, waiting and one entry per scan are added", () => {
    const s = statusOf([live("a", 7), live("b", 3), live("c", 0)], 4);
    expect(s).toMatchObject({ state: "scanning", message: "Scanning 3 sites: A, B, C", competitor: "A", site: "https://a.example", pagesRead: 7, scanStartedAt: "2026-11-16T10:07:00.000Z", waiting: 4, running: 3 });
    expect(s.scans.map((x: { scanId: string; pagesRead: number; state: string }) => [x.scanId, x.pagesRead, x.state])).toEqual([["a", 7, "scanning"], ["b", 3, "scanning"], ["c", 0, "scanning"]]);
  });
  it("a scan waiting for the network makes the station offline, in the words the menu bar and the tests know", () => {
    expect(statusOf([live("a", 7, true)], 0)).toMatchObject({ state: "offline", message: "Network lost — the scan waits" });
    const s = statusOf([live("a", 7), live("b", 3, true)], 0);
    expect(s).toMatchObject({ state: "offline", message: "Network lost — 2 scans wait" });
    expect(s.scans.map((x: { state: string }) => x.state)).toEqual(["scanning", "offline"]);
  });
  it("nothing running: every scan field is empty", () => {
    expect(NO_SCAN).toEqual({ competitor: null, site: null, pagesRead: null, scanStartedAt: null, waiting: 0, running: 0, scans: [] });
  });
});

describe("saved places — one per scan, and the old single file is picked up", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pmos-places-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const place = (scanId: string, extra: Record<string, unknown> = {}) => ({ scanId, competitor: scanId.toUpperCase(), siteUrl: `https://${scanId}.example`, queue: [`https://${scanId}.example/a`, `https://${scanId}.example/b`], seen: [`https://${scanId}.example/`], pagesRead: 5, ...extra });

  it("each scan has its own file: saving one never touches another", () => {
    savePlace(dir, place("one"));
    savePlace(dir, place("two", { pagesRead: 9 }));
    expect(loadPlace(dir, "one")).toMatchObject({ scanId: "one", pagesRead: 5 });
    expect(loadPlace(dir, "two")).toMatchObject({ scanId: "two", pagesRead: 9 });
    clearPlace(dir, "one");
    expect(loadPlace(dir, "one")).toBeNull();
    expect(loadPlace(dir, "two")).toMatchObject({ scanId: "two" });
    expect(ids(loadPlaces(dir))).toEqual(["two"]);
  });

  it("the single file of the one-scan-at-a-time station is picked up: same scan, same queue, same reason and time — and the old file is gone", () => {
    const old = place("legacy", { stopped: { reason: "shutdown", at: "2026-11-16T14:30:00.000Z" }, savedAt: "2026-11-16T14:29:58.000Z", elapsedMs: 610_924, renders: 1 });
    writeFileSync(join(dir, LEGACY_FILE), JSON.stringify(old));
    const places = loadPlaces(dir);
    expect(places).toEqual([old]);
    expect(existsSync(join(dir, LEGACY_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(placeFile(dir, "legacy"), "utf8"))).toEqual(old);
    expect(loadPlace(dir, "legacy")).toEqual(old);
  });

  it("an old file left by a crash (no reason on it) is picked up as it is — PM-OS is told 'crash'", () => {
    const old = place("crashed", { savedAt: "2026-11-16T14:29:58.000Z" });
    writeFileSync(join(dir, LEGACY_FILE), JSON.stringify(old));
    expect(adoptLegacyPlace(dir)).toEqual(old);
    expect(loadPlace(dir, "crashed")?.stopped).toBeUndefined();
  });

  it("the old file next to newer places: all of them are found, the scan that stopped first comes first", () => {
    savePlace(dir, place("newer"));
    markStopped(dir, "newer", "shutdown");
    writeFileSync(join(dir, LEGACY_FILE), JSON.stringify(place("older", { stopped: { reason: "network", at: "2026-11-01T08:00:00.000Z" } })));
    expect(ids(loadPlaces(dir))).toEqual(["older", "newer"]);
  });

  it("a scan that already has its own file keeps it: the old file never overwrites a newer place", () => {
    savePlace(dir, place("same", { pagesRead: 40 }));
    writeFileSync(join(dir, LEGACY_FILE), JSON.stringify(place("same", { pagesRead: 12 })));
    expect(adoptLegacyPlace(dir)).toBeNull();
    expect(loadPlace(dir, "same")?.pagesRead).toBe(40);
    expect(existsSync(join(dir, LEGACY_FILE))).toBe(false);
  });

  it("an old file that is not a place (broken, empty) is dropped and nothing is lost with it", () => {
    savePlace(dir, place("kept"));
    writeFileSync(join(dir, LEGACY_FILE), "{ not json");
    expect(ids(loadPlaces(dir))).toEqual(["kept"]);
    expect(existsSync(join(dir, LEGACY_FILE))).toBe(false);
  });

  it("no state folder, no old file: no places", () => {
    expect(loadPlaces(dir)).toEqual([]);
    expect(loadPlace(dir, "none")).toBeNull();
  });

  it("the reason a scan stopped is written once: the first reason stays, and only that scan's file is marked", () => {
    savePlace(dir, place("a"));
    savePlace(dir, place("b"));
    expect(markStopped(dir, "a", "network")).toBe(true);
    expect(markStopped(dir, "a", "shutdown")).toBe(true);
    expect(loadPlace(dir, "a")?.stopped?.reason).toBe("network");
    expect(loadPlace(dir, "b")?.stopped).toBeUndefined();
    expect(markStopped(dir, "no-place", "shutdown")).toBe(false);
  });

  it("a file half-written when the power went (.tmp) is not a place", () => {
    mkdirSync(join(dir, PLACES_DIR), { recursive: true });
    writeFileSync(`${placeFile(dir, "half")}.tmp`, JSON.stringify(place("half")));
    expect(loadPlaces(dir)).toEqual([]);
  });

  it("a scan id can never name a file outside the places folder", () => {
    expect(placeFile(dir, "../../etc/passwd").startsWith(join(dir, PLACES_DIR))).toBe(true);
    expect(placeFile(dir, "../../etc/passwd")).not.toContain("/etc/");
  });
});
