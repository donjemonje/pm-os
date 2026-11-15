/** Website Scanning — a company's other addresses (lib/competitors/addresses.ts): link picking, llms.txt, the guess-and-verify rule, de-duplication, what a PM removed, the pick's closed sets. Pure module. */
import { describe, expect, it } from "vitest";
import {
  ADDRESS_PICK_SYSTEM_PROMPT,
  addressLooksLike,
  addressPickTool,
  addressRefusal,
  answeredPage,
  answerSignature,
  controlAddress,
  GUESS_NAMES,
  guessCandidates,
  guessVerdict,
  injectedAddressPick,
  isScannedAddress,
  isScannedSource,
  isSiteAddress,
  knownAddresses,
  linkCandidates,
  linksWithText,
  llmsCandidates,
  llmsTxtLinks,
  looksLikeLlmsTxt,
  MAX_CANDIDATES,
  mergeCandidates,
  parseAddressPick,
  pickEntries,
  readAddressSearch,
  renderAddressPick,
  screenCandidates,
  SEARCH_STALE_MS,
  searchRunning,
  textLooksLike,
  type Answer,
  type Candidate,
  type RawCandidate,
} from "@/lib/competitors/addresses";
import { sourceSiteHost } from "@/lib/competitors/url";

const MAIN = "acme.com";
const page = (text: string, title = "Page") => `${title}\n${text}\n${"More words so that the page is long enough to count as a readable page. ".repeat(2)}`;
const answer = (url: string, o: Partial<Answer> = {}): Answer => ({ url, status: 200, error: null, finalUrl: url, title: "Page", text: page("Some text"), ...o });
const NONE = (url: string): Answer => ({ url, status: 0, error: "other", finalUrl: url, title: "", text: "" });

describe("which sources are scanned addresses", () => {
  it("a plain site address has a host and nothing after it", () => {
    expect(isSiteAddress("https://support.acme.com")).toBe(true);
    expect(isSiteAddress("https://support.acme.com/")).toBe(true);
    expect(isSiteAddress("https://support.acme.com/hc")).toBe(false);
    expect(isSiteAddress("https://docs.acme.com/llms.txt")).toBe(false);
    expect(isSiteAddress("https://acme.com/?x=1")).toBe(false);
    expect(isSiteAddress("ftp://acme.com")).toBe(false);
    expect(isSiteAddress("not a url")).toBe(false);
  });
  it("a help center, developer docs or release notes source at a plain site address is one — whoever added it", () => {
    expect(isScannedAddress({ type: "helpcenter", url: "https://support.acme.com" }, MAIN)).toBe(true);
    expect(isScannedAddress({ type: "apidocs", url: "https://developers.acme.com/" }, MAIN)).toBe(true);
    expect(isScannedAddress({ type: "changelog", url: "https://changelog.acme.com" }, MAIN)).toBe(true);
  });
  it("a source a collector fed is not one: another type, an address with a path, or the main site itself", () => {
    expect(isScannedAddress({ type: "reviews", url: "https://reviews.example.com" }, MAIN)).toBe(false);
    expect(isScannedAddress({ type: "helpcenter", url: "https://support.acme.com/hc" }, MAIN)).toBe(false);
    expect(isScannedAddress({ type: "apidocs", url: "https://docs.acme.com/guide.pdf" }, MAIN)).toBe(false);
    expect(isScannedAddress({ type: "helpcenter", url: "https://www.acme.com" }, MAIN)).toBe(false);
  });
  it("an address a PM removed is not one; the website always is a scanned source", () => {
    expect(isScannedAddress({ type: "helpcenter", url: "https://support.acme.com", removedAt: new Date() }, MAIN)).toBe(false);
    expect(isScannedSource({ type: "website", url: "https://acme.com" }, MAIN)).toBe(true);
    expect(isScannedSource({ type: "helpcenter", url: "https://support.acme.com" }, MAIN)).toBe(true);
    expect(isScannedSource({ type: "press", url: "https://acme.com/press" }, MAIN)).toBe(false);
  });
  it("a source is bounded by its own site: the company's host for the website, the address's host for the others", () => {
    expect(sourceSiteHost({ type: "website", url: "https://www.acme.com" }, MAIN)).toBe("acme.com");
    expect(sourceSiteHost({ type: "helpcenter", url: "https://support.acme.com" }, MAIN)).toBe("support.acme.com");
    expect(sourceSiteHost({ type: "helpcenter", url: "https://acme.zendesk.com" }, MAIN)).toBe("acme.zendesk.com");
    expect(sourceSiteHost({ type: "apidocs", url: "not a url" }, MAIN)).toBe("acme.com");
  });
});

describe("1 — the company's own links", () => {
  const HOME = `
    <nav>
      <a href="/pricing">Pricing</a>
      <a href="/docs/start">Docs</a>
      <a href="https://support.acme.com/hc/en-us">Help Center</a>
      <a href="https://support.acme.com/hc/en-us/requests/new">Contact support</a>
      <a href="https://developers.acme.com/reference"><span>API</span> <b>reference</b></a>
      <a href="https://updates.acme.com" aria-label="What's new"><svg></svg></a>
      <a href="https://acme.zendesk.com/hc">Guides</a>
      <a href="https://status.acme.com">System status</a>
      <a href="https://app.acme.com/login">Log in</a>
      <a href="https://intercom.help/acme/en">Help</a>
      <a href="https://github.com/acme">Developers</a>
      <a href="https://www.youtube.com/@acme">Tutorials</a>
      <a href="mailto:support@acme.com">Support</a>
      <a href="https://kb.acme.com">Read more</a>
      <a href="http://10.0.0.5/help">Help</a>
    </nav>`;
  const links = linksWithText(HOME, "https://www.acme.com/");
  const found = linkCandidates(links, MAIN);
  const hosts = found.map((c) => c.host);

  it("a link's text is its visible text, else its aria-label", () => {
    expect(links.find((l) => l.url.hostname === "developers.acme.com")?.text).toBe("API reference");
    expect(links.find((l) => l.url.hostname === "updates.acme.com")?.text).toBe("What's new");
  });
  it("links that leave the site and look like help, developers or release notes are candidates — one per site, as a plain site address", () => {
    expect(hosts).toEqual(["support.acme.com", "developers.acme.com", "updates.acme.com", "acme.zendesk.com", "kb.acme.com"]);
    expect(found[0]).toMatchObject({ url: "https://support.acme.com", via: "link", text: "Help Center", hint: "helpcenter" });
    expect(found[1]).toMatchObject({ url: "https://developers.acme.com", hint: "apidocs" });
    expect(found[2]).toMatchObject({ hint: "changelog" });
  });
  it("link text and address both count: a help center hosted by another company is found by its text, a plain link by its address", () => {
    expect(found.find((c) => c.host === "acme.zendesk.com")).toMatchObject({ text: "Guides", hint: "helpcenter" });
    expect(found.find((c) => c.host === "kb.acme.com")).toMatchObject({ text: "Read more", hint: "helpcenter" });
  });
  it("an area of the main site is not a candidate: the website scan reads it", () => {
    expect(hosts).not.toContain("acme.com");
    expect(addressRefusal(new URL("https://www.acme.com/docs"), MAIN)).toBe("same_site");
  });
  it("a link that does not look like any of the kinds is not a candidate", () => {
    expect(hosts).not.toContain("status.acme.com");
    expect(hosts).not.toContain("app.acme.com");
  });
  it("somebody else's bare domain is never a candidate, whatever the link says", () => {
    expect(hosts).not.toContain("intercom.help");
    expect(hosts).not.toContain("github.com");
    expect(hosts).not.toContain("youtube.com");
    expect(addressRefusal(new URL("https://intercom.help/acme/en"), MAIN)).toBe("foreign");
    expect(addressRefusal(new URL("https://acme.readme.io/docs"), MAIN)).toBeNull();
  });
  it("a private address and a link that is not a web address are never candidates", () => {
    expect(hosts).not.toContain("10.0.0.5");
    expect(addressRefusal(new URL("http://10.0.0.5/help"), MAIN)).toBe("private");
    expect(addressRefusal(new URL("mailto:support@acme.com"), MAIN)).toBe("scheme");
  });
  it("what a text or an address looks like — the domain's own name never counts", () => {
    expect(textLooksLike("Knowledge base")).toBe("helpcenter");
    expect(textLooksLike("Release notes")).toBe("changelog");
    expect(textLooksLike("Developer docs")).toBe("apidocs");
    expect(textLooksLike("Customers")).toBeNull();
    expect(addressLooksLike(new URL("https://helpscout.com/"))).toBeNull();
    expect(addressLooksLike(new URL("https://docs.helpscout.com/"))).toBe("helpcenter");
    expect(addressLooksLike(new URL("https://acme.com/whats-new"))).toBe("changelog");
    expect(addressLooksLike(new URL("https://api.acme.com/"))).toBe("apidocs");
  });
});

describe("2 — llms.txt", () => {
  const TXT = `# Acme

> Acme is a product for teams.

## Docs
- [Developer Documentation](https://developer.acme.com/llms.txt): the API
- [Pricing](/pricing)
- [Help center](https://support.acme.com/hc/en-us)
- [Trust](https://trust.acme.com)

Source code: https://github.com/acme/sdk and https://acme.readme.io/reference.
`;
  it("is text, not the HTML page a site serves for any address", () => {
    expect(looksLikeLlmsTxt(TXT)).toBe(true);
    expect(looksLikeLlmsTxt("<!DOCTYPE html><html><body>Not found</body></html>")).toBe(false);
    expect(looksLikeLlmsTxt("  <html lang='en'>…</html>")).toBe(false);
    expect(looksLikeLlmsTxt("")).toBe(false);
  });
  it("its Markdown links and bare addresses are read, each once", () => {
    const links = llmsTxtLinks(TXT, "https://acme.com/llms.txt");
    expect(links.map((l) => l.url.href)).toEqual([
      "https://developer.acme.com/llms.txt", "https://acme.com/pricing", "https://support.acme.com/hc/en-us", "https://trust.acme.com/", "https://github.com/acme/sdk", "https://acme.readme.io/reference",
    ]);
    expect(links[0].text).toBe("Developer Documentation");
  });
  it("the addresses on other hosts of the company's own are candidates — no word is needed, the site listed them", () => {
    const found = llmsCandidates(llmsTxtLinks(TXT, "https://acme.com/llms.txt"), MAIN);
    expect(found.map((c) => c.url)).toEqual(["https://developer.acme.com", "https://support.acme.com", "https://trust.acme.com", "https://acme.readme.io"]);
    expect(found.every((c) => c.via === "llms")).toBe(true);
    expect(found[0].hint).toBe("apidocs");
    expect(found[2].hint).toBeNull();
  });
});

describe("3 — guessing common names, and verifying", () => {
  it("the names go in front of the company's own domain, never the main site itself", () => {
    expect(guessCandidates({ url: "https://acme.com", host: "acme.com" }).map((g) => g.host)).toEqual(GUESS_NAMES.map((n) => `${n}.acme.com`));
    expect(guessCandidates({ url: "https://app.acme.co.uk", host: "app.acme.co.uk" })[0]).toMatchObject({ url: "https://help.acme.co.uk", host: "help.acme.co.uk", via: "guess", hint: "helpcenter" });
    expect(guessCandidates({ url: "https://docs.acme.com", host: "docs.acme.com" }).map((g) => g.host)).not.toContain("docs.acme.com");
    expect(guessCandidates({ url: "http://localhost:4100", host: "localhost:4100" })).toEqual([]);
    expect(guessCandidates({ url: "http://10.1.2.3", host: "10.1.2.3" })).toEqual([]);
  });
  it("a guess is asked on the main site's own scheme and port (a test site keeps its port; a real site has none)", () => {
    const g = guessCandidates({ url: "http://shop.acme.test:4100", host: "shop.acme.test:4100" })[0];
    expect(g).toMatchObject({ url: "http://help.acme.test:4100", host: "help.acme.test:4100" });
    expect(controlAddress({ url: "http://shop.acme.test:4100", host: "shop.acme.test:4100" }, "ab12")).toBe("http://pmos-check-ab12.acme.test:4100");
  });
  it("the made-up name sits on the same domain", () => {
    expect(controlAddress({ url: "https://www.acme.com", host: "acme.com" }, "3F9A1C2E")).toBe("https://pmos-check-3f9a1c2e.acme.com");
  });

  const HOME = answer("https://acme.com", { title: "Acme — the product", text: page("Acme is the product for teams.", "Acme") });
  const main = { host: MAIN, home: HOME };
  const HELP = answer("https://support.acme.com", { title: "Acme Help Center", text: page("How to set up your workspace. Articles and guides.", "Acme Help Center") });

  it("an honest domain: the made-up name does not exist, the guess answers a page → it counts", () => {
    const v = guessVerdict(HELP, NONE("https://pmos-check-ab12.acme.com"), main);
    expect(v).toEqual({ counts: true, url: "https://support.acme.com", host: "support.acme.com" });
  });
  it("a domain that answers for any name with the same page → the guess proves nothing", () => {
    const any = (url: string) => answer(url, { title: "Acme", text: page("Welcome to Acme. Sign up for free.", "Acme") });
    expect(guessVerdict(any("https://help.acme.com"), any("https://pmos-check-ab12.acme.com"), main)).toEqual({ counts: false, why: "same_as_any_name" });
  });
  it("a domain that answers for any name with a page that repeats the name it was asked under → still the same answer", () => {
    const echo = (url: string) => answer(url, { title: `${new URL(url).hostname} — workspace not found`, text: page(`There is no workspace at ${new URL(url).hostname}. Create one for free.`, "Not found") });
    expect(guessVerdict(echo("https://docs.acme.com"), echo("https://pmos-check-ab12.acme.com"), main)).toEqual({ counts: false, why: "same_as_any_name" });
  });
  it("a domain that answers for any name, and a real help center under one of the names → that one counts", () => {
    const any = answer("https://pmos-check-ab12.acme.com", { title: "Acme", text: page("Welcome to Acme. Sign up for free.", "Acme") });
    expect(guessVerdict(HELP, any, main)).toMatchObject({ counts: true, host: "support.acme.com" });
  });
  it("every name is sent to the same place somewhere else (a login) → the guess proves nothing", () => {
    const login = (url: string) => answer(url, { finalUrl: "https://app.acme.com/login", title: "Log in", text: page(`Log in to continue to ${new URL(url).hostname}.`, "Log in") });
    expect(guessVerdict(login("https://academy.acme.com"), login("https://pmos-check-ab12.acme.com"), main)).toEqual({ counts: false, why: "same_as_any_name" });
  });
  it("the page that answers is the main site again — a redirect back, or the home page's text under another name → no", () => {
    expect(guessVerdict(answer("https://help.acme.com", { finalUrl: "https://www.acme.com/help" }), NONE("https://pmos-check-ab12.acme.com"), main)).toEqual({ counts: false, why: "main_site" });
    expect(guessVerdict(answer("https://kb.acme.com", { title: HOME.title, text: HOME.text }), NONE("https://pmos-check-ab12.acme.com"), main)).toEqual({ counts: false, why: "main_site" });
  });
  it("a name that redirects to another host of the company's own counts — as the site that answers", () => {
    const v = guessVerdict(answer("https://docs.acme.com", { finalUrl: "https://developer.acme.com/docs/overview", title: "Overview", text: page("The Acme API. Authentication, endpoints.", "Overview") }), NONE("https://pmos-check-ab12.acme.com"), main);
    expect(v).toEqual({ counts: true, url: "https://developer.acme.com", host: "developer.acme.com" });
    expect(guessVerdict(answer("https://help.acme.com", { finalUrl: "https://acme.zendesk.com/hc/en-us" }), NONE("https://pmos-check-ab12.acme.com"), main)).toMatchObject({ counts: true, host: "acme.zendesk.com" });
  });
  it("a name that lands on somebody else's bare domain → no", () => {
    expect(guessVerdict(answer("https://academy.acme.com", { finalUrl: "https://parking.example/acme" }), NONE("https://pmos-check-ab12.acme.com"), main)).toEqual({ counts: false, why: "foreign" });
  });
  it("no answer, an error page, bot protection, an empty page or an API that answers no page → no", () => {
    const control = NONE("https://pmos-check-ab12.acme.com");
    expect(guessVerdict(NONE("https://kb.acme.com"), control, main)).toEqual({ counts: false, why: "no_answer" });
    expect(guessVerdict(answer("https://kb.acme.com", { status: 404, error: "notfound" }), control, main)).toEqual({ counts: false, why: "no_answer" });
    expect(guessVerdict(answer("https://kb.acme.com", { status: 403, error: "botwall" }), control, main)).toEqual({ counts: false, why: "no_answer" });
    expect(guessVerdict(answer("https://api.acme.com", { text: '{"error":"unauthorized"}' }), control, main)).toEqual({ counts: false, why: "no_answer" });
    expect(answeredPage(answer("https://kb.acme.com", { text: "" }))).toBe(false);
  });
  it("an answer's signature leaves out the host it was asked under, and nothing else", () => {
    const a = answerSignature(answer("https://help.acme.com", { title: "Help", text: page("We help you get started at help.acme.com.") }));
    const b = answerSignature(answer("https://kb.acme.com", { title: "Help", text: page("We help you get started at kb.acme.com.") }));
    expect(a).toEqual(b);
    expect(a.landed).toBe("{host}");
  });
});

describe("de-duplication, and what is already there", () => {
  const raw = (host: string, via: RawCandidate["via"], text = ""): RawCandidate & { title: string; opening: string } => ({ url: `https://${host}`, host, via, text, hint: null, title: `Title of ${host}`, opening: "First lines" });

  it("one candidate per site: the most reliable finding wins and every way it was found is remembered", () => {
    const { candidates, dropped } = mergeCandidates([raw("support.acme.com", "guess"), raw("developer.acme.com", "llms", "Developer Documentation"), raw("support.acme.com", "link", "Help Center"), raw("support.acme.com", "llms", "Help")]);
    expect(dropped).toBe(0);
    expect(candidates.map((c) => c.host)).toEqual(["support.acme.com", "developer.acme.com"]);
    expect(candidates[0]).toMatchObject({ via: "link", text: "Help Center", vias: ["link", "llms", "guess"] });
    expect(candidates[1]).toMatchObject({ via: "llms", vias: ["llms"] });
  });
  it("links come first, then llms.txt, then guesses, each in the order found; more than the limit are left out and counted", () => {
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => raw(`s${i}.acme.com`, i % 2 ? "guess" : "link"));
    const { candidates, dropped } = mergeCandidates(many);
    expect(candidates).toHaveLength(MAX_CANDIDATES);
    expect(dropped).toBe(3);
    expect(candidates[0].via).toBe("link");
    expect(candidates.map((c) => c.via).lastIndexOf("link")).toBeLessThan(candidates.map((c) => c.via).indexOf("guess"));
  });
  it("an address the company already has is not added again — whatever its kind, however it was added", () => {
    const r = screenCandidates([{ host: "support.acme.com" }, { host: "developer.acme.com" }], [{ host: "support.acme.com", removed: false }]);
    expect(r.alreadyThere.map((c) => c.host)).toEqual(["support.acme.com"]);
    expect(r.fresh.map((c) => c.host)).toEqual(["developer.acme.com"]);
    expect(r.removedByPm).toEqual([]);
  });
  it("an address a PM removed is never added back by a later search", () => {
    const r = screenCandidates([{ host: "support.acme.com" }, { host: "kb.acme.com" }], [{ host: "support.acme.com", removed: true }]);
    expect(r.removedByPm.map((c) => c.host)).toEqual(["support.acme.com"]);
    expect(r.fresh.map((c) => c.host)).toEqual(["kb.acme.com"]);
  });
  it("what the company already has: its scanned addresses and the ones a PM removed — never a source a collector fed", () => {
    const known = knownAddresses([
      { type: "website", url: "https://www.acme.com" },
      { type: "helpcenter", url: "https://support.acme.com" },
      { type: "apidocs", url: "https://developers.acme.com/", removedAt: new Date() },
      { type: "helpcenter", url: "https://kb.acme.com/hc/article-12" },
      { type: "changelog", url: "https://docs.acme.com/changelog/" },
      { type: "reviews", url: "https://reviews.example.com" },
      { type: "documents", url: "not a url" },
    ], MAIN);
    expect(known).toEqual([{ host: "support.acme.com", removed: false }, { host: "developers.acme.com", removed: true }]);
    // A page of a help center that a collector imported does not stand in the way of scanning that help center.
    expect(screenCandidates([{ host: "kb.acme.com" }, { host: "docs.acme.com" }, { host: "support.acme.com" }, { host: "developers.acme.com" }], known)).toMatchObject({
      fresh: [{ host: "kb.acme.com" }, { host: "docs.acme.com" }], alreadyThere: [{ host: "support.acme.com" }], removedByPm: [{ host: "developers.acme.com" }],
    });
  });
  it("an address that was removed and then added again by hand is there, not removed", () => {
    const r = screenCandidates([{ host: "support.acme.com" }], [{ host: "support.acme.com", removed: true }, { host: "support.acme.com", removed: false }]);
    expect(r.alreadyThere).toHaveLength(1);
    expect(r.removedByPm).toHaveLength(0);
  });
});

describe("4 — PMOS AI picks: codes and kinds are closed sets", () => {
  const candidate = (host: string, o: Partial<Candidate> = {}): Candidate => ({ url: `https://${host}`, host, via: "link", vias: ["link"], text: "Help Center", hint: "helpcenter", title: "Acme Help Center", opening: "How to set up your workspace.", ...o });
  const entries = pickEntries([candidate("support.acme.com"), candidate("developer.acme.com", { via: "llms", vias: ["llms", "guess"], text: "", title: "Overview" }), candidate("status.acme.com", { via: "guess", vias: ["guess"], text: "", title: "Acme status" })]);
  const codes = entries.map((e) => e.code);

  it("every candidate gets a code, and the call shows its address, how it was found, the link text, the title and the first lines", () => {
    expect(codes).toEqual(["A1", "A2", "A3"]);
    const tail = renderAddressPick({ name: "Acme", site: "https://acme.com" }, entries);
    expect(tail).toContain('A1 | https://support.acme.com | found: a link on the home page | link text: "Help Center" | title: "Acme Help Center" | first lines: "How to set up your workspace."');
    expect(tail).toContain("A2 | https://developer.acme.com | found: listed in llms.txt and a common name in front of the domain | link text: none");
  });
  it("the tool offers only the codes asked and the four kinds", () => {
    const items = (addressPickTool(codes).input_schema as { properties: { addresses: { items: { properties: { code: { enum: string[] }; kind: { enum: string[] } } } } } }).properties.addresses.items.properties;
    expect(items.code.enum).toEqual(codes);
    expect(items.kind.enum).toEqual(["helpcenter", "apidocs", "changelog", "skip"]);
    expect(ADDRESS_PICK_SYSTEM_PROMPT).toContain("status page");
  });
  it("a usable answer: each code gets its kind, and skip adds nothing", () => {
    const r = parseAddressPick({ addresses: [{ code: "A1", kind: "helpcenter" }, { code: "A2", kind: "apidocs" }, { code: "A3", kind: "skip" }] }, codes);
    expect(r.problems).toEqual([]);
    expect(r.undecided).toEqual([]);
    expect([...r.picks.entries()]).toEqual([["A1", "helpcenter"], ["A2", "apidocs"], ["A3", "skip"]]);
  });
  it("a code that was not asked makes the answer unusable", () => {
    const r = parseAddressPick({ addresses: [{ code: "A1", kind: "helpcenter" }, { code: "A9", kind: "apidocs" }] }, codes);
    expect(r.problems).toEqual(["a code that was not asked (A9)"]);
  });
  it("a kind outside the list makes the answer unusable", () => {
    const r = parseAddressPick({ addresses: [{ code: "A1", kind: "forum" }] }, codes);
    expect(r.problems).toEqual(["a kind outside the list (forum) for A1"]);
  });
  it("an answer with no list is unusable; a code the answer leaves out is undecided, not guessed", () => {
    expect(parseAddressPick({ sections: [] }, codes).problems).toHaveLength(1);
    expect(parseAddressPick(null, codes).problems).toHaveLength(1);
    const r = parseAddressPick({ addresses: [{ code: "A1", kind: "helpcenter" }, { code: "A1", kind: "skip" }] }, codes);
    expect(r.problems).toEqual([]);
    expect(r.picks.get("A1")).toBe("helpcenter");
    expect(r.undecided).toEqual(["A2", "A3"]);
  });
  it("TEST KNOB: an injected answer is built from kinds by host and goes through the same parser", () => {
    const text = injectedAddressPick({ "support.acme.com": "helpcenter", "*": "skip" }, entries);
    expect(parseAddressPick(JSON.parse(text), codes).picks.get("A1")).toBe("helpcenter");
    expect(parseAddressPick(JSON.parse(text), codes).picks.get("A2")).toBe("skip");
    expect(parseAddressPick(JSON.parse(injectedAddressPick(undefined, entries)), codes).picks.get("A3")).toBe("skip");
    expect(parseAddressPick(JSON.parse(injectedAddressPick({ "*": "wiki" }, entries)), codes).problems).toHaveLength(3);
  });
});

describe("what a search leaves behind", () => {
  it("the stored result is read field by field", () => {
    expect(readAddressSearch({ status: "done", at: "2026-11-15T10:00:00.000Z", trigger: "scan", candidates: 3, added: 2, note: "" })).toEqual({ status: "done", at: "2026-11-15T10:00:00.000Z", trigger: "scan", candidates: 3, added: 2, note: "" });
    expect(readAddressSearch({ status: "undecided", at: "2026-11-15T10:00:00.000Z" })).toMatchObject({ status: "undecided", candidates: 0, added: 0, note: "" });
    expect(readAddressSearch({ status: "running", at: "x" })).toBeNull();
    expect(readAddressSearch(null)).toBeNull();
    expect(readAddressSearch(undefined)).toBeNull();
  });
  it("a search is working while it started less than ten minutes ago", () => {
    const now = Date.parse("2026-11-15T10:00:00Z");
    expect(searchRunning(new Date(now - 5_000), now)).toBe(true);
    expect(searchRunning(new Date(now - SEARCH_STALE_MS - 1), now)).toBe(false);
    expect(searchRunning(null, now)).toBe(false);
    expect(searchRunning(undefined, now)).toBe(false);
  });
});
