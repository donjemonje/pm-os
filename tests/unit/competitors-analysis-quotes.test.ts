/** Capability Analysis — the quote check (analysis/quotes.ts): no quote on the page, no finding. Pure module. */
import { describe, expect, it } from "vitest";
import { MAX_QUOTE_CHARS, normalizeForQuote, quoteChecker, verifyQuote } from "@/lib/competitors/analysis/quotes";

const NBSP = "\u00a0";
const PAGE = [
  "Acme Core",
  "Detect threats across your whole stack \u2014 in real time.",
  "Our platform \u201cconnects\u201d to 200+ tools,",
  "so your team's alerts land in one place.",
  `Single sign-on${NBSP}(SSO) is included in every plan.`,
].join("\n");

describe("verifyQuote", () => {
  it("accepts an exact passage", () => {
    const exact = `Single sign-on${NBSP}(SSO) is included in every plan.`;
    expect(verifyQuote(exact, PAGE)).toBe(exact);
  });
  it("accepts a passage that runs across a line break", () => {
    expect(verifyQuote("connects\u201d to 200+ tools, so your team's alerts land in one place", PAGE)).not.toBeNull();
  });
  it("ignores the kind of quote mark, dash and space, and the case", () => {
    expect(verifyQuote('Our platform "connects" to 200+ tools', PAGE)).not.toBeNull();
    expect(verifyQuote("so your team\u2019s alerts land in one place", PAGE)).not.toBeNull();
    expect(verifyQuote("across your whole stack - in real time", PAGE)).not.toBeNull();
    expect(verifyQuote("across your whole stack \u2013 in real time", PAGE)).not.toBeNull();
    expect(verifyQuote("Single sign-on (SSO) is included", PAGE)).not.toBeNull();
    expect(verifyQuote("DETECT THREATS ACROSS YOUR WHOLE STACK", PAGE)).not.toBeNull();
  });
  it("refuses a quote that is too short to prove anything", () => {
    expect(verifyQuote("Acme Core", PAGE)).toBeNull();
    expect(verifyQuote("   ", PAGE)).toBeNull();
  });
  it("refuses a quote that is not on the page", () => {
    expect(verifyQuote("Detect threats across your entire stack", PAGE)).toBeNull();
  });
  it("refuses a quote stitched from two passages with an ellipsis", () => {
    expect(verifyQuote("Detect threats across your whole stack \u2026 Single sign-on (SSO) is included", PAGE)).toBeNull();
    expect(verifyQuote("Detect threats across your whole stack... Single sign-on (SSO) is included", PAGE)).toBeNull();
  });
  it("a leaked piece of the next JSON field is cut off before the check", () => {
    expect(verifyQuote("Single sign-on (SSO) is included in every plan','reasoning':'The page says so", PAGE)).toBe("Single sign-on (SSO) is included in every plan");
  });
  it("a long verified quote is stored as a prefix of at most 400 characters that is still on the page", () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const page = `Intro. ${long}. Outro.`;
    const stored = verifyQuote(long, page)!;
    expect(long.length).toBeGreaterThan(600);
    expect(stored.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(long.startsWith(stored)).toBe(true);
    expect(verifyQuote(stored, page)).toBe(stored);
  });
});

describe("normalizeForQuote / quoteChecker", () => {
  it("normalizes quotes, dashes, the ellipsis, hidden characters and whitespace", () => {
    expect(normalizeForQuote("  \u201cA\u201d\u200b \u2014 b\u00adc\u2026\n\n  D\u00a0e ")).toBe('"a" - bc... d e');
  });
  it("checks many quotes against one page", () => {
    const check = quoteChecker(PAGE);
    expect(check("Detect threats across your whole stack")).not.toBeNull();
    expect(check("Detect nothing across your whole stack")).toBeNull();
  });
});
