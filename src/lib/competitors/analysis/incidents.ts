/**
 * INCIDENTS of a run — answers of PMOS AI that should never happen (Daniel 2026-11-16: "it should never happen — it
 * means it hallucinated; not just drop — investigate").
 *
 * A finding whose quote is not on the page it names is a BUG, not something to drop silently. The finding does not
 * reach the table; the CASE is kept on the run (CompetitorAnalysis.incidents): the company, the item, the claimed
 * quote, the page, the step and the request — and whether the quote is on ANOTHER page of the same request (then
 * the model named the wrong page; otherwise the passage is on no page it was shown). The same record keeps an
 * answer that named a page or an item that is not in its closed set — and an answer that could not be read at all
 * (invalid JSON, empty, cut off): its text as it came is kept, so the cause can be read instead of guessed (the
 * first real run, 2026-11-16, stopped on "invalid JSON (finish: STOP, 75 chars)" and nothing of the answer was
 * left to look at). Incidents are shown in Administration →
 * Competitors with the cap warnings, and are part of the run's one email to support (analysis/alert.ts).
 *
 * Pure: no database, no network.
 */

export const INCIDENT_KINDS = ["quote_not_on_page", "unknown_page", "unknown_item", "unusable_answer"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** Cases kept on a run with their details; later ones are counted only (IncidentLog.total). */
export const INCIDENTS_KEPT = 300;
/** A claimed quote is kept up to this many characters; the text of an unusable answer is kept as the model boundary cut it (ai.ts RAW_ANSWER_KEPT). */
export const INCIDENT_QUOTE_KEPT = 600;
export const INCIDENT_ANSWER_KEPT = 2_200;

export interface Incident {
  kind: IncidentKind;
  /** When (ISO). */
  at: string;
  /** The step of the run: "reading" | "second_look". */
  step: string;
  competitorId: string | null;
  company: string | null;
  /** The request of the step it happened in (1 …); null when the step has no requests of its own. */
  request: number | null;
  /** "capability" | "feature" | "row" (a second look's answer for a row of ours) | "page" | "answer" (unusable_answer). */
  itemKind: string;
  /** The item's name as the answer gave it (or the code it named, for unknown_item; for unusable_answer: what was wrong with the answer). */
  item: string;
  /** For a feature: the capability it was listed under. */
  parent: string | null;
  /** The quote the answer claimed, as given (cut to 600 characters). For unusable_answer: the answer's text as it came. */
  quote: string;
  /** The page the answer named: its code in the request, and its address when the code is one of the request's. */
  pageCode: string;
  pageUrl: string | null;
  pageId: string | null;
  /** SourcePage.hash of the text the quote was checked against: the stored text can be compared later. */
  pageHash: string | null;
  /** The address of another page of the same request that DOES hold the quote; null = the quote is on no page of the request. */
  foundOn: string | null;
}

export interface IncidentLog {
  /** The first INCIDENTS_KEPT cases. */
  list: Incident[];
  /** Every incident of the run, also the ones not kept. */
  total: number;
}

export function emptyIncidents(): IncidentLog {
  return { list: [], total: 0 };
}

/** One more case on the log (changed in place). */
export function recordIncident(log: IncidentLog, i: Incident): void {
  log.total++;
  if (log.list.length < INCIDENTS_KEPT) log.list.push({ ...i, quote: i.quote.slice(0, i.kind === "unusable_answer" ? INCIDENT_ANSWER_KEPT : INCIDENT_QUOTE_KEPT) });
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The stored log (a Json column), checked case by case; anything that is not a log reads as empty. */
export function readIncidents(raw: unknown): IncidentLog {
  const out = emptyIncidents();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const x of Array.isArray(r.list) ? r.list : []) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.kind !== "string" || !(INCIDENT_KINDS as readonly string[]).includes(o.kind)) continue;
    out.list.push({
      kind: o.kind as IncidentKind, at: str(o.at) ?? "", step: str(o.step) ?? "", competitorId: str(o.competitorId), company: str(o.company),
      request: typeof o.request === "number" && Number.isFinite(o.request) ? o.request : null, itemKind: str(o.itemKind) ?? "", item: str(o.item) ?? "", parent: str(o.parent),
      quote: str(o.quote) ?? "", pageCode: str(o.pageCode) ?? "", pageUrl: str(o.pageUrl), pageId: str(o.pageId), pageHash: str(o.pageHash), foundOn: str(o.foundOn),
    });
  }
  out.total = Math.max(typeof r.total === "number" && Number.isFinite(r.total) ? r.total : 0, out.list.length);
  return out;
}

/** The cases of one company (a setup run's record of that company carries only its own). */
export function incidentsOf(log: IncidentLog, competitorId: string): IncidentLog {
  const list = log.list.filter((i) => i.competitorId === competitorId);
  return { list, total: list.length };
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s).replace(/\s+/g, " ");

/** One case in one line: what was claimed, where, and what the check found. */
export function incidentLine(i: Incident): string {
  const who = i.company ? `${i.company}: ` : "";
  const what = `${i.itemKind} "${short(i.item, 80)}"${i.parent ? ` (under "${short(i.parent, 60)}")` : ""}`;
  const where = i.request ? ` — ${i.step.replace(/_/g, " ")} request ${i.request}` : ` — ${i.step.replace(/_/g, " ")}`;
  if (i.kind === "unusable_answer") return `${who}PMOS AI's answer could not be read${where} — ${i.item} — the answer as it came: ${i.quote ? `"${i.quote.replace(/\s+/g, " ")}"` : "(no text)"}`;
  if (i.kind === "unknown_item") return `${who}the answer named ${i.itemKind} "${short(i.item, 80)}", which is not in the list it was given${where}`;
  if (i.kind === "unknown_page") return `${who}${what} names the page "${short(i.pageCode, 40)}", which is not a page of the request${where} — quote: "${short(i.quote, 160)}"`;
  const verdict = i.foundOn ? `the quote is on another page of the same request (${i.foundOn}): the wrong page was named` : "the quote is on no page of the request";
  return `${who}${what}: the quote is not on the page it names (${i.pageUrl ?? i.pageCode}) — ${verdict}${where} — quote: "${short(i.quote, 160)}"`;
}

/** "No incident" / "3 incidents (quotes that are not on their page, or names outside the list)" — the one sentence a run's log and the admin screen say. */
export function incidentsHeadline(log: IncidentLog): string {
  if (log.total === 0) return "No incident";
  return `${log.total} incident${log.total === 1 ? "" : "s"} — an answer of PMOS AI that should never happen (a quote that is not on its page, a page or an item that was not given, an answer that could not be read)`;
}

/** What a finished usage event carries. */
export function incidentsForEvent(log: IncidentLog): { incidents: number; incidentKinds: string } {
  return { incidents: log.total, incidentKinds: INCIDENT_KINDS.filter((k) => log.list.some((i) => i.kind === k)).join(",") };
}
