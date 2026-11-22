/**
 * Website Scanning — the search for a company's other addresses FOLLOWS THE SCAN LANES (Daniel 2026-11-16).
 *
 * Remote scanning OFF (the default): the server requests nothing from a company's site; the scan station brings
 * what the search needs with its scan of the main website, and the server applies its rules to that report.
 * Remote scanning ON: the server requests the site itself, and a site that refuses it is handed to the station.
 *
 * What is tested here, with no database, no PMOS AI and no network — every request is answered by a made-up web
 * in this process (the global fetch and the name lookup are replaced; all the names are under ".example"):
 *   - the lane decision (addresses.ts searchLane, stationSearchesWith);
 *   - what the station reports → the same candidates the server-side path produces (address-finding.ts with the
 *     real fetcher on one side, scripts/pmos-local-scan/addresses.mjs on the other);
 *   - the station's manners: one request per pause, stop on "slow down", never a private address, nothing
 *     reported while offline, an older PM-OS without the route;
 *   - a hand-added address with remote scanning off (addresses.ts checkManualAddress, manualAddressMustAnswer).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The name lookup of the server's fetcher (netguard.ts) never leaves this process.
const names = vi.hoisted(() => ({ lookedUp: [] as string[] }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    names.lookedUp.push(host);
    return [{ address: "93.184.216.34", family: 4 }];
  },
}));

import { addressesToAsk, answerFromStation, findCandidates, materialFromStation, readStationReport, stationAnswers, stationStep, stationToken, type Finding, type StationFetch } from "@/lib/competitors/address-finding";
import { checkManualAddress, controlAddress, GUESS_NAMES, manualAddressMustAnswer, readAddressSearch, searchLane, searchLooking, SEARCH_WAITS_NOTE, stationSearchesWith } from "@/lib/competitors/addresses";
import { fetchPlain, USER_AGENT } from "@/lib/competitors/fetcher";
import { normalizeWebsite } from "@/lib/competitors/url";
import { askAddress, fitCall, isPrivateName, MAX_CALL_BYTES, mayRequest, runAddressStep } from "../../scripts/pmos-local-scan/addresses.mjs";

// ————— A made-up web —————

const STATION_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const filler = "More words so that the page is long enough to count as a readable page. ".repeat(3);
const html = (title: string, text: string) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p><p>${filler}</p></main></body></html>`;

interface Reply {
  status?: number;
  type?: string;
  body?: string;
  location?: string;
  xRobots?: string;
}
type World = (url: URL, ua: string) => Reply | null;

interface Seen {
  url: string;
  ua: string;
}
let world: World = () => null;
let seen: Seen[] = [];

/** Every request of the server's fetcher and of the station ends here. A name the world does not have does not answer at all. */
async function fakeFetch(input: unknown, init?: { headers?: Record<string, string> }): Promise<Response> {
  const url = new URL(String(input));
  const ua = init?.headers?.["user-agent"] ?? "";
  seen.push({ url: url.href, ua });
  const r = world(url, ua);
  if (!r) throw new TypeError("fetch failed");
  const headers: Record<string, string> = { "content-type": r.type ?? "text/html; charset=utf-8" };
  if (r.location) headers.location = r.location;
  if (r.xRobots) headers["x-robots-tag"] = r.xRobots;
  const status = r.status ?? (r.location ? 302 : 200);
  return new Response(status >= 300 && status < 400 ? null : r.body ?? "", { status, headers });
}

beforeAll(() => {
  vi.stubGlobal("fetch", fakeFetch);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  seen = [];
});

// The home page and the llms.txt of tests/unit/competitors-addresses.test.ts, on names nobody owns.
const HOME = `<!doctype html><html><head><title>Acme — the product</title></head><body>
    <nav>
      <a href="/pricing">Pricing</a>
      <a href="/docs/start">Docs</a>
      <a href="https://support.acme.example/hc/en-us">Help Center</a>
      <a href="https://support.acme.example/hc/en-us/requests/new">Contact support</a>
      <a href="https://developers.acme.example/reference"><span>API</span> <b>reference</b></a>
      <a href="https://updates.acme.example" aria-label="What's new"><svg></svg></a>
      <a href="https://acme.helpdesk.example/hc">Guides</a>
      <a href="https://status.acme.example">System status</a>
      <a href="https://app.acme.example/login">Log in</a>
      <a href="https://intercom.example/acme/en">Help</a>
      <a href="https://codehost.example/acme">Developers</a>
      <a href="mailto:support@acme.example">Support</a>
      <a href="https://kb.acme.example">Read more</a>
      <a href="http://10.0.0.5/help">Help</a>
    </nav>
    <main><h1>Acme is the product for teams.</h1><p>${filler}</p></main></body></html>`;
const LLMS = `# Acme

> Acme is a product for teams.

## Docs
- [Developer Documentation](https://developer.acme.example/llms.txt): the API
- [Pricing](/pricing)
- [Help center](https://support.acme.example/hc/en-us)
- [Trust](https://trust.acme.example)

Source code: https://codehost.example/acme/sdk and https://acme.readme.example/reference.
`;

const SITE = { url: "https://acme.example", host: "acme.example" };
const SCAN = "scan-ck1";
const TOKEN = stationToken(SCAN);

/** An honest company: a help center, developer docs, a docs site nobody links to, and a few dead ends. */
const honest: World = (u) => {
  switch (u.hostname) {
    case "acme.example":
      if (u.pathname === "/") return { body: HOME };
      if (u.pathname === "/llms.txt") return { type: "text/plain", body: LLMS };
      return { status: 404, body: html("Not found", "No such page.") };
    case "support.acme.example":
      return { body: html("Acme Help Center", "How to set up your workspace. Articles and guides.") };
    case "developers.acme.example":
      return { location: "https://developer.acme.example/docs/overview" };
    case "developer.acme.example":
      return { body: html("Acme API — overview", "The Acme API. Authentication, endpoints, SDKs.") };
    case "updates.acme.example":
      return { status: 404, body: html("Not found", "Nothing here.") };
    case "acme.helpdesk.example":
      return { status: 403, body: "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>" };
    case "trust.acme.example":
      return { body: html("Acme Trust Center", "Security, compliance and certifications.") };
    case "acme.readme.example":
      return { location: "http://10.0.0.5/internal" };
    // Guessed names.
    case "help.acme.example":
      return { location: "https://support.acme.example/hc/en-us" };
    case "docs.acme.example":
      return { body: html("Acme Docs", "User guides for every part of the product.") };
    case "academy.acme.example":
      return { body: HOME };
    case "changelog.acme.example":
      return { type: "application/zip", body: "PK" };
    case "api.acme.example":
      return { type: "application/json", body: '{"error":"unauthorized"}' };
    case "knowledge.acme.example":
      return { body: html("Acme knowledge", "Search engines are asked to stay out."), xRobots: "noindex" };
    default:
      return null;
  }
};

/** A domain that answers for any name with the same page — and one real help center under one of the names. */
const anyName: World = (u) => {
  if (u.hostname === "acme.example") return u.pathname === "/" ? { body: html("Acme", "Acme is the product for teams.") } : { status: 404, body: html("Not found", "No such page.") };
  if (u.hostname === "support.acme.example") return { body: html("Acme Help Center", "How to set up your workspace. Articles and guides.") };
  if (u.hostname.endsWith(".acme.example")) return { body: html(`${u.hostname} — workspace not found`, `There is no workspace at ${u.hostname}. Create one for free.`) };
  return null;
};

/** A site that refuses PM-OS itself (its own user agent) and answers a person's browser. */
const refusesPmos = (inner: World): World => (u, ua) => (ua === USER_AGENT ? { status: 403, body: "<html><head><title>Access denied</title></head><body>Access denied</body></html>" } : inner(u, ua));

// ————— The two ways to the candidates —————

/** The server requests the site itself: the scanner's real fetcher, the guard answered "public". */
const serverSide = (home: { html: string; finalUrl: string } | null = null): Promise<Finding> => findCandidates(SITE, home, TOKEN, { fetch: fetchPlain, isPublic: async () => true });

interface StationRun {
  result: { result: string; asked?: number; candidates?: number | null };
  finding: Finding | null;
  calls: Array<Record<string, unknown>>;
  pauses: number;
  log: string[];
}

/** The station brings the material: the real station step, and PM-OS's side of the route (address-finding.ts stationStep). */
async function stationSide(opts: { home?: string; plainHtml?: string; online?: boolean; pmos?: (body: unknown) => unknown } = {}): Promise<StationRun> {
  const run: StationRun = { result: { result: "" }, finding: null, calls: [], pauses: 0, log: [] };
  const pmos = opts.pmos ?? ((body: unknown) => {
    const step = stationStep(SITE, SCAN, body);
    if ("error" in step) throw new Error(`/addresses → 400 ${step.error}`);
    if (!("finding" in step)) return { ask: step.ask };
    run.finding = step.finding;
    return { ok: true, candidates: step.finding.candidates.length };
  });
  run.result = await runAddressStep({
    siteUrl: SITE.url,
    home: { url: "https://acme.example/", finalUrl: "https://acme.example/", html: opts.home ?? HOME, ...(opts.plainHtml ? { plainHtml: opts.plainHtml } : {}) },
    // What goes over the wire is JSON: the station's body is serialized and read back, as the route does.
    call: async (payload: Record<string, unknown>) => {
      const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      run.calls.push(body);
      return pmos(body);
    },
    pause: async () => {
      run.pauses++;
    },
    online: async () => opts.online ?? true,
    deps: { fetch: fakeFetch, lookup: async () => [{ address: "93.184.216.34" }], allowPrivate: false, userAgent: STATION_UA, timeoutMs: 5_000 },
    log: (m: string) => run.log.push(m),
  });
  return run;
}

const hosts = (f: Finding | null) => (f?.candidates ?? []).map((c) => c.host);

// ————— The lane decision —————

describe("the search follows the scan lanes", () => {
  it("remote scanning OFF and no station report → nothing is requested: the search waits for the station", () => {
    expect(searchLane({ remoteOn: false, stationReport: false })).toBe("wait");
  });
  it("remote scanning OFF and the station handed its report in → the search runs from the report", () => {
    expect(searchLane({ remoteOn: false, stationReport: true })).toBe("station");
  });
  it("remote scanning ON → the server requests the site itself; when the site was handed to the station, the station's report is used", () => {
    expect(searchLane({ remoteOn: true, stationReport: false })).toBe("server");
    expect(searchLane({ remoteOn: true, stationReport: true })).toBe("station");
  });
  it("the station brings the material with every scan of a company's main website — never with a scan of a help center, developer docs or release notes", () => {
    expect(stationSearchesWith({ sourceType: "website" })).toBe(true);
    for (const t of ["helpcenter", "apidocs", "changelog", "reviews"]) expect(stationSearchesWith({ sourceType: t })).toBe(false);
  });
  it("a waiting search is 'looking' on the pages only while a scan of the main website is waiting or being read", () => {
    const waiting = readAddressSearch({ status: "waiting", at: "2026-11-16T10:00:00.000Z", trigger: "added", candidates: 0, added: 0, note: SEARCH_WAITS_NOTE });
    expect(waiting?.status).toBe("waiting");
    expect(searchLooking(null, waiting, true)).toBe(true);
    expect(searchLooking(null, waiting, false)).toBe(false);
    const done = readAddressSearch({ status: "done", at: "2026-11-16T10:00:00.000Z", trigger: "scan", candidates: 2, added: 1, note: "", scanId: "scan-9" });
    expect(done).toMatchObject({ status: "done", scanId: "scan-9" });
    expect(searchLooking(null, done, true)).toBe(false);
    expect(searchLooking(new Date(), done, false)).toBe(true);
  });
  it("what the one-hour guard of 2026-11-16 stored ('could not decide', remote scanning is off) is read as waiting", () => {
    const guard = readAddressSearch({ status: "undecided", at: "2026-11-16T17:00:00.000Z", trigger: "scan", candidates: 0, added: 0, note: "Remote scanning is off: the server fetches nothing from a company's site. The search for other addresses waits until the scan station can do it." });
    expect(guard?.status).toBe("waiting");
    expect(readAddressSearch({ status: "undecided", at: "2026-11-16T17:00:00.000Z", note: "PMOS AI's answer is unusable: a code that was not asked (A9)" })?.status).toBe("undecided");
  });
});

// ————— The same candidates, whoever asked —————

describe("what the station reports gives the candidates the server-side path produces", () => {
  it("an honest company: links, llms.txt and verified guesses — the same candidates, in the same order, with the same titles and first lines", async () => {
    world = honest;
    const server = await serverSide();
    const station = await stationSide();
    expect(station.result.result).toBe("handed in");
    expect(station.finding).toEqual(server);
    // What both found — the rules themselves are tested in competitors-addresses.test.ts.
    expect(hosts(server)).toEqual(["support.acme.example", "developer.acme.example", "acme.helpdesk.example", "trust.acme.example", "docs.acme.example"]);
    expect(server.candidates[0]).toMatchObject({ url: "https://support.acme.example", via: "link", vias: ["link", "guess"], text: "Help Center", title: "Acme Help Center" });
    expect(server.candidates[1]).toMatchObject({ via: "link", text: "API reference", title: "Acme API — overview" });
    // Bot protection: the company links to it, so it stays a candidate — with nothing to show.
    expect(server.candidates[2]).toMatchObject({ title: "", opening: "" });
    expect(server.candidates[4]).toMatchObject({ via: "guess", title: "Acme Docs" });
    expect(server.byMethod).toEqual({ link: 5, llms: 4, guess: 2 });
    expect(server.llms).toEqual({ url: "https://acme.example/llms.txt", text: LLMS });
    // Nothing left this process: the server's redirect guard asked the made-up name lookup, and every request was answered by the made-up web.
    expect(names.lookedUp).toContain("developer.acme.example");
    expect(seen.every((s) => new URL(s.url).hostname.endsWith(".example") || s.url.startsWith("http://10."))).toBe(true);
  });
  it("a guess that serves the home page again, a download, an API that answers no page and a page that asks robots to stay out do not count — on either path", async () => {
    world = honest;
    const both = [await serverSide(), (await stationSide()).finding];
    for (const f of both) for (const h of ["academy.acme.example", "changelog.acme.example", "api.acme.example", "knowledge.acme.example", "updates.acme.example", "kb.acme.example", "acme.readme.example"]) expect(hosts(f)).not.toContain(h);
  });
  it("a domain that answers for any name: only the real help center counts — the made-up name is asked on both paths", async () => {
    world = anyName;
    const server = await serverSide();
    const station = await stationSide({ home: html("Acme", "Acme is the product for teams.") });
    expect(station.finding).toEqual(server);
    expect(hosts(server)).toEqual(["support.acme.example"]);
    expect(server.llms).toBe("gone");
    expect(seen.filter((s) => s.url.startsWith(controlAddress(SITE, TOKEN))).map((s) => s.ua)).toEqual([USER_AGENT, STATION_UA]);
  });
  it("the home page the station rendered with its browser: the links come from the rendered page, the 'main site again' check from the plain one", async () => {
    world = honest;
    const rendered = HOME.replace("</nav>", '<a href="https://learn.acme.example">Academy</a></nav>').replace("Acme is the product for teams.", "Acme is the product for teams. Rendered by JavaScript.");
    const station = await stationSide({ home: rendered, plainHtml: HOME });
    // The link only the rendered page has was asked (it does not answer in this world, so it is not a candidate) …
    expect(seen.map((s) => s.url)).toContain("https://learn.acme.example/");
    // … and academy.acme.example, which serves the plain home page, is still told to be the main site again.
    expect(hosts(station.finding)).not.toContain("academy.acme.example");
    expect(hosts(station.finding)).toEqual(hosts(await serverSide()));
  });
});

// ————— Remote ON: the server first, the station when the site refuses PM-OS —————

describe("remote scanning ON: the server asks first; a site that refuses it is handed to the station", () => {
  it("the site refuses PM-OS: the server-side search finds nothing; the station's scan of the same site brings the candidates", async () => {
    world = refusesPmos(honest);
    const server = await serverSide();
    expect(server.homeUnread).toBeTruthy();
    expect(server.candidates).toEqual([]);
    // The scan lanes hand a site that refused the remote scan to the station; its scan of the main website brings the report.
    expect(stationSearchesWith({ sourceType: "website" })).toBe(true);
    const station = await stationSide();
    expect(searchLane({ remoteOn: true, stationReport: station.finding != null })).toBe("station");
    expect(hosts(station.finding)).toEqual(["support.acme.example", "developer.acme.example", "acme.helpdesk.example", "trust.acme.example", "docs.acme.example"]);
  });
});

// ————— The station's manners —————

describe("the station only fetches and reports, with the scan's manners", () => {
  it("every request is the station's own (a browser's identity) — none carries the PM-OS server's user agent", async () => {
    world = honest;
    const station = await stationSide();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.ua === STATION_UA)).toBe(true);
    expect(seen[0].url).toBe("https://acme.example/llms.txt");
    // The home page is not requested again: the station already read it with its scan.
    expect(seen.map((s) => s.url)).not.toContain("https://acme.example/");
    expect(station.calls).toHaveLength(2);
  });
  it("it asks exactly the list PM-OS gives — the made-up name first — and one request follows one pause", async () => {
    world = honest;
    const station = await stationSide();
    const report = readStationReport(station.calls[0], SITE);
    if ("error" in report) throw new Error(report.error);
    const ask = addressesToAsk(SITE, materialFromStation(SITE, report), TOKEN);
    expect(ask[0]).toBe(controlAddress(SITE, TOKEN));
    expect(ask.length).toBeLessThanOrEqual(1 + 20 + GUESS_NAMES.length);
    expect((station.calls[1].answers as { url: string }[]).map((a) => a.url)).toEqual(ask);
    // One pause before /llms.txt and one before every address of the list; redirects are part of their request.
    expect(station.pauses).toBe(1 + ask.length);
    // Somebody else's bare domain, the main site's own areas and a private address are never in the list.
    for (const u of ask) expect(u).not.toMatch(/intercom\.example|codehost\.example|10\.0\.0\.5|\/\/acme\.example/);
  });
  it("a redirect to a private address is never followed, and a private address in a list is never requested", async () => {
    world = honest;
    const deps = { fetch: fakeFetch, lookup: async () => [{ address: "93.184.216.34" }], allowPrivate: false, userAgent: STATION_UA };
    expect(await askAddress("https://acme.readme.example", deps)).toMatchObject({ status: 302, error: "notfound", finalUrl: "https://acme.readme.example/" });
    expect(await askAddress("http://10.0.0.5/help", deps)).toMatchObject({ status: 0, error: "private" });
    expect(await askAddress("http://localhost:3000", deps)).toMatchObject({ status: 0, error: "private" });
    // A public-looking name that resolves into this Mac's own network is not requested either.
    expect(await askAddress("https://support.acme.example", { ...deps, lookup: async () => [{ address: "192.168.1.20" }] })).toMatchObject({ status: 0, error: "private" });
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(["acme.readme.example"]);
    expect(isPrivateName("printer.local")).toBe(true);
    expect(isPrivateName("support.acme.example")).toBe(false);
    expect(await mayRequest(new URL("ftp://acme.example"), deps)).toBe(false);
  });
  it("slow down (429) from an address: the station stops asking and says so; what it asked so far is judged, the rest is left for the next scan", async () => {
    world = (u, ua) => (u.hostname === "developers.acme.example" ? { status: 429, body: "Too many requests" } : honest(u, ua));
    const station = await stationSide();
    const answers = station.calls[1].answers as { url: string; status: number }[];
    expect(station.calls[1].stopped).toBe("slowdown");
    expect(answers[answers.length - 1]).toMatchObject({ url: "https://developers.acme.example", status: 429 });
    // Nothing was requested after the slow-down answer.
    expect(seen[seen.length - 1].url).toBe("https://developers.acme.example/");
    const step = stationStep(SITE, SCAN, station.calls[1]);
    if (!("finding" in step)) throw new Error("no finding");
    expect(step.answered).toBeLessThan(step.ask.length);
    expect(step.stopped).toBe("slowdown");
    // The help center it had already asked is a candidate, and so is the address that said "slow down" (the company
    // links to it — as on the server-side path, it stays a candidate with nothing to show); what was never asked is not.
    expect(hosts(step.finding)).toEqual(["support.acme.example", "developers.acme.example"]);
    expect(step.finding.candidates[1]).toMatchObject({ title: "", opening: "" });
  });
  it("slow down (429) at /llms.txt: nothing more is asked for the search in this scan and nothing is reported", async () => {
    world = (u, ua) => (u.pathname === "/llms.txt" ? { status: 429, body: "Too many requests" } : honest(u, ua));
    const station = await stationSide();
    expect(station.result.result).toBe("slowdown");
    expect(station.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });
  it("the network drops during the step: nothing is reported, so no address is judged 'not there' because the Mac was offline", async () => {
    world = () => null;
    const station = await stationSide({ online: false });
    expect(station.result.result).toBe("offline");
    expect(station.calls).toHaveLength(0);
  });
  it("an older PM-OS without the route: the station asks /llms.txt, is refused, and the scan goes on", async () => {
    world = honest;
    const station = await stationSide({ pmos: () => { throw new Error("/api/competitors/local/scans/scan-ck1/addresses → 404 Not found"); } });
    expect(station.result.result).toBe("refused");
    expect(seen.map((s) => s.url)).toEqual(["https://acme.example/llms.txt"]);
  });
  it("a call that would be too large for PM-OS loses the largest pages, never the answers", () => {
    const big = "x".repeat(MAX_CALL_BYTES / 2);
    const fitted = fitCall({ home: { html: "<p>home</p>" }, answers: [{ url: "https://a.example", status: 200, html: big }, { url: "https://b.example", status: 200, html: `${big}y` }, { url: "https://c.example", status: 200, html: "<p>small</p>" }] });
    expect(fitted.answers.map((a: { url: string }) => a.url)).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
    expect(fitted.answers[1]).toMatchObject({ error: "other" });
    expect(fitted.answers[1].html).toBeUndefined();
    expect(fitted.answers[0].html).toBe(big);
    expect(fitted.answers[2].html).toBe("<p>small</p>");
  });
});

// ————— PM-OS's side of the report —————

describe("PM-OS judges the station's report with its own rules", () => {
  const fetchOf = (o: Partial<StationFetch> & { url: string }): StationFetch => ({ status: 200, finalUrl: o.url, xRobots: "", body: "", binary: false, error: null, ...o });

  it("an answer is judged as the server's own fetch would be: bot protection, not found, a download, robots asked to stay out, no answer", () => {
    expect(answerFromStation(fetchOf({ url: "https://a.example", body: html("Help", "Articles and guides.") }))).toMatchObject({ status: 200, error: null, title: "Help" });
    expect(answerFromStation(fetchOf({ url: "https://a.example", status: 403, body: "<title>Just a moment...</title>" })).error).toBe("botwall");
    expect(answerFromStation(fetchOf({ url: "https://a.example", status: 404, body: "gone" })).error).toBe("notfound");
    expect(answerFromStation(fetchOf({ url: "https://a.example", status: 429, body: "slow" })).error).toBe("slowdown");
    expect(answerFromStation(fetchOf({ url: "https://a.example", binary: true }))).toMatchObject({ error: "binary", text: "" });
    expect(answerFromStation(fetchOf({ url: "https://a.example", body: html("Help", "x"), xRobots: "noindex" })).error).toBe("noindex");
    expect(answerFromStation(fetchOf({ url: "https://a.example", status: 0, error: "timeout" }))).toEqual({ url: "https://a.example", status: 0, error: "timeout", finalUrl: "https://a.example", title: "", text: "" });
  });
  it("only the addresses PM-OS listed count: an answer for any other address is ignored", () => {
    const answers = stationAnswers(["https://help.acme.example"], [fetchOf({ url: "https://help.acme.example", body: html("Help", "Articles.") }), fetchOf({ url: "https://evil.example", body: html("Evil", "Not asked.") })]);
    expect([...answers.keys()]).toEqual(["https://help.acme.example"]);
  });
  it("without the made-up name's answer no guess counts — a domain that answers for any name would make every guess count", () => {
    const home = { url: "https://acme.example/", finalUrl: "https://acme.example/", html: html("Acme", "Acme is the product for teams.") };
    const page = (url: string) => ({ url, status: 200, finalUrl: url, html: html("Acme Help Center", "How to set up your workspace.") });
    const without = stationStep(SITE, SCAN, { home, llms: { status: 404 }, answers: [page("https://support.acme.example")] });
    const withIt = stationStep(SITE, SCAN, { home, llms: { status: 404 }, answers: [{ url: controlAddress(SITE, TOKEN), status: 0, error: "other" }, page("https://support.acme.example")] });
    if (!("finding" in without) || !("finding" in withIt)) throw new Error("no finding");
    expect(without.finding.candidates).toEqual([]);
    expect(hosts(withIt.finding)).toEqual(["support.acme.example"]);
  });
  it("a report needs the home page, and the home page must be inside the company's site", () => {
    expect(stationStep(SITE, SCAN, {})).toHaveProperty("error");
    expect(stationStep(SITE, SCAN, { home: { html: "" } })).toHaveProperty("error");
    expect(stationStep(SITE, SCAN, { home: { html: HOME, finalUrl: "https://elsewhere.example/" } })).toHaveProperty("error");
    expect(stationStep(SITE, SCAN, { home: { html: HOME, finalUrl: "https://www.acme.example/en/" }, llms: null })).toHaveProperty("ask");
  });
  it("the made-up name is the same at every call of one scan and differs between scans", () => {
    expect(stationToken(SCAN)).toBe(stationToken(SCAN));
    expect(stationToken(SCAN)).toMatch(/^[0-9a-f]{8}$/);
    expect(stationToken("scan-ck2")).not.toBe(stationToken(SCAN));
  });
});

// ————— A PM adds an address by hand —————

describe("a PM adds an address by hand", () => {
  const sources = [
    { type: "website", url: "https://www.acme.example" },
    { type: "helpcenter", url: "https://support.acme.example" },
    { type: "apidocs", url: "https://developers.acme.example", removedAt: new Date("2026-11-10T00:00:00Z") },
  ];
  it("remote scanning OFF: the address is not asked — a well-formed public address is taken, its first scan says if it does not answer", () => {
    expect(manualAddressMustAnswer(false)).toBe(false);
    expect(checkManualAddress(normalizeWebsite("help.acme.example/hc/en-us"), "helpcenter", "acme.example", sources)).toEqual({ site: { url: "https://help.acme.example", host: "help.acme.example" }, kind: "helpcenter", removed: null });
    // Nothing was requested from anybody to say so.
    expect(seen).toEqual([]);
  });
  it("remote scanning ON: the server asks the address once before it is taken", () => {
    expect(manualAddressMustAnswer(true)).toBe(true);
  });
  it("whatever the switch: an address that is not a public web address is refused before anything else", () => {
    expect(() => normalizeWebsite("http://10.0.0.5/help")).toThrow();
    expect(() => normalizeWebsite("localhost")).toThrow();
    expect(() => normalizeWebsite("not an address")).toThrow();
  });
  it("whatever the switch: a kind outside the three, the main site and an address the company already has are refused", () => {
    expect(checkManualAddress(normalizeWebsite("help.acme.example"), "forum", "acme.example", sources)).toEqual({ error: "kind" });
    expect(checkManualAddress(normalizeWebsite("www.acme.example/docs"), "helpcenter", "acme.example", sources)).toEqual({ error: "main_site" });
    expect(checkManualAddress(normalizeWebsite("https://support.acme.example/hc"), "changelog", "acme.example", sources)).toEqual({ error: "exists" });
  });
  it("an address a PM removed earlier comes back", () => {
    const r = checkManualAddress(normalizeWebsite("developers.acme.example"), "apidocs", "acme.example", sources);
    expect(r).toMatchObject({ kind: "apidocs", removed: { url: "https://developers.acme.example" } });
  });
});
