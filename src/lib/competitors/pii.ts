/**
 * The "no people" rule (scanner rule 6): nothing about a person is stored.
 * People pages are never fetched (crawl.ts); this is the last line — a
 * pattern check on every snippet and fact before it is saved. A hit drops
 * the text and is counted on the scan (expected to stay at zero).
 */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
/** International and local phone shapes with at least 9 digits in total. */
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const PROFILE_URL = /(?:linkedin\.com\/in\/|twitter\.com\/|x\.com\/|facebook\.com\/|instagram\.com\/)[\w.-]+/i;
/** "Jane Doe, CEO" / "CTO John Smith" — a capitalised name next to a title. */
const NAME_WITH_TITLE = /\b(?:[A-Z][a-z]+ [A-Z][a-z]+(?:-[A-Z][a-z]+)?),? (?:is |– |— |- )?(?:our |the )?(?:CEO|CTO|CFO|COO|CISO|CMO|CRO|CPO|VP|SVP|EVP|Chief|Founder|Co-Founder|President|Director|Head of)\b|\b(?:CEO|CTO|CFO|COO|CISO|CMO|CRO|CPO|VP|SVP|EVP|Chief [A-Z][a-z]+ Officer|Founder|Co-Founder|President) [A-Z][a-z]+ [A-Z][a-z]+\b/;

export interface PiiCheck {
  hit: boolean;
  kind: "email" | "phone" | "profile" | "name" | null;
}

export function checkPii(text: string | null | undefined): PiiCheck {
  if (!text) return { hit: false, kind: null };
  if (EMAIL.test(text)) return { hit: true, kind: "email" };
  if (PROFILE_URL.test(text)) return { hit: true, kind: "profile" };
  const digits = (text.match(PHONE)?.[0] ?? "").replace(/\D/g, "");
  if (digits.length >= 9 && digits.length <= 15) return { hit: true, kind: "phone" };
  if (NAME_WITH_TITLE.test(text)) return { hit: true, kind: "name" };
  return { hit: false, kind: null };
}
