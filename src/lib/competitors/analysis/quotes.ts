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

/**
 * Lower-case, NFKC, curly quotes → straight, every dash → "-", "…" → "...", zero-width and soft-hyphen characters
 * removed, every run of whitespace (newlines and nbsp included) → one space, trimmed.
 */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/…/g, "...")
    .replace(/[​-‍⁠﻿­]/g, "")
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
