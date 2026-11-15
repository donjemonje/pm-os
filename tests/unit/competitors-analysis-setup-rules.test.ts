/** Capability Analysis — the setup run's rules (analysis/setup-rules.ts, analysis/counters.ts): "set up", refusals, the order of the companies, progress. Pure modules. */
import { describe, expect, it } from "vitest";
import { emptyCounters, readCounters, sumCounters } from "@/lib/competitors/analysis/counters";
import { analysisMayRun, queueFilter } from "@/lib/competitors/analysis/gate";
import {
  analysisFillsTable,
  catalogEditable,
  companiesInSetup,
  emptySetupProgress,
  isOrgSetupState,
  nextSetupState,
  ORG_SETUP_STATES,
  orderCompanies,
  orgSetupState,
  readSetupProgress,
  setupRefusal,
  setupStateOf,
  setupTotals,
  type SetupCompany,
  type SetupRequest,
} from "@/lib/competitors/analysis/setup-rules";

describe("what an organization's data says about setup (organizations that were never given a state)", () => {
  it("no domain and no capability, in any state, and no setup run → not set up", () => {
    expect(setupStateOf({ domains: 0, capabilities: 0, lastSetupStatus: null })).toBe("not_set_up");
  });
  it("a catalog typed by hand → set up (existing organizations: nothing changes)", () => {
    expect(setupStateOf({ domains: 12, capabilities: 138, lastSetupStatus: null })).toBe("set_up");
    expect(setupStateOf({ domains: 1, capabilities: 0, lastSetupStatus: null })).toBe("set_up");
    expect(setupStateOf({ domains: 0, capabilities: 1, lastSetupStatus: null })).toBe("set_up");
  });
  it("a setup run that finished → set up", () => {
    expect(setupStateOf({ domains: 9, capabilities: 120, lastSetupStatus: "done" })).toBe("set_up");
  });
  it("a setup run that did not finish → in setup, whatever the catalog holds", () => {
    for (const status of ["queued", "running", "waiting", "failed", "cancelled"]) {
      expect(setupStateOf({ domains: 0, capabilities: 0, lastSetupStatus: status })).toBe("in_setup");
      expect(setupStateOf({ domains: 9, capabilities: 120, lastSetupStatus: status })).toBe("in_setup");
    }
  });
  it("a finished setup run whose catalog was erased → not set up again", () => {
    expect(setupStateOf({ domains: 0, capabilities: 0, lastSetupStatus: "done" })).toBe("not_set_up");
  });
});

describe("setup is an explicit state of the organization: required → in setup → done", () => {
  const EMPTY = { domains: 0, capabilities: 0, lastSetupStatus: null };
  const CATALOG = { domains: 12, capabilities: 138, lastSetupStatus: null };

  it("the stored state wins over whatever the data says", () => {
    expect(orgSetupState("required", CATALOG)).toBe("required");
    expect(orgSetupState("in_setup", EMPTY)).toBe("in_setup");
    expect(orgSetupState("done", EMPTY)).toBe("done");
    expect(orgSetupState("done", { domains: 0, capabilities: 0, lastSetupStatus: "failed" })).toBe("done");
  });
  it("the rule for existing organizations: never given a state and already has a catalog → done, with no manual step", () => {
    expect(orgSetupState(null, CATALOG)).toBe("done");
    expect(orgSetupState(undefined, { domains: 7, capabilities: 47, lastSetupStatus: "done" })).toBe("done");
    expect(orgSetupState(null, { domains: 1, capabilities: 0, lastSetupStatus: null })).toBe("done");
  });
  it("never given a state, a setup run that did not finish → in setup; nothing at all → required", () => {
    for (const status of ["queued", "running", "waiting", "failed", "cancelled"]) expect(orgSetupState(null, { domains: 0, capabilities: 0, lastSetupStatus: status })).toBe("in_setup");
    expect(orgSetupState(null, EMPTY)).toBe("required");
    expect(orgSetupState(null, { domains: 0, capabilities: 0, lastSetupStatus: "done" })).toBe("required");
  });
  it("a stored value that is not a state is not one: the data decides", () => {
    expect(orgSetupState("set_up", CATALOG)).toBe("done");
    expect(orgSetupState("", EMPTY)).toBe("required");
    expect(orgSetupState(true, EMPTY)).toBe("required");
    expect(isOrgSetupState("done")).toBe(true);
    expect(isOrgSetupState("not_set_up")).toBe(false);
    expect(ORG_SETUP_STATES).toEqual(["required", "in_setup", "done"]);
  });
  it("turning Competitors on keeps the state: a new organization is required, a set-up one stays done", () => {
    expect(nextSetupState(orgSetupState(null, EMPTY), "enabled")).toBe("required");
    expect(nextSetupState(orgSetupState(null, CATALOG), "enabled")).toBe("done");
    expect(nextSetupState("in_setup", "enabled")).toBe("in_setup");
  });
  it("the setup run moves it: queued → in setup, finished → done; a run that stopped stays in setup and is continued", () => {
    expect(nextSetupState("required", "run_queued")).toBe("in_setup");
    expect(nextSetupState("in_setup", "run_queued")).toBe("in_setup");
    expect(nextSetupState("in_setup", "run_stopped")).toBe("in_setup");
    expect(nextSetupState("in_setup", "run_done")).toBe("done");
    expect(nextSetupState("required", "run_done")).toBe("done");
  });
  it("done is never left by an event — only a PM-OS admin sets it back by hand", () => {
    for (const event of ["enabled", "run_queued", "run_done", "run_stopped"] as const) expect(nextSetupState("done", event)).toBe("done");
  });
  it("until it is done: an analysis creates no row, and the catalog cannot be typed in by hand", () => {
    expect(analysisFillsTable("done")).toBe(true);
    expect(analysisFillsTable("required")).toBe(false);
    expect(analysisFillsTable("in_setup")).toBe(false);
    expect(catalogEditable("done")).toBe(true);
    expect(catalogEditable("required")).toBe(false);
    expect(catalogEditable("in_setup")).toBe(false);
  });
});

describe("why a setup run is refused", () => {
  const ok: SetupRequest = { state: "required", domains: 0, capabilities: 0, lastSetupStatus: null, hasOwnSource: true, activeScans: [], competitorsWithPages: 4 };
  it("nothing in the way → it may be queued", () => {
    expect(setupRefusal(ok)).toBeNull();
  });
  it("the organization's setup is done — the state decides, not the catalog", () => {
    const r = setupRefusal({ ...ok, state: "done", domains: 7, capabilities: 47 });
    expect(r?.reason).toBe("set_up");
    expect(r?.message).toContain("7 domains, 47 capabilities");
    expect(setupRefusal({ ...ok, state: "done", domains: 3, capabilities: 40, lastSetupStatus: "done" })?.reason).toBe("set_up");
    expect(setupRefusal({ ...ok, state: "done" })?.reason).toBe("set_up");
    // A PM-OS admin set an organization that has a catalog back to "required": the setup run may be queued.
    expect(setupRefusal({ ...ok, state: "required", domains: 7, capabilities: 47 })).toBeNull();
  });
  it("there is no own source", () => {
    const r = setupRefusal({ ...ok, hasOwnSource: false });
    expect(r?.reason).toBe("no_own_source");
    expect(r?.message).toContain("--own-site");
  });
  it("a scan of the own source or of a competitor is still queued, running or pending", () => {
    const r = setupRefusal({ ...ok, activeScans: [{ company: "ChatPRD", status: "running" }, { company: "Aha", status: "pending_local" }] });
    expect(r?.reason).toBe("scan_active");
    expect(r?.message).toContain("ChatPRD (running)");
    expect(r?.message).toContain("Aha (pending local)");
    expect(setupRefusal({ ...ok, activeScans: [{ company: "Bagel AI", status: "queued" }] })?.reason).toBe("scan_active");
  });
  it("no competitor has stored pages", () => {
    expect(setupRefusal({ ...ok, competitorsWithPages: 0 })?.reason).toBe("no_pages");
  });
  it("a setup run is queued or in progress", () => {
    for (const status of ["queued", "running", "waiting"]) expect(setupRefusal({ ...ok, lastSetupStatus: status })?.reason).toBe("active");
  });
  it("a setup run that failed or was cancelled is not a refusal: it is continued — with the same checks", () => {
    expect(setupRefusal({ ...ok, state: "in_setup", lastSetupStatus: "failed" })).toBeNull();
    expect(setupRefusal({ ...ok, state: "in_setup", lastSetupStatus: "cancelled", domains: 9, capabilities: 120 })).toBeNull();
    expect(setupRefusal({ ...ok, state: "in_setup", lastSetupStatus: "failed", hasOwnSource: false })?.reason).toBe("no_own_source");
    expect(setupRefusal({ ...ok, state: "in_setup", lastSetupStatus: "failed", activeScans: [{ company: "Enterpret", status: "running" }] })?.reason).toBe("scan_active");
  });
  it("the reasons are checked in a fixed order: active, set up, own source, scans, pages", () => {
    const all: SetupRequest = { state: "done", domains: 2, capabilities: 2, lastSetupStatus: null, hasOwnSource: false, activeScans: [{ company: "X", status: "running" }], competitorsWithPages: 0 };
    expect(setupRefusal(all)?.reason).toBe("set_up");
    expect(setupRefusal({ ...all, state: "required", domains: 0, capabilities: 0 })?.reason).toBe("no_own_source");
    expect(setupRefusal({ ...all, state: "required", domains: 0, capabilities: 0, hasOwnSource: true })?.reason).toBe("scan_active");
    expect(setupRefusal({ ...all, state: "required", domains: 0, capabilities: 0, hasOwnSource: true, activeScans: [] })?.reason).toBe("no_pages");
    expect(setupRefusal({ ...all, lastSetupStatus: "running" })?.reason).toBe("active");
  });
});

describe("the companies of a setup run", () => {
  const C = (id: string, name: string, position: number, pages: number, isOwn = false): SetupCompany => ({ id, name, host: `${id}.example`, websiteUrl: `https://${id}.example`, isOwn, position, pages });
  const companies = [C("pb", "Productboard", 103, 1550), C("en", "Enterpret", 6, 1530), C("us", "Aha", 0, 240, true), C("bg", "Bagel AI", 101, 102), C("new", "Newcomer", 104, 0), C("en2", "Enterpret", 6, 10)];
  it("the own source first, then the competitors by position, then by name, then by id — whatever order they are loaded in", () => {
    expect(orderCompanies(companies).map((c) => c.id)).toEqual(["us", "en", "en2", "bg", "pb", "new"]);
    expect(orderCompanies([...companies].reverse()).map((c) => c.id)).toEqual(["us", "en", "en2", "bg", "pb", "new"]);
  });
  it("a competitor with no stored page is not part of the run; the own source always is", () => {
    const { work, skipped } = companiesInSetup(companies);
    expect(work.map((c) => c.id)).toEqual(["us", "en", "en2", "bg", "pb"]);
    expect(skipped.map((c) => c.id)).toEqual(["new"]);
    expect(companiesInSetup([C("us", "Aha", 0, 0, true), C("bg", "Bagel AI", 1, 5)]).work.map((c) => c.id)).toEqual(["us", "bg"]);
  });
});

describe("the recorded progress", () => {
  it("anything that is not progress reads as empty", () => {
    expect(readSetupProgress(null)).toEqual(emptySetupProgress());
    expect(readSetupProgress("x")).toEqual(emptySetupProgress());
    expect(readSetupProgress({ companies: [{ name: "no id" }, null, 7] }).companies).toEqual([]);
  });
  it("is read field by field: an unknown stage is waiting, a missing number is 0", () => {
    const p = readSetupProgress({ rows: 12, domains: "x", companies: [{ competitorId: "c1", name: "Acme", own: true, stage: "flying", pagesDone: 3, counters: { calls: 2, inputTokens: 100 } }] });
    expect(p.rows).toBe(12);
    expect(p.domains).toBe(0);
    expect(p.companies[0]).toMatchObject({ competitorId: "c1", name: "Acme", own: true, stage: "waiting", pagesTotal: 0, pagesDone: 3, appliedAt: null });
    expect(p.companies[0].counters.calls).toBe(2);
    expect(p.companies[0].counters.outputTokens).toBe(0);
  });
  it("the run's counters are the sum of its companies and of the shared calls; the budget is per company, not added up", () => {
    const a = { ...emptyCounters(), calls: 10, inputTokens: 1000, outputTokens: 200, pagesRead: 8, budget: 1_000_000, budgetReached: 1, pagesUnread: 40 };
    const b = { ...emptyCounters(), calls: 4, inputTokens: 300, outputTokens: 50, pagesRead: 3, budget: 1_000_000, budgetReached: 0, pagesUnread: 0 };
    const shared = { ...emptyCounters(), calls: 2, inputTokens: 500, outputTokens: 100, unifyCalls: 1, domainsCalls: 1 };
    const total = sumCounters([a, b, shared]);
    expect(total).toMatchObject({ calls: 16, inputTokens: 1800, outputTokens: 350, pagesRead: 11, pagesUnread: 40, unifyCalls: 1, domainsCalls: 1, budget: 1_000_000, budgetReached: 1 });
    const progress = { ...emptySetupProgress(), shared, companies: [
      { competitorId: "a", name: "A", own: true, stage: "done" as const, pagesTotal: 10, pagesDone: 8, appliedAt: null, counters: a, usage: [] },
      { competitorId: "b", name: "B", own: false, stage: "apply" as const, pagesTotal: 3, pagesDone: 3, appliedAt: null, counters: b, usage: [] },
    ] };
    expect(setupTotals(progress)).toMatchObject({ pagesTotal: 13, pagesDone: 11 });
    expect(setupTotals(progress).counters.calls).toBe(16);
  });
  it("counters stored by a run from before a counter existed read as 0 for it", () => {
    expect(readCounters({ calls: 3 }).unifyCalls).toBe(0);
    expect(readCounters({ calls: 3 }).itemsExcluded).toBe(0);
  });
});

describe("the setup run and the PMOS AI switch", () => {
  it("the setup run is started by hand: it runs with the AI step off, like a manual analysis", () => {
    expect(analysisMayRun({ trigger: "setup", injected: false }, { aiOff: true })).toBe(true);
    expect(analysisMayRun({ trigger: "setup", injected: false }, { aiOff: false })).toBe(true);
  });
  it("with the AI step off the queue admits a queued setup run", () => {
    expect(JSON.stringify(queueFilter({ aiOff: true }))).toContain('"setup"');
  });
});
