/** Capability Analysis — limits are safety nets (analysis/caps.ts, analysis/alert.ts): what each cap records, how records add up, and the one email per run. Pure modules. */
import { describe, expect, it } from "vitest";
import { runAlertDue, runAlertEmail, type RunAlertInput } from "@/lib/competitors/analysis/alert";
import { ANALYSIS_TOKEN_BUDGET_DEFAULT } from "@/lib/competitors/analysis/budget";
import { CAP_IDS, capLine, capLines, CAPS, capsForEvent, capsHeadline, capsOf, clearStateCaps, readCaps, recordCap, type CapHit, type CapId } from "@/lib/competitors/analysis/caps";
import { GO_BACK_MAX_ROUNDS, GO_BACK_PAGES_PER_ITEM, pickForItem, pickForItemCounted } from "@/lib/competitors/analysis/gaps";
import { MAX_CAPABILITIES_PER_PAGE, MAX_FEATURES_PER_CAPABILITY, parseResearch } from "@/lib/competitors/analysis/prompts";
import { indexPages, LOOK_MAX_CHARS, LOOK_MAX_PAGES, pagesFor, selectLookPages } from "@/lib/competitors/analysis/secondlook";
import { DEFAULT_COMPETITORS_CONFIG } from "@/lib/competitors/config";

const PB = { competitorId: "pb", company: "Productboard" };
const hit = (cap: CapId, limit: number, undone: number, also = 0, times = 1, at: { competitorId: string | null; company: string | null } = PB): CapHit => ({ cap, limit, undone, also, times, ...at });

describe("the defaults are safety nets", () => {
  it("token budget per company per run: 10,000,000", () => {
    expect(ANALYSIS_TOKEN_BUDGET_DEFAULT).toBe(10_000_000);
  });
  it("second looks per run: 500 — the most the setting allows", () => {
    expect(DEFAULT_COMPETITORS_CONFIG.secondLooksPerRun).toBe(500);
  });
});

describe("what each cap reports: the limit, its value, what was left undone, at which company", () => {
  it("token budget", () => {
    expect(capLine(hit("token_budget", 10_000_000, 40))).toBe("token budget per company per run: 10,000,000 — 40 pages left unread at Productboard");
    expect(capLine(hit("token_budget", 10_000_000, 40, 12))).toBe("token budget per company per run: 10,000,000 — 40 pages left unread, 12 second looks not made at Productboard");
    expect(capLine(hit("token_budget", 1_000_000, 0, 1))).toBe("token budget per company per run: 1,000,000 — 1 second look not made at Productboard");
    expect(capLine(hit("token_budget", 1_000_000, 0))).toBe("token budget per company per run: 1,000,000 — reading stopped at Productboard");
  });
  it("second looks per run", () => {
    expect(capLine(hit("second_looks_per_run", 30, 12))).toBe("second looks per run: 30 — 12 capabilities not checked at Productboard");
    expect(capLine(hit("second_looks_per_run", 500, 1))).toBe("second looks per run: 500 — 1 capability not checked at Productboard");
  });
  it("go-back rounds and go-back pages per capability", () => {
    expect(capLine(hit("go_back_rounds", GO_BACK_MAX_ROUNDS, 5, 9))).toBe("go-back rounds per run: 2 — 5 capabilities still have a gap and 9 more deep pages were due at Productboard");
    expect(capLine(hit("go_back_rounds", GO_BACK_MAX_ROUNDS, 1, 1))).toBe("go-back rounds per run: 2 — 1 capability still has a gap and 1 more deep page was due at Productboard");
    expect(capLine(hit("go_back_pages_per_item", GO_BACK_PAGES_PER_ITEM, 14, 0, 4))).toBe("go-back pages per capability: 3 — 14 likely pages not read for 4 capabilities with a gap at Productboard");
  });
  it("capabilities per page and features per capability, when an answer was cut", () => {
    expect(capLine(hit("capabilities_per_page", MAX_CAPABILITIES_PER_PAGE, 7, 0, 2))).toBe("capabilities per page: 40 — 7 capabilities left out on 2 pages at Productboard");
    expect(capLine(hit("features_per_capability", MAX_FEATURES_PER_CAPABILITY, 3, 0, 1))).toBe("features per capability: 30 — 3 features left out on 1 page at Productboard");
  });
  it("a research answer that was unusable: the page was not read", () => {
    expect(capLine(hit("research_answer_unusable", 8000, 2, 0, 2))).toBe("research answer (output tokens): 8,000 — 2 pages skipped: the answer was cut off, empty or invalid at Productboard");
  });
  it("the second look's page and character cut", () => {
    expect(capLine(hit("second_look_pages", LOOK_MAX_PAGES, 23, 0, 6))).toBe("pages per second look: 4 — 23 candidate pages not shown in 6 second looks at Productboard");
    expect(capLine(hit("second_look_chars", LOOK_MAX_CHARS, 2, 0, 1))).toBe("characters per second look: 80,000 — 2 candidate pages left out or cut in 1 second look at Productboard");
  });
  it("a split that changes the result: merge, unify review, domains — a setup run's are not a company's", () => {
    expect(capLine(hit("merge_split", 800, 2))).toBe("capability names per merge call: 800 — the list was merged in 2 calls: the same thing in two calls can stay two items at Productboard");
    const run = { competitorId: null, company: null };
    expect(capLine(hit("unify_review_split", 600, 2, 0, 1, run))).toBe("rows per unify review call: 600 — the rows were reviewed in 2 calls: the same capability in two calls can stay two rows");
    expect(capLine(hit("domains_split", 800, 2, 0, 1, run))).toBe("rows per domains call: 800 — the domains were built in 2 calls, not in one step over all rows");
  });
  it("llms.txt and the run's log", () => {
    expect(capLine(hit("llms_txt_chars", 20_000, 3_500))).toBe("characters of llms.txt: 20,000 — 3,500 characters of the site's llms.txt not shown to the map at Productboard");
    expect(capLine(hit("log_lines", 3000, 120, 0, 1, { competitorId: null, company: null }))).toBe("log lines kept on the run: 3,000 — the 120 oldest lines of the run's log were dropped");
  });
  it("every cap has a label, a mode and a sentence", () => {
    for (const id of CAP_IDS) {
      expect(CAPS[id].label.length).toBeGreaterThan(3);
      expect(["state", "event", "once"]).toContain(CAPS[id].mode);
      expect(capLine(hit(id, 10, 2, 1, 1)).startsWith(`${CAPS[id].label}: 10 — `)).toBe(true);
    }
  });
});

describe("recording", () => {
  it("one entry per cap and company", () => {
    const list: CapHit[] = [];
    expect(recordCap(list, { cap: "second_looks_per_run", limit: 30, undone: 12, ...PB })).toMatchObject({ fresh: true, changed: true });
    recordCap(list, { cap: "second_looks_per_run", limit: 30, undone: 4, competitorId: "en", company: "Enterpret" });
    recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, ...PB });
    expect(list).toHaveLength(3);
    expect(capsOf(list, "pb").map((h) => h.cap)).toEqual(["second_looks_per_run", "token_budget"]);
  });
  it("an event cap adds up: a cap that bites on every page is one entry with the totals, and is new only once", () => {
    const list: CapHit[] = [];
    expect(recordCap(list, { cap: "capabilities_per_page", limit: 40, undone: 3, ...PB }).fresh).toBe(true);
    const again = recordCap(list, { cap: "capabilities_per_page", limit: 40, undone: 5, ...PB });
    expect(again).toMatchObject({ fresh: false, changed: true });
    expect(list).toEqual([hit("capabilities_per_page", 40, 8, 0, 2)]);
    recordCap(list, { cap: "go_back_pages_per_item", limit: 3, undone: 10, times: 4, ...PB });
    recordCap(list, { cap: "go_back_pages_per_item", limit: 3, undone: 2, times: 1, ...PB });
    expect(list[1]).toEqual(hit("go_back_pages_per_item", 3, 12, 0, 5));
  });
  it("a state cap is what is true now: the new value replaces the old one", () => {
    const list: CapHit[] = [];
    recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, ...PB });
    const later = recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, also: 12, ...PB });
    expect(later).toMatchObject({ fresh: false, changed: true });
    expect(list).toEqual([hit("token_budget", 1_000_000, 40, 12)]);
    expect(recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, also: 12, ...PB }).changed).toBe(false);
  });
  it("when a company's walk starts again its state caps are forgotten; events and once-caps stay, other companies are untouched", () => {
    const list: CapHit[] = [];
    recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, ...PB });
    recordCap(list, { cap: "second_looks_per_run", limit: 30, undone: 12, ...PB });
    recordCap(list, { cap: "capabilities_per_page", limit: 40, undone: 3, ...PB });
    recordCap(list, { cap: "merge_split", limit: 800, undone: 2, ...PB });
    recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 9, competitorId: "en", company: "Enterpret" });
    recordCap(list, { cap: "unify_review_split", limit: 600, undone: 2, competitorId: null, company: null });
    clearStateCaps(list, "pb");
    expect(list.map((h) => `${h.cap}/${h.competitorId}`)).toEqual(["capabilities_per_page/pb", "merge_split/pb", "token_budget/en", "unify_review_split/null"]);
    clearStateCaps(list, null);
    expect(list).toHaveLength(4);
  });
  it("the stored list is read entry by entry; an unknown cap is left out", () => {
    const stored = [hit("token_budget", 1_000_000, 40, 12), { cap: "no_such_cap", limit: 1 }, null, { cap: "second_looks_per_run", limit: "x", competitorId: 7, undone: 3 }];
    expect(readCaps(JSON.parse(JSON.stringify(stored)))).toEqual([hit("token_budget", 1_000_000, 40, 12), { cap: "second_looks_per_run", limit: 0, competitorId: null, company: null, undone: 3, also: 0, times: 0 }]);
    expect(readCaps(undefined)).toEqual([]);
  });
});

describe("how a run says it", () => {
  const list = [hit("second_looks_per_run", 30, 12), hit("token_budget", 1_000_000, 40), hit("token_budget", 1_000_000, 9, 0, 1, { competitorId: "en", company: "Enterpret" })];
  it("a clean run says no cap was hit", () => {
    expect(capsHeadline([])).toBe("No cap was hit");
    expect(capLines([])).toEqual([]);
    expect(capsForEvent([])).toEqual({ capsHit: 0, caps: "" });
  });
  it("a run that hit caps lists every one, in a fixed order", () => {
    expect(capsHeadline(list)).toBe("3 caps were hit");
    expect(capsHeadline(list.slice(0, 1))).toBe("1 cap was hit");
    expect(capLines(list)).toEqual([
      "token budget per company per run: 1,000,000 — 9 pages left unread at Enterpret",
      "token budget per company per run: 1,000,000 — 40 pages left unread at Productboard",
      "second looks per run: 30 — 12 capabilities not checked at Productboard",
    ]);
  });
  it("the finished event carries how many and which", () => {
    expect(capsForEvent(list)).toEqual({ capsHit: 3, caps: "token_budget,second_looks_per_run" });
  });
});

describe("where the counts come from", () => {
  const page = (id: string, text: string) => ({ id, url: `https://acme.example/help/${id}`, title: id, text, hash: id });
  it("a second look that could show every candidate page hit nothing", () => {
    const pages = indexPages([page("a", "single sign-on with SAML"), page("b", "nothing here")]);
    expect(selectLookPages({ name: "Single sign-on", aliases: [] }, pages)).toMatchObject({ candidates: 1, leftByPages: 0, leftByChars: 0 });
  });
  it("more candidate pages than a look shows: the page limit left the rest out", () => {
    const pages = indexPages(Array.from({ length: 7 }, (_, i) => page(`p${i}`, "single sign-on")));
    const s = selectLookPages({ name: "Single sign-on", aliases: [] }, pages);
    expect(s.pages).toHaveLength(LOOK_MAX_PAGES);
    expect(s).toMatchObject({ candidates: 7, leftByPages: 3, leftByChars: 0 });
    expect(pagesFor({ name: "Single sign-on", aliases: [] }, pages)).toEqual(s.pages);
  });
  it("candidate pages that do not fit the characters: the character limit left them out; a first page larger than the limit is cut", () => {
    const pages = indexPages([page("a", `single sign-on ${"x".repeat(60)}`), page("b", `single sign-on ${"y".repeat(60)}`), page("c", `single sign-on ${"z".repeat(60)}`)]);
    expect(selectLookPages({ name: "Single sign-on", aliases: [] }, pages, { maxChars: 100 })).toMatchObject({ candidates: 3, leftByPages: 0, leftByChars: 2 });
    const cut = selectLookPages({ name: "Single sign-on", aliases: [] }, indexPages([page("a", `single sign-on ${"x".repeat(200)}`)]), { maxChars: 50 });
    expect(cut.pages[0].text).toHaveLength(50);
    expect(cut.leftByChars).toBe(1);
  });
  it("go-back: an item with more likely pages than it may go back to", () => {
    const pages = indexPages(Array.from({ length: 5 }, (_, i) => page(`p${i}`, "audit log export")));
    const r = pickForItemCounted({ id: "i", key: "c:audit log", terms: ["Audit log"] }, pages, new Set());
    expect(r.picked).toHaveLength(GO_BACK_PAGES_PER_ITEM);
    expect(r.candidates).toBe(5);
    expect(pickForItem({ id: "i", key: "c:audit log", terms: ["Audit log"] }, pages, new Set())).toEqual(r.picked);
    expect(pickForItemCounted({ id: "i", key: "c:audit log", terms: ["Audit log"] }, pages.slice(0, 2), new Set())).toMatchObject({ candidates: 2 });
  });
  it("research: which of the two per-page limits cut the answer", () => {
    const text = Array.from({ length: 45 }, (_, i) => `Capability number ${i} is offered.`).join("\n") + "\n" + Array.from({ length: 33 }, (_, i) => `Feature number ${i} is part of it.`).join("\n");
    const capabilities = Array.from({ length: 45 }, (_, i) => ({
      name: `Capability ${i}`, quote: `Capability number ${i} is offered.`, reasoning: "The page says so.", description: "",
      features: i === 0 ? Array.from({ length: 33 }, (_, f) => ({ name: `Feature ${f}`, quote: `Feature number ${f} is part of it.`, reasoning: "The page says so.", description: "" })) : [],
    }));
    const r = parseResearch({ capabilities }, text);
    expect(r.dropped.overCapabilities).toBe(45 - MAX_CAPABILITIES_PER_PAGE);
    expect(r.dropped.overFeatures).toBe(33 - MAX_FEATURES_PER_CAPABILITY);
    expect(r.dropped.over).toBe(r.dropped.overCapabilities + r.dropped.overFeatures);
  });
});

describe("one email per run", () => {
  it("a run that failed, or finished having hit any cap, sends the email; nothing else does", () => {
    expect(runAlertDue({ outcome: "failed", caps: 0 })).toBe(true);
    expect(runAlertDue({ outcome: "failed", caps: 3 })).toBe(true);
    expect(runAlertDue({ outcome: "done", caps: 1 })).toBe(true);
    expect(runAlertDue({ outcome: "done", caps: 0 })).toBe(false);
    expect(runAlertDue({ outcome: "cancelled", caps: 0 })).toBe(false);
    expect(runAlertDue({ outcome: "cancelled", caps: 2 })).toBe(false);
  });
  const base: RunAlertInput = {
    kind: "analysis", outcome: "done", organization: "Aha", company: "Productboard", runId: "run-1", workspaceId: "ws-1", step: "done", error: null, errorKind: "none",
    caps: [hit("second_looks_per_run", 30, 12), hit("token_budget", 1_000_000, 40, 12), hit("capabilities_per_page", 40, 7, 0, 2)],
    models: "read gemini-4-hydrogen · match gemini-4-argon · judge gemini-4-carbon", calls: 310, inputTokens: 950_000, outputTokens: 60_000,
    startedAt: new Date("2026-11-15T10:00:00Z"), finishedAt: new Date("2026-11-15T10:42:00Z"), appUrl: "https://app.pm-os.io",
  };
  it("it is ONE email, whatever the number of caps: every cap is a line of it", () => {
    const email = runAlertEmail(base);
    expect(email.subject).toBe("[PM-OS] Analysis hit 3 limits: Productboard (Aha)");
    expect(email.text).toBe([
      "An analysis run finished, and hit a limit that should never be hit. Limits are safety nets: what is listed below was left undone.",
      "",
      "Organization: Aha",
      "Competitor:   Productboard",
      "Run:          run-1 (analysis)",
      "Ended:        done at 2026-11-15T10:42:00.000Z, after 42 min",
      "Models:       read gemini-4-hydrogen · match gemini-4-argon · judge gemini-4-carbon",
      "PMOS AI:      310 calls · 950,000 input + 60,000 output tokens",
      "",
      "Limits hit (3):",
      "  - token budget per company per run: 1,000,000 — 40 pages left unread, 12 second looks not made at Productboard",
      "  - second looks per run: 30 — 12 capabilities not checked at Productboard",
      "  - capabilities per page: 40 — 7 capabilities left out on 2 pages at Productboard",
      "",
      "What to do: raise the limit that was hit, then run the analysis again — what was left undone is still due. The token budget is in Administration → Competitors; second looks per run is the organization's setting competitorsConfig.secondLooksPerRun (1–500, no screen yet); the others are constants in src/lib/competitors/analysis.",
      "This email is sent once per run, whatever the number of limits.",
      "Run log: https://app.pm-os.io/admin/competitors",
    ].join("\n"));
  });
  it("a failed run says where and why", () => {
    const email = runAlertEmail({ ...base, outcome: "failed", step: "second_look", error: 'The model "gemini-4-hydrogen" was refused by Vertex in the second look step', errorKind: "ai", caps: [] });
    expect(email.subject).toBe("[PM-OS] Analysis failed: Productboard (Aha)");
    expect(email.text).toContain("An analysis run failed.");
    expect(email.text).toContain("Ended:        failed in the second look step at 2026-11-15T10:42:00.000Z, after 42 min");
    expect(email.text).toContain('Error:        The model "gemini-4-hydrogen" was refused by Vertex in the second look step [ai]');
    expect(email.text).toContain("Limits hit: none");
  });
  it("a failed run that also hit a limit says both in one subject", () => {
    expect(runAlertEmail({ ...base, outcome: "failed", step: "facts", error: "x", caps: base.caps.slice(0, 1) }).subject).toBe("[PM-OS] Analysis failed and hit 1 limit: Productboard (Aha)");
  });
  it("a setup run is about the organization, and says how to continue it", () => {
    const email = runAlertEmail({ ...base, kind: "setup", company: "Aha", outcome: "failed", step: "map", error: "PMOS AI call failed in the map step (model gemini-4-hydrogen, role read) — invalid_grant", errorKind: "ai", caps: [] });
    expect(email.subject).toBe("[PM-OS] Setup run failed: Aha");
    expect(email.text).toContain("Own site:     Aha");
    expect(email.text).toContain("continue the same run: --setup ws-1");
    expect(runAlertEmail({ ...base, kind: "setup", company: "Aha" }).subject).toBe("[PM-OS] Setup run hit 3 limits: Aha");
  });
  it("an analysis of the organization's own site is never called a competitor", () => {
    const email = runAlertEmail({ ...base, company: "Aha", ownSite: true });
    expect(email.subject).toBe("[PM-OS] Analysis hit 3 limits: the own site of Aha");
    expect(email.text).toContain("Own site:     Aha");
    expect(email.text).not.toContain("Competitor:");
  });
});
