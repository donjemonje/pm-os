import { COMPETITORS_COPY as C } from "./copy";
import { shortDate, timeUntil } from "./time";
import type { CompetitorRow } from "./store";

/**
 * The one-line scan summary users see under a competitor (scanner rules,
 * "what users see"): "Acme: 23 of 31 pages scanned. 5 blocked by robots.txt
 * (/pricing, /docs/*), 3 require login." or, when blocked, "Acme blocked our
 * scanner on 26 Oct (bot challenge). Showing data from 19 Oct. Next retry 2 Nov."
 */
export function scanSummaryLine(c: CompetitorRow, nextScanAt: string | null): string {
  const s = c.lastScan;
  if (!s) return "";
  const parts: string[] = [];
  if (s.badge === "blocked" || s.badge === "unreachable") {
    const why = s.badge === "blocked" ? (s.error ? `(${s.error})` : "") : s.error ? `(${s.error})` : "";
    parts.push(`${s.badge === "blocked" ? "Blocked our scanner" : "Did not answer"} on ${shortDate(s.startedAt)}${why ? ` ${why}` : ""}.`);
    if (c.lastGoodScanAt) parts.push(C.settings.showingDataFrom(shortDate(c.lastGoodScanAt)));
    if (nextScanAt) parts.push(C.settings.nextRetry(timeUntil(nextScanAt)));
    parts.push(C.settings.addFactsManually);
    return parts.join(" ");
  }
  const notRead = Object.values(s.outcomes).reduce((n, v) => n + v, 0);
  parts.push(C.settings.scanned(s.pagesFetched, s.pagesFetched + notRead));
  const details: string[] = [];
  for (const [cat, n] of Object.entries(s.outcomes)) {
    if (!n) continue;
    let label = `${n} ${C.settings.outcomeLabels[cat] ?? cat}`;
    if (cat === "robots" && s.robotsDisallowed.length) label += ` (${s.robotsDisallowed.slice(0, 3).join(", ")}${s.robotsDisallowed.length > 3 ? ", …" : ""})`;
    details.push(label);
  }
  if (details.length) parts.push(details.join(", ") + ".");
  if (s.robotsDisallowed.some((p) => /pricing|plans/i.test(p)) || Object.keys(s.outcomes).some((k) => k === "login")) parts.push(C.settings.pricingIncomplete);
  if (s.removedPages > 0) parts.push(`${s.removedPages} page${s.removedPages === 1 ? "" : "s"} removed since the previous scan.`);
  return parts.join(" ");
}
