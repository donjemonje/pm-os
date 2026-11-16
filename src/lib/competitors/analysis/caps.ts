/**
 * The caps of the capability analysis, and what a run records when it hits one (Daniel 2026-11-15).
 *
 * Limits are safety nets — they exist for abuse and mistakes only. A run should never hit one; when it does, it is
 * recorded and surfaced, never silent: a structured entry on the run (CompetitorAnalysis.caps), a warn line in the
 * run's log, a warning on the run in Administration → Competitors, the finished usage event, and ONE email per run
 * to support (analysis/alert.ts). A run that hit none shows "no cap was hit".
 *
 * What is a cap: a hard limit that leaves work undone or changes the result. Batching that only splits a list into
 * calls is not one — unless the split changes the result (a unify or a domains step that could not see its whole
 * list in one call). Reading rules (news off by default) are design, not caps.
 *
 * The caps of the old per-page reading (RETIRED_CAP_IDS) are no longer recorded by anything; their definitions stay
 * so a run from before 2026-11-16 still shows what it hit.
 *
 * Pure: no database, no network.
 */

/** Caps a run can hit today. */
export const ACTIVE_CAP_IDS = ["token_budget", "unify_split", "domains_split", "llms_txt_chars", "log_lines", "speed_ceiling", "tpm_ceiling"] as const;
/** Caps of the per-page reading, the merge step, the go-back rounds and the per-capability second look: nothing records them any more. */
export const RETIRED_CAP_IDS = [
  "second_looks_per_run",
  "go_back_rounds",
  "go_back_pages_per_item",
  "capabilities_per_page",
  "features_per_capability",
  "research_answer_unusable",
  "second_look_pages",
  "second_look_chars",
  "merge_split",
  "unify_review_split",
] as const;
export const CAP_IDS = [...ACTIVE_CAP_IDS, ...RETIRED_CAP_IDS] as const;
export type CapId = (typeof CAP_IDS)[number];

const n = (v: number) => v.toLocaleString("en-US");
const s = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/**
 * How a cap's record behaves when it is recorded again:
 *   state — what is true at the end of a walk (pages left unread, looks not made): the new value replaces the old
 *           one, and the record is cleared when the company's walk starts again (a run that continues and no longer
 *           hits it is clean).
 *   event — something that happened once per unit of work (a page whose answer was cut): the values add up. Work
 *           that was done is not done again when a run continues, so nothing is counted twice.
 *   once  — decided once per run and not re-evaluated when it continues (a list that was split): the value
 *           replaces, and the record stays.
 */
export type CapMode = "state" | "event" | "once";

export interface CapDefinition {
  /** What the limit is called — the start of every line about it. */
  label: string;
  mode: CapMode;
  /** What was left undone: `undone` and `also` are the cap's two counts, `times` how many times it bit. */
  undone: (h: Pick<CapHit, "undone" | "also" | "times">) => string;
}

export interface CapHit {
  cap: CapId;
  /** The value of the limit when it was hit. */
  limit: number;
  /** The company it was hit for; null = the run as a whole (a setup run's unify and domains). */
  competitorId: string | null;
  company: string | null;
  /** The cap's main count of what was left undone (see CAPS[cap].undone). */
  undone: number;
  /** Its second count, when it has one. */
  also: number;
  /** How many times it bit (pages, capabilities, looks). */
  times: number;
}

export const CAPS: Record<CapId, CapDefinition> = {
  token_budget: {
    label: "token budget per company per run",
    mode: "state",
    undone: (h) => [h.undone ? `${s(h.undone, "page")} left unread` : "", h.also ? `${s(h.also, "row")} of ours not looked for on every chunk` : ""].filter(Boolean).join(", ") || "reading stopped",
  },
  unify_split: { label: "capabilities per unify call", mode: "once", undone: (h) => `the capabilities were unified in ${s(h.undone, "call")}: the same capability in two calls can become two rows (one review of all rows follows)` },
  second_looks_per_run: { label: "second looks per run", mode: "state", undone: (h) => `${s(h.undone, "capability", "capabilities")} not checked` },
  go_back_rounds: {
    label: "go-back rounds per run",
    mode: "state",
    undone: (h) => `${s(h.undone, "capability", "capabilities")} still ${h.undone === 1 ? "has" : "have"} a gap and ${s(h.also, "more deep page")} ${h.also === 1 ? "was" : "were"} due`,
  },
  go_back_pages_per_item: { label: "go-back pages per capability", mode: "event", undone: (h) => `${s(h.undone, "likely page")} not read for ${s(h.times, "capability", "capabilities")} with a gap` },
  capabilities_per_page: { label: "capabilities per page", mode: "event", undone: (h) => `${s(h.undone, "capability", "capabilities")} left out on ${s(h.times, "page")}` },
  features_per_capability: { label: "features per capability", mode: "event", undone: (h) => `${s(h.undone, "feature")} left out on ${s(h.times, "page")}` },
  research_answer_unusable: { label: "research answer (output tokens)", mode: "event", undone: (h) => `${s(h.undone, "page")} skipped: the answer was cut off, empty or invalid` },
  second_look_pages: { label: "pages per second look", mode: "event", undone: (h) => `${s(h.undone, "candidate page")} not shown in ${s(h.times, "second look")}` },
  second_look_chars: { label: "characters per second look", mode: "event", undone: (h) => `${s(h.undone, "candidate page")} left out or cut in ${s(h.times, "second look")}` },
  merge_split: { label: "capability names per merge call", mode: "once", undone: (h) => `the list was merged in ${s(h.undone, "call")}: the same thing in two calls can stay two items` },
  unify_review_split: { label: "rows per unify review call", mode: "once", undone: (h) => `the rows were reviewed in ${s(h.undone, "call")}: the same capability in two calls can stay two rows` },
  domains_split: { label: "rows per domains call", mode: "once", undone: (h) => `the domains were built in ${s(h.undone, "call")}, not in one step over all rows` },
  llms_txt_chars: { label: "characters of llms.txt", mode: "once", undone: (h) => `${s(h.undone, "character")} of the site's llms.txt not shown to the map` },
  log_lines: { label: "log lines kept on the run", mode: "state", undone: (h) => `the ${s(h.undone, "oldest line")} of the run's log ${h.undone === 1 ? "was" : "were"} dropped` },
  // The two ceilings of the run's speed (pacing.ts): safety nets — a run paces itself from the provider's answers and should never be held back by them.
  speed_ceiling: { label: "calls at once (speed ceiling, COMPETITORS_ANALYSIS_MAX_SPEED)", mode: "once", undone: () => "the run reached the ceiling while the provider still took every call: it could have gone faster" },
  tpm_ceiling: { label: "tokens per minute (ceiling, COMPETITORS_ANALYSIS_TPM)", mode: "event", undone: (h) => `${s(h.times, "call")} held back, ${s(h.undone, "second")} in all` },
};

/** "second looks per run: 30 — 12 capabilities not checked at Productboard" */
export function capLine(h: CapHit): string {
  const d = CAPS[h.cap];
  return `${d.label}: ${n(h.limit)} — ${d.undone(h)}${h.company ? ` at ${h.company}` : ""}`;
}

const sameKey = (a: Pick<CapHit, "cap" | "competitorId">, b: Pick<CapHit, "cap" | "competitorId">) => a.cap === b.cap && a.competitorId === b.competitorId;

export interface CapReport {
  cap: CapId;
  limit: number;
  competitorId: string | null;
  company: string | null;
  undone: number;
  also?: number;
  times?: number;
}

/**
 * Record a hit on the run's list (changed in place). One entry per cap and company: an "event" cap adds to it, a
 * "state" or "once" cap replaces it. Returns the entry and whether what it says changed — the caller writes a warn
 * line to the run's log only then, so a cap that bites on every page does not fill the log.
 */
export function recordCap(list: CapHit[], r: CapReport): { hit: CapHit; fresh: boolean; changed: boolean } {
  const report: CapHit = { cap: r.cap, limit: r.limit, competitorId: r.competitorId, company: r.company, undone: Math.max(0, r.undone), also: Math.max(0, r.also ?? 0), times: Math.max(0, r.times ?? 1) };
  const at = list.findIndex((h) => sameKey(h, report));
  if (at < 0) {
    list.push(report);
    return { hit: report, fresh: true, changed: true };
  }
  const old = list[at];
  const next: CapHit = CAPS[r.cap].mode === "event" ? { ...report, undone: old.undone + report.undone, also: old.also + report.also, times: old.times + report.times } : report;
  const changed = next.undone !== old.undone || next.also !== old.also || next.times !== old.times || next.limit !== old.limit;
  list[at] = next;
  return { hit: next, fresh: false, changed };
}

/**
 * A company's walk starts (again): its "state" caps are forgotten — the walk records them again when they are
 * still true. `only` narrows it to some caps.
 */
export function clearStateCaps(list: CapHit[], competitorId: string | null, only?: readonly CapId[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    if (h.competitorId === competitorId && CAPS[h.cap].mode === "state" && (!only || only.includes(h.cap))) list.splice(i, 1);
  }
}

/** The stored list (a Json column), checked entry by entry: anything that is not a hit of a known cap is left out. */
export function readCaps(raw: unknown): CapHit[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const out: CapHit[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.cap !== "string" || !(CAP_IDS as readonly string[]).includes(o.cap)) continue;
    out.push({
      cap: o.cap as CapId, limit: num(o.limit), competitorId: typeof o.competitorId === "string" ? o.competitorId : null, company: typeof o.company === "string" && o.company ? o.company : null,
      undone: num(o.undone), also: num(o.also), times: num(o.times),
    });
  }
  return out;
}

/** The caps of one company (a setup run's record of that company carries only its own). */
export function capsOf(list: CapHit[], competitorId: string): CapHit[] {
  return list.filter((h) => h.competitorId === competitorId);
}

/** The lines of a run's caps, in the order of CAP_IDS, then by company. [] = no cap was hit. */
export function capLines(list: CapHit[]): string[] {
  return [...list]
    .sort((a, b) => CAP_IDS.indexOf(a.cap) - CAP_IDS.indexOf(b.cap) || (a.company ?? "").localeCompare(b.company ?? ""))
    .map(capLine);
}

/** What a finished usage event carries: how many caps were hit, and which (distinct ids, in the order of CAP_IDS). */
export function capsForEvent(list: CapHit[]): { capsHit: number; caps: string } {
  const ids = CAP_IDS.filter((id) => list.some((h) => h.cap === id));
  return { capsHit: list.length, caps: ids.join(",") };
}

/** "No cap was hit" / "2 caps were hit" — the one sentence a run's log and the admin screen say. */
export function capsHeadline(list: CapHit[]): string {
  return list.length === 0 ? "No cap was hit" : `${list.length} cap${list.length === 1 ? " was" : "s were"} hit`;
}
