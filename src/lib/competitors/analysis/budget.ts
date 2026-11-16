/**
 * The token budget of one analysis run (Capability Analysis, "Map, read, go back").
 *
 * One number for the whole installation, set in Administration → Competitors: "Analysis token budget per
 * competitor, per run". It counts every token of the run — the map, the reading, match, second looks, facts
 * (the run's own counters). When the next READING call (a chunk of the reading, a chunk of a second look) would
 * pass it, no further reading call starts in this run. Match, apply and facts still run, so the table is filled
 * from what was read. Pages left unread stay due: the competitor's next run continues with a fresh budget.
 *
 * Reading order under a budget is fixed (sections.ts READ_ORDER, the "where a PM looks" order): release notes,
 * help center, developer docs, pricing, product pages, comparison pages, news — the strongest sources first, so
 * what a budget leaves unread is the weakest; then the second look; inside a kind by address.
 *
 * Pure: no database, no network.
 */

/**
 * A safety net, not a ration (Daniel 2026-11-15): a run is not expected to reach it. When one does, it is recorded
 * as a cap hit and support is emailed (analysis/caps.ts). Was 1,000,000 until then.
 */
export const ANALYSIS_TOKEN_BUDGET_DEFAULT = 10_000_000;
/** Below this a run cannot do its map, merge and match and still read a page. */
export const ANALYSIS_TOKEN_BUDGET_MIN = 100_000;
/** A ceiling against a slip of the hand (an extra zero), not a recommendation. */
export const ANALYSIS_TOKEN_BUDGET_MAX = 50_000_000;

/** What an admin entered: a whole number between the minimum and the maximum, or what is wrong with it. */
export function checkAnalysisTokenBudget(v: unknown): { value: number } | { error: string } {
  const range = `a whole number between ${ANALYSIS_TOKEN_BUDGET_MIN.toLocaleString("en-US")} and ${ANALYSIS_TOKEN_BUDGET_MAX.toLocaleString("en-US")}`;
  if (typeof v !== "number" || !Number.isInteger(v)) return { error: `The analysis token budget must be ${range}.` };
  if (v < ANALYSIS_TOKEN_BUDGET_MIN || v > ANALYSIS_TOKEN_BUDGET_MAX) return { error: `The analysis token budget must be ${range}.` };
  return { value: v };
}

/** The stored setting as a budget: the default when it was never set, or holds anything that is not a valid budget. */
export function analysisTokenBudgetOf(stored: unknown): number {
  const checked = checkAnalysisTokenBudget(stored);
  return "value" in checked ? checked.value : ANALYSIS_TOKEN_BUDGET_DEFAULT;
}

/**
 * The gate every reading call of a run passes. `used` reads the run's token counters (every token of the run so
 * far). A call is admitted while what was used, plus the estimates of the reading calls in flight, plus its own
 * estimate stay within the limit. The first call that would pass the limit closes the gate for the rest of the
 * run: no later call is admitted, however small.
 *
 * One exception, so a page larger than the whole budget cannot block every run forever: the first reading call of
 * a run is admitted when nothing else is in flight and its estimate alone is over the limit. The gate closes behind it.
 */
export class ReadingBudget {
  readonly limit: number;
  private readonly used: () => number;
  private reserved = 0;
  private admitted = 0;
  private closed = false;

  constructor(limit: number, used: () => number) {
    this.limit = limit;
    this.used = used;
  }

  /** The budget was reached: no further reading call starts in this run. */
  get reached(): boolean {
    return this.closed;
  }

  /** May a reading call with this estimate start? True reserves the estimate until release(). */
  admit(estimate: number): boolean {
    if (this.closed) return false;
    const e = Math.max(0, estimate);
    if (this.admitted === 0 && e > this.limit) {
      this.closed = true;
      this.admitted++;
      this.reserved += e;
      return true;
    }
    if (this.used() + this.reserved + e > this.limit) {
      this.closed = true;
      return false;
    }
    this.admitted++;
    this.reserved += e;
    return true;
  }

  /** The call ended (its real tokens are in the counters now) or did not start after all. */
  release(estimate: number): void {
    this.reserved = Math.max(0, this.reserved - Math.max(0, estimate));
  }
}
