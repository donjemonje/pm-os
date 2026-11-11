import { cut, tidy } from "../ai";

/**
 * The quote check (Capability Analysis, "How the analysis runs"): a finding is kept only when its quote is in the
 * stored page text. No quote, no finding. Code only, no AI.
 *
 * The comparison ignores what a model or a browser changes without changing the words: case, the kind of quote
 * mark and dash, non-breaking and zero-width characters, line breaks and runs of spaces. Nothing else: a quote
 * stitched from two passages with an ellipsis fails on purpose — one continuous passage or nothing.
 *
 * Pure: no database, no network.
 */

/** Curly and angled single quotes, primes, backtick, acute accent. */
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g;
/** Curly double quotes, double prime, guillemets. */
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g;
/** Hyphen, non-breaking hyphen, figure dash, en dash, em dash, horizontal bar, minus, small and full-width forms. */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const ELLIPSIS = /\u2026/g;
/** Zero-width space / non-joiner / joiner, word joiner, byte-order mark, soft hyphen. */
const HIDDEN = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/**
 * Lower-case, NFKC, curly quotes → straight, every dash → "-", the ellipsis character → "...", zero-width and
 * soft-hyphen characters removed, every run of whitespace (newlines and nbsp included) → one space, trimmed.
 */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(ELLIPSIS, "...")
    .replace(HIDDEN, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A shorter quote proves nothing (after normalization). */
export const MIN_QUOTE_CHARS = 12;
/** Stored length. */
export const MAX_QUOTE_CHARS = 400;

function check(quote: string, normalizedPage: string): string | null {
  const q = quote.trim();
  const n = normalizeForQuote(q);
  if (n.length < MIN_QUOTE_CHARS) return null;
  let accepted: string | null = null;
  if (normalizedPage.includes(n)) {
    accepted = q;
  } else {
    // A model sometimes splices a piece of the next JSON field into a string: try once more without it.
    const t = tidy(q);
    const tn = normalizeForQuote(t);
    if (t !== q && tn.length >= MIN_QUOTE_CHARS && normalizedPage.includes(tn)) accepted = t;
  }
  if (accepted === null) return null;
  // A prefix of a verified quote is still on the page.
  return accepted.length > MAX_QUOTE_CHARS ? cut(accepted, MAX_QUOTE_CHARS) : accepted;
}

/** The quote as it will be stored, or null when it is not in the page. */
export function verifyQuote(quote: string, pageText: string): string | null {
  return check(quote, normalizeForQuote(pageText));
}

/** The same check for many quotes of one page: the page text is normalized once. */
export function quoteChecker(pageText: string): (quote: string) => string | null {
  const page = normalizeForQuote(pageText);
  return (quote) => check(quote, page);
}
