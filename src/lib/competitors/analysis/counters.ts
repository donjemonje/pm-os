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
  /** The map, page by page: pages of help-center and blog sections it looked at in this run, and the ones it named release notes. */
  mapPagesAsked: number;
  mapReleaseNotes: number;
  /** The reading: the requests made (one per chunk of pages), and the second look's requests (one per chunk too). */
  readRequests: number;
  lookRequests: number;
  /** Incidents (incidents.ts): answers that should never happen — each is kept on the run as a case. */
  incidents: number;
  /** RETIRED with the per-page reading (kept so an old run's stored counters still read): go-back rounds and pages. */
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
  /** The visible answers and the model's own thinking together (both are billed as output). */
  outputTokens: number;
  cachedTokens: number;
  /** The part of outputTokens that was thinking, where the provider reports it. */
  thinkingTokens: number;
  waits: number;
  waitedMs: number;
  /** Proofs stored (one per item of a company's list), proofs lost (their page changed or is gone), and quotes that were not on their page (each an incident). */
  findings: number;
  findingsRemoved: number;
  quotesDropped: number;
  piiHits: number;
  itemsNew: number;
  /** RETIRED with the per-page reading: the merge step's calls and splits. */
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
  /** A setup run only (analysis/setup.ts): unify calls about capabilities, unify calls about features, domains calls. */
  unifyCalls: number;
  unifyFeatureCalls: number;
  domainsCalls: number;
  /** RETIRED (the unify step no longer leaves a capability without a row); kept so an old run's stored counters still read. */
  itemsExcluded: number;
}

export function emptyCounters(): Counters {
  return {
    mapSections: 0, mapLabeled: 0, mapCalls: 0, mapPagesAsked: 0, mapReleaseNotes: 0, readRequests: 0, lookRequests: 0, incidents: 0, goBackRounds: 0, goBackPages: 0, budget: 0, budgetReached: 0, pagesUnread: 0,
    pagesRead: 0, pagesFailed: 0, calls: 0, unusableAnswers: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, thinkingTokens: 0, waits: 0, waitedMs: 0,
    findings: 0, findingsRemoved: 0, quotesDropped: 0, piiHits: 0, itemsNew: 0, mergeCalls: 0, mergeSplits: 0,
    matchCalls: 0, matchedByName: 0, matchedByAi: 0, placed: 0, secondLooks: 0, secondLookFound: 0, secondLooksWaiting: 0,
    newCapabilities: 0, newFeatures: 0, newDomains: 0, cellsFound: 0, cellsLow: 0, cellsNotFound: 0, cellsChanged: 0,
    unifyCalls: 0, unifyFeatureCalls: 0, domainsCalls: 0, itemsExcluded: 0,
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
