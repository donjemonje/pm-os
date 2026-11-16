/** Capability Analysis — limits are safety nets, and an answer that should never happen is an incident (analysis/caps.ts, incidents.ts, alert.ts): what each records, how records add up, and the one email per run. Pure modules. */
import { describe, expect, it } from "vitest";
import { ALERT_INCIDENT_LINES, runAlertDue, runAlertEmail, type RunAlertInput } from "@/lib/competitors/analysis/alert";
import { ANALYSIS_TOKEN_BUDGET_DEFAULT } from "@/lib/competitors/analysis/budget";
import { ACTIVE_CAP_IDS, CAP_IDS, capLine, capLines, CAPS, capsForEvent, capsHeadline, capsOf, clearStateCaps, readCaps, recordCap, RETIRED_CAP_IDS, type CapHit, type CapId } from "@/lib/competitors/analysis/caps";
import { emptyIncidents, INCIDENT_ANSWER_KEPT, INCIDENT_QUOTE_KEPT, incidentLine, INCIDENTS_KEPT, incidentsForEvent, incidentsHeadline, incidentsOf, readIncidents, recordIncident, type Incident } from "@/lib/competitors/analysis/incidents";

const PB = { competitorId: "pb", company: "Productboard" };
const RUN = { competitorId: null, company: null };
const hit = (cap: CapId, limit: number, undone: number, also = 0, times = 1, at: { competitorId: string | null; company: string | null } = PB): CapHit => ({ cap, limit, undone, also, times, ...at });

describe("the defaults are safety nets", () => {
  it("token budget per company per run: 10,000,000", () => {
    expect(ANALYSIS_TOKEN_BUDGET_DEFAULT).toBe(10_000_000);
  });
});

describe("what each cap reports: the limit, its value, what was left undone, at which company", () => {
  it("token budget: the pages left unread, and the rows of ours a second look did not ask on every chunk", () => {
    expect(capLine(hit("token_budget", 10_000_000, 40))).toBe("token budget per company per run: 10,000,000 — 40 pages left unread at Productboard");
    expect(capLine(hit("token_budget", 10_000_000, 40, 12))).toBe("token budget per company per run: 10,000,000 — 40 pages left unread, 12 rows of ours not looked for on every chunk at Productboard");
    expect(capLine(hit("token_budget", 1_000_000, 0, 1))).toBe("token budget per company per run: 1,000,000 — 1 row of ours not looked for on every chunk at Productboard");
    expect(capLine(hit("token_budget", 1_000_000, 0))).toBe("token budget per company per run: 1,000,000 — reading stopped at Productboard");
  });
  it("a split that changes the result: unify, domains — a setup run's are not a company's", () => {
    expect(capLine(hit("unify_split", 80, 3, 0, 1, RUN))).toBe("capabilities per unify call: 80 — the capabilities were unified in 3 calls: the same capability in two calls can become two rows (one review of all rows follows)");
    expect(capLine(hit("domains_split", 800, 2, 0, 1, RUN))).toBe("rows per domains call: 800 — the domains were built in 2 calls, not in one step over all rows");
  });
  it("llms.txt and the run's log", () => {
    expect(capLine(hit("llms_txt_chars", 20_000, 3_500))).toBe("characters of llms.txt: 20,000 — 3,500 characters of the site's llms.txt not shown to the map at Productboard");
    expect(capLine(hit("log_lines", 3000, 120, 0, 1, RUN))).toBe("log lines kept on the run: 3,000 — the 120 oldest lines of the run's log were dropped");
  });
  it("the caps of the per-page reading are retired — nothing records them — and still read, so an old run shows what it hit", () => {
    expect([...ACTIVE_CAP_IDS]).toEqual(["token_budget", "unify_split", "domains_split", "llms_txt_chars", "log_lines", "speed_ceiling", "tpm_ceiling"]);
    expect([...RETIRED_CAP_IDS]).toEqual(["second_looks_per_run", "go_back_rounds", "go_back_pages_per_item", "capabilities_per_page", "features_per_capability", "research_answer_unusable", "second_look_pages", "second_look_chars", "merge_split", "unify_review_split"]);
    expect(capLine(hit("capabilities_per_page", 40, 7, 0, 2))).toBe("capabilities per page: 40 — 7 capabilities left out on 2 pages at Productboard");
    expect(readCaps([hit("go_back_rounds", 2, 5, 9)])).toHaveLength(1);
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
    expect(recordCap(list, { cap: "token_budget", limit: 30, undone: 12, ...PB })).toMatchObject({ fresh: true, changed: true });
    recordCap(list, { cap: "token_budget", limit: 30, undone: 4, competitorId: "en", company: "Enterpret" });
    recordCap(list, { cap: "llms_txt_chars", limit: 20_000, undone: 40, ...PB });
    expect(list).toHaveLength(3);
    expect(capsOf(list, "pb").map((h) => h.cap)).toEqual(["token_budget", "llms_txt_chars"]);
  });
  it("an event cap adds up: a cap that bites again is one entry with the totals, and is new only once", () => {
    const list: CapHit[] = [];
    expect(recordCap(list, { cap: "tpm_ceiling", limit: 4_000_000, undone: 30, times: 2, ...RUN }).fresh).toBe(true);
    expect(recordCap(list, { cap: "tpm_ceiling", limit: 4_000_000, undone: 12, times: 1, ...RUN })).toMatchObject({ fresh: false, changed: true });
    expect(list).toEqual([hit("tpm_ceiling", 4_000_000, 42, 0, 3, RUN)]);
  });
  it("a state cap is what is true now: the new value replaces the old one", () => {
    const list: CapHit[] = [];
    recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, ...PB });
    expect(recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, also: 12, ...PB })).toMatchObject({ fresh: false, changed: true });
    expect(list).toEqual([hit("token_budget", 1_000_000, 40, 12)]);
    expect(recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, also: 12, ...PB }).changed).toBe(false);
  });
  it("when a company's walk starts again its state caps are forgotten; once-caps stay, other companies are untouched", () => {
    const list: CapHit[] = [];
    recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 40, ...PB });
    recordCap(list, { cap: "llms_txt_chars", limit: 20_000, undone: 3, ...PB });
    recordCap(list, { cap: "token_budget", limit: 1_000_000, undone: 9, competitorId: "en", company: "Enterpret" });
    recordCap(list, { cap: "unify_split", limit: 80, undone: 2, ...RUN });
    clearStateCaps(list, "pb");
    expect(list.map((h) => `${h.cap}/${h.competitorId}`)).toEqual(["llms_txt_chars/pb", "token_budget/en", "unify_split/null"]);
    clearStateCaps(list, null);
    expect(list).toHaveLength(3);
  });
  it("the stored list is read entry by entry; an unknown cap is left out", () => {
    const stored = [hit("token_budget", 1_000_000, 40, 12), { cap: "no_such_cap", limit: 1 }, null, { cap: "unify_split", limit: "x", competitorId: 7, undone: 3 }];
    expect(readCaps(JSON.parse(JSON.stringify(stored)))).toEqual([hit("token_budget", 1_000_000, 40, 12), { cap: "unify_split", limit: 0, competitorId: null, company: null, undone: 3, also: 0, times: 0 }]);
    expect(readCaps(undefined)).toEqual([]);
  });
});

describe("how a run says it", () => {
  const list = [hit("llms_txt_chars", 20_000, 12), hit("token_budget", 1_000_000, 40), hit("token_budget", 1_000_000, 9, 0, 1, { competitorId: "en", company: "Enterpret" })];
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
      "characters of llms.txt: 20,000 — 12 characters of the site's llms.txt not shown to the map at Productboard",
    ]);
  });
  it("the finished event carries how many and which", () => {
    expect(capsForEvent(list)).toEqual({ capsHit: 3, caps: "token_budget,llms_txt_chars" });
  });
});

describe("an incident: a finding whose quote is not on the page it names is a bug — kept as a case, never just dropped", () => {
  const incident = (extra: Partial<Incident> = {}): Incident => ({
    kind: "quote_not_on_page", at: "2026-11-16T16:20:00.000Z", step: "reading", competitorId: "pb", company: "Productboard", request: 2, itemKind: "feature", item: "Voice input", parent: "Productboard Spark",
    quote: "Press Ctrl+M anywhere to start recording.", pageCode: "P494", pageUrl: "https://support.productboard.com/spark/voice", pageId: "page-494", pageHash: "abc", foundOn: null, ...extra,
  });
  it("the case keeps the company, the item, the claimed quote, the page, the step and the request", () => {
    const log = emptyIncidents();
    recordIncident(log, incident());
    expect(log).toEqual({ list: [incident()], total: 1 });
    expect(readIncidents(JSON.parse(JSON.stringify(log)))).toEqual(log);
  });
  it("one line says what was claimed, where, and what the check found: on no page of the request", () => {
    expect(incidentLine(incident())).toBe('Productboard: feature "Voice input" (under "Productboard Spark"): the quote is not on the page it names (https://support.productboard.com/spark/voice) — the quote is on no page of the request — reading request 2 — quote: "Press Ctrl+M anywhere to start recording."');
  });
  it("… or on ANOTHER page of the same request: the wrong page was named", () => {
    expect(incidentLine(incident({ foundOn: "https://support.productboard.com/spark/chat" }))).toContain("the quote is on another page of the same request (https://support.productboard.com/spark/chat): the wrong page was named");
  });
  it("a page or an item that was not given is an incident too", () => {
    expect(incidentLine(incident({ kind: "unknown_page", pageCode: "P9999", pageUrl: null }))).toBe('Productboard: feature "Voice input" (under "Productboard Spark") names the page "P9999", which is not a page of the request — reading request 2 — quote: "Press Ctrl+M anywhere to start recording."');
    expect(incidentLine(incident({ kind: "unknown_item", itemKind: "capability", item: "K77", step: "second_look", request: null }))).toBe('Productboard: the answer named capability "K77", which is not in the list it was given — second look');
  });
  it("an answer that could not be read at all is an incident too: what was wrong, and the answer's text as it came — whole, not cut like a quote", () => {
    const raw = '{"release_notes": ["P201", "P202", "P2"P204", "P205"]}';
    const unusable = incident({ kind: "unusable_answer", step: "map", request: null, itemKind: "answer", item: "PMOS AI (gemini-4-argon) returned invalid JSON (finish: STOP, 75 chars in 3 of 4 pieces): Unexpected token", parent: null, quote: raw, pageCode: "", pageUrl: null, pageId: null, pageHash: null });
    expect(incidentLine(unusable)).toBe(`Productboard: PMOS AI's answer could not be read — map — PMOS AI (gemini-4-argon) returned invalid JSON (finish: STOP, 75 chars in 3 of 4 pieces): Unexpected token — the answer as it came: "${raw}"`);
    expect(incidentLine({ ...unusable, quote: "" })).toContain("the answer as it came: (no text)");
    const log = emptyIncidents();
    recordIncident(log, { ...unusable, quote: "y".repeat(5_000) });
    recordIncident(log, incident({ quote: "q".repeat(5_000) }));
    expect(log.list.map((i) => i.quote.length)).toEqual([INCIDENT_ANSWER_KEPT, INCIDENT_QUOTE_KEPT]);
    expect(readIncidents(JSON.parse(JSON.stringify(log))).list[0].kind).toBe("unusable_answer");
    expect(incidentsForEvent(log).incidentKinds).toBe("quote_not_on_page,unusable_answer");
    // It is part of the run's one email like any incident.
    expect(runAlertDue({ outcome: "done", caps: 0, incidents: log.total })).toBe(true);
  });
  it("every incident is counted; the first INCIDENTS_KEPT keep their details; a long quote is cut", () => {
    const log = emptyIncidents();
    for (let i = 0; i < INCIDENTS_KEPT + 5; i++) recordIncident(log, incident({ item: `Item ${i}`, quote: "q".repeat(900) }));
    expect(log.total).toBe(INCIDENTS_KEPT + 5);
    expect(log.list).toHaveLength(INCIDENTS_KEPT);
    expect(log.list[0].quote).toHaveLength(600);
  });
  it("a setup run's record of one company carries only its own", () => {
    const log = emptyIncidents();
    recordIncident(log, incident());
    recordIncident(log, incident({ competitorId: "en", company: "Enterpret" }));
    expect(incidentsOf(log, "en")).toMatchObject({ total: 1, list: [{ company: "Enterpret" }] });
  });
  it("the stored log is read case by case; anything that is not a log reads as none", () => {
    expect(readIncidents(null)).toEqual(emptyIncidents());
    expect(readIncidents([1, 2])).toEqual(emptyIncidents());
    expect(readIncidents({ list: [{ kind: "no_such_kind" }, null, { kind: "unknown_item", item: "K1" }], total: 7 })).toMatchObject({ total: 7, list: [{ kind: "unknown_item", item: "K1", company: null, request: null }] });
  });
  it("how a run says it, and what the finished event carries", () => {
    expect(incidentsHeadline(emptyIncidents())).toBe("No incident");
    const log = emptyIncidents();
    recordIncident(log, incident());
    recordIncident(log, incident({ kind: "unknown_item" }));
    expect(incidentsHeadline(log)).toContain("2 incidents — an answer of PMOS AI that should never happen");
    expect(incidentsForEvent(log)).toEqual({ incidents: 2, incidentKinds: "quote_not_on_page,unknown_item" });
    expect(incidentsForEvent(emptyIncidents())).toEqual({ incidents: 0, incidentKinds: "" });
  });
});

describe("one email per run", () => {
  it("a run that failed, or finished having hit any cap or had any incident, sends the email; nothing else does", () => {
    expect(runAlertDue({ outcome: "failed", caps: 0 })).toBe(true);
    expect(runAlertDue({ outcome: "failed", caps: 3 })).toBe(true);
    expect(runAlertDue({ outcome: "done", caps: 1 })).toBe(true);
    expect(runAlertDue({ outcome: "done", caps: 0, incidents: 1 })).toBe(true);
    expect(runAlertDue({ outcome: "done", caps: 0, incidents: 0 })).toBe(false);
    expect(runAlertDue({ outcome: "done", caps: 0 })).toBe(false);
    expect(runAlertDue({ outcome: "cancelled", caps: 0 })).toBe(false);
    expect(runAlertDue({ outcome: "cancelled", caps: 2, incidents: 4 })).toBe(false);
  });
  const base: RunAlertInput = {
    kind: "analysis", outcome: "done", organization: "Aha", company: "Productboard", runId: "run-1", workspaceId: "ws-1", step: "done", error: null, errorKind: "none",
    caps: [hit("llms_txt_chars", 20_000, 12), hit("token_budget", 1_000_000, 40, 12)],
    models: "read gemini-4-argon · match gemini-4-argon · judge gemini-4-carbon", calls: 31, inputTokens: 950_000, outputTokens: 60_000,
    startedAt: new Date("2026-11-15T10:00:00Z"), finishedAt: new Date("2026-11-15T10:42:00Z"), appUrl: "https://app.pm-os.io",
  };
  const cases = (n: number) => {
    const log = emptyIncidents();
    for (let i = 0; i < n; i++) recordIncident(log, { kind: "quote_not_on_page", at: "", step: "reading", competitorId: "pb", company: "Productboard", request: 1, itemKind: "feature", item: `Feature ${i}`, parent: "Roadmaps", quote: "a quote that is nowhere", pageCode: "P1", pageUrl: "https://productboard.com/x", pageId: "p", pageHash: "h", foundOn: null });
    return log;
  };
  it("it is ONE email, whatever the number of caps: every cap is a line of it", () => {
    const email = runAlertEmail(base);
    expect(email.subject).toBe("[PM-OS] Analysis hit 2 limits: Productboard (Aha)");
    expect(email.text).toBe([
      "An analysis run finished, and hit a limit that should never be hit. Limits are safety nets: what is listed below was left undone.",
      "",
      "Organization: Aha",
      "Competitor:   Productboard",
      "Run:          run-1 (analysis)",
      "Ended:        done at 2026-11-15T10:42:00.000Z, after 42 min",
      "Models:       read gemini-4-argon · match gemini-4-argon · judge gemini-4-carbon",
      "PMOS AI:      31 calls · 950,000 input + 60,000 output tokens",
      "",
      "Limits hit (2):",
      "  - token budget per company per run: 1,000,000 — 40 pages left unread, 12 rows of ours not looked for on every chunk at Productboard",
      "  - characters of llms.txt: 20,000 — 12 characters of the site's llms.txt not shown to the map at Productboard",
      "",
      "Incidents: none",
      "",
      "What to do: raise the limit that was hit, then run the analysis again — what was left undone is still due. The token budget is in Administration → Competitors; the two ceilings of a run's speed are environment settings of the job (COMPETITORS_ANALYSIS_MAX_SPEED, COMPETITORS_ANALYSIS_TPM); the others are constants in src/lib/competitors/analysis.",
      "This email is sent once per run, whatever the number of limits.",
      "Run log: https://app.pm-os.io/admin/competitors",
    ].join("\n"));
  });
  it("a run with incidents and no cap sends the same one email: every case is a line of it", () => {
    const email = runAlertEmail({ ...base, caps: [], incidents: cases(2) });
    expect(email.subject).toBe("[PM-OS] Analysis had 2 incidents: Productboard (Aha)");
    expect(email.text).toContain("An analysis run finished, and PMOS AI gave 2 answers that should never happen. Nothing of them is in the table; each case is kept on the run to be looked at.");
    expect(email.text).toContain("Limits hit: none");
    expect(email.text).toContain("Incidents (2) — a quote that is not on the page it names, or a page or an item that was not given. The finding is not in the table:");
    expect(email.text).toContain('  - Productboard: feature "Feature 1" (under "Roadmaps"): the quote is not on the page it names (https://productboard.com/x)');
    expect(email.text).toContain("What to do: look at every incident");
  });
  it("caps and incidents together are still one email; a long list of incidents is cut and counted", () => {
    const email = runAlertEmail({ ...base, incidents: cases(ALERT_INCIDENT_LINES + 3) });
    expect(email.subject).toBe(`[PM-OS] Analysis hit 2 limits and had ${ALERT_INCIDENT_LINES + 3} incidents: Productboard (Aha)`);
    expect(email.text.split("\n").filter((l) => l.startsWith("  - Productboard: feature"))).toHaveLength(ALERT_INCIDENT_LINES);
    expect(email.text).toContain("… and 3 more: the run keeps them");
    expect(email.text).toContain("And look at every incident");
  });
  it("a failed run says where and why", () => {
    const email = runAlertEmail({ ...base, outcome: "failed", step: "second_look", error: 'The model "gemini-4-argon" was refused by Vertex in the second look step', errorKind: "ai", caps: [] });
    expect(email.subject).toBe("[PM-OS] Analysis failed: Productboard (Aha)");
    expect(email.text).toContain("An analysis run failed.");
    expect(email.text).toContain("Ended:        failed in the second look step at 2026-11-15T10:42:00.000Z, after 42 min");
    expect(email.text).toContain('Error:        The model "gemini-4-argon" was refused by Vertex in the second look step [ai]');
    expect(email.text).toContain("Limits hit: none");
  });
  it("a failed run that also hit a limit says both in one subject", () => {
    expect(runAlertEmail({ ...base, outcome: "failed", step: "apply", error: "x", caps: base.caps.slice(0, 1) }).subject).toBe("[PM-OS] Analysis failed and hit 1 limit: Productboard (Aha)");
  });
  it("a setup run is about the organization, and says how to continue it", () => {
    const email = runAlertEmail({ ...base, kind: "setup", company: "Aha", outcome: "failed", step: "reading", error: "Reading request 2 of 3 for Productboard (269 pages) got an unusable answer", errorKind: "answer", caps: [] });
    expect(email.subject).toBe("[PM-OS] Setup run failed: Aha");
    expect(email.text).toContain("Own site:     Aha");
    expect(email.text).toContain("continue the same run: --setup ws-1");
    expect(runAlertEmail({ ...base, kind: "setup", company: "Aha" }).subject).toBe("[PM-OS] Setup run hit 2 limits: Aha");
  });
  it("an analysis of the organization's own site is never called a competitor", () => {
    const email = runAlertEmail({ ...base, company: "Aha", ownSite: true });
    expect(email.subject).toBe("[PM-OS] Analysis hit 2 limits: the own site of Aha");
    expect(email.text).toContain("Own site:     Aha");
    expect(email.text).not.toContain("Competitor:");
  });
});
