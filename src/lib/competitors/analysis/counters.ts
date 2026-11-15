/**
 * What an analysis run counts (Capability Analysis, "How the analysis runs"). Stored on the run
 * (CompetitorAnalysis.counters) and sent with cmp_analysis_finished. A setup run keeps one set per company and one
 * for the calls that belong to no company (unify, domains); its own counters are their sum (sumCounters).
 *
 * Pure: no database, no network.
 */

/** Everything a run counts. Stored on the run (counters) and sent with cmp_analysis_finished. */
export interface Counters {
  /** The map step: sections in the reading plan that hold pages (set by the step), sections PMOS AI labeled in this run, and its calls. */
  mapSections: number;
  mapLabeled: number;
  mapCalls: number;
  /** Going back for the gaps: the rounds this run made (set by the step) and the deep pages they chose. */
  goBackRounds: number;
  goBackPages: number;
  /** The run's token budget (set at the claim), whether it was reached (1 / 0), and the pages left unread because of it (set by the steps of each walk, not added up). */
  budget: number;
  budgetReached: number;
  pagesUnread: number;
  pagesRead: number;
  pagesFailed: number;
  /** Model calls that were made and billed — the ones whose answer was unusable included. */
  calls: number;
  /** Of those, the calls whose answer was unusable (empty, cut off, invalid JSON). */
  unusableAnswers: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  waits: number;
  waitedMs: number;
  findings: number;
  findingsRemoved: number;
  quotesDropped: number;
  piiHits: number;
  itemsNew: number;
  mergeCalls: number;
  mergeSplits: number;
  matchCalls: number;
  matchedByName: number;
  matchedByAi: number;
  placed: number;
  secondLooks: number;
  secondLookFound: number;
  /** Second looks that are due but over the run's limit or its token budget: they wait for the next run (set by the step, not added up). */
  secondLooksWaiting: number;
  newCapabilities: number;
  newFeatures: number;
  newDomains: number;
  cellsFound: number;
  cellsLow: number;
  cellsNotFound: number;
  cellsChanged: number;
  factsNew: number;
  /** A setup run only (analysis/setup.ts): unify calls (the review included), domains calls, capability items that got no row (not a capability). */
  unifyCalls: number;
  domainsCalls: number;
  itemsExcluded: number;
}

export function emptyCounters(): Counters {
  return {
    mapSections: 0, mapLabeled: 0, mapCalls: 0, goBackRounds: 0, goBackPages: 0, budget: 0, budgetReached: 0, pagesUnread: 0,
    pagesRead: 0, pagesFailed: 0, calls: 0, unusableAnswers: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, waits: 0, waitedMs: 0,
    findings: 0, findingsRemoved: 0, quotesDropped: 0, piiHits: 0, itemsNew: 0, mergeCalls: 0, mergeSplits: 0,
    matchCalls: 0, matchedByName: 0, matchedByAi: 0, placed: 0, secondLooks: 0, secondLookFound: 0, secondLooksWaiting: 0,
    newCapabilities: 0, newFeatures: 0, newDomains: 0, cellsFound: 0, cellsLow: 0, cellsNotFound: 0, cellsChanged: 0, factsNew: 0,
    unifyCalls: 0, domainsCalls: 0, itemsExcluded: 0,
  };
}

/** A run's stored counters (CompetitorAnalysis.counters), every field a number: 0 for what an older run never counted. */
export function readCounters(raw: unknown): Counters {
  const out = emptyCounters();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of Object.keys(out) as (keyof Counters)[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

/** Counters that are a state, not a count: the sum of several sets takes the largest. */
const STATE_COUNTERS: ReadonlyArray<keyof Counters> = ["budget", "budgetReached"];

/** Several sets as one: every count added up; the budget and "budget reached" are the largest of the sets. */
export function sumCounters(sets: Counters[]): Counters {
  const out = emptyCounters();
  for (const set of sets) {
    for (const k of Object.keys(out) as (keyof Counters)[]) {
      out[k] = STATE_COUNTERS.includes(k) ? Math.max(out[k], set[k]) : out[k] + set[k];
    }
  }
  return out;
}
