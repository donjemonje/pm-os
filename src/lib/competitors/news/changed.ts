import { normalizeForQuote } from "../analysis/quotes";

/**
 * WHAT CHANGED ON A PAGE — of a page that changed, the news intake gets only the text that was not on the page
 * before, each part under the nearest heading above it (Daniel 2026-11-22). A new page is sent whole.
 *
 * By line. A line of the current text is "changed" when the previous text did not hold it (as many times): a line
 * that only moved is not news. Runs of changed lines are kept in the page's order.
 *
 * The stored text keeps no heading marks (html.ts flattens a page to lines), so "the heading above" is the nearest
 * line above the run that LOOKS like one: short, and not ending as a sentence does. The page's first line (its
 * title) is always given. A changed part that opens with its own heading (a new section), or has no such line above
 * it, is given without one.
 *
 * Pure: no database, no network.
 */

/** A heading is at most this long. */
const HEADING_MAX_CHARS = 80;
const looksLikeHeading = (line: string) => line.length >= 3 && line.length <= HEADING_MAX_CHARS && !/[.!?,;:…]$/.test(line) && /\p{L}/u.test(line);

export interface ChangedText {
  /** The text to send: the title line, then each changed part under its heading. */
  text: string;
  /** Changed lines in all. */
  lines: number;
}

/** null = no line of the current text is new (the page changed only by losing or moving text). */
export function changedText(previous: string, current: string): ChangedText | null {
  const had = new Map<string, number>();
  for (const raw of previous.split("\n")) {
    const key = normalizeForQuote(raw);
    if (key) had.set(key, (had.get(key) ?? 0) + 1);
  }
  const lines = current.split("\n").map((l) => l.trim()).filter(Boolean);
  const isNew = lines.map((l) => {
    const key = normalizeForQuote(l);
    const left = had.get(key) ?? 0;
    if (left > 0) { had.set(key, left - 1); return false; }
    return true;
  });
  const total = isNew.filter(Boolean).length;
  if (total === 0) return null;

  const out: string[] = [];
  if (lines.length && !isNew[0]) out.push(`[page title] ${lines[0]}`);
  let lastHeading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!isNew[i]) continue;
    const start = i;
    while (i + 1 < lines.length && isNew[i + 1]) i++;
    // A changed part that opens with its own heading (a whole new section) needs none above it.
    const ownHeading = i > start && looksLikeHeading(lines[start]);
    let heading: string | null = null;
    if (!ownHeading) for (let k = start - 1; k > 0; k--) if (looksLikeHeading(lines[k])) { heading = lines[k]; break; }
    if (out.length) out.push("");
    // The same heading is not repeated for the next part under it.
    if (heading && heading !== lastHeading) out.push(`[under: ${heading}]`);
    lastHeading = ownHeading ? lines[start] : heading ?? lastHeading;
    out.push(...lines.slice(start, i + 1));
  }
  return { text: out.join("\n"), lines: total };
}
