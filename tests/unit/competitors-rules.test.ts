/**
 * Scanner rules — the pure parts: the PII check on extracted snippets,
 * outcome categories (the PRD's reasons list), text normalization before
 * hashing, pacing and config defaults. People pages are fetched like any
 * other page since the Website Scanning PRD (2026-11-04).
 */
import { describe, expect, it } from "vitest";
import { checkPii } from "@/lib/competitors/pii";
import { isRetryable, outcomeCategoryOf } from "@/lib/competitors/fetcher";
import { contentHash, normalizeText } from "@/lib/competitors/html";
import { mergeCompetitorsConfig, scanPauseMs, CRAWL_DELAY_CAP_MS } from "@/lib/competitors/config";

describe("checkPii — nothing about a person is stored", () => {
  it("catches emails, phones, profile links and name + title", () => {
    expect(checkPii("Contact sales at jane.doe@acme.com for a quote").kind).toBe("email");
    expect(checkPii("Call +1 (415) 555-0199 today").kind).toBe("phone");
    expect(checkPii("Follow us: linkedin.com/in/jane-doe").kind).toBe("profile");
    expect(checkPii("Jane Doe, CEO of Acme, said the platform…").kind).toBe("name");
    expect(checkPii("CTO John Smith presented the roadmap").kind).toBe("name");
  });
  it("lets ordinary product text through, including numbers and brand names", () => {
    for (const ok of [
      "Takedowns now cover social accounts and app stores · v6.4",
      "SOC 2 Type II and ISO 27001 certified",
      "Integrates with Splunk, Sentinel and XSOAR — 40+ connectors",
      "Enterprise tier · 24/7 support · 99.9% SLA",
      "Founded in 2009; 1,900+ customers",
      "",
    ]) {
      expect(checkPii(ok).hit, ok).toBe(false);
    }
    expect(checkPii(null).hit).toBe(false);
  });
});

describe("outcome categories — what users see", () => {
  it("maps every fetch error to one of the user-facing buckets", () => {
    expect(outcomeCategoryOf("botwall")).toBe("denied");
    expect(outcomeCategoryOf("http4xx")).toBe("denied");
    expect(outcomeCategoryOf("login")).toBe("login");
    expect(outcomeCategoryOf("notfound")).toBe("notfound");
    expect(outcomeCategoryOf("timeout")).toBe("timeout");
    expect(outcomeCategoryOf("http5xx")).toBe("timeout");
    expect(outcomeCategoryOf("noindex")).toBe("robots");
    expect(outcomeCategoryOf("slowdown")).toBe("slowdown");
    expect(outcomeCategoryOf(undefined)).toBe("timeout");
  });
  it("retries only transient failures", () => {
    expect(isRetryable("timeout")).toBe(true);
    expect(isRetryable("http5xx")).toBe(true);
    expect(isRetryable("notfound")).toBe(false);
    expect(isRetryable("botwall")).toBe(false);
    expect(isRetryable("slowdown")).toBe(false);
  });
});

describe("text is normalized before hashing (dates and tracking strings are not a change)", () => {
  const page = "Pricing\nStarter $49 per month\nLast updated 2026-11-04 10:15\n© 2026 Acme\nSee https://acme.com/x?utm_source=nav&gclid=abc123DEF\nvisitor 3f9a8c7d6e5b4a3f9a8c7d6e5b4a3f9a";
  it("drops dates, times, copyright years, tracking params and long ids", () => {
    const n = normalizeText(page);
    expect(n).toContain("Starter $49 per month");
    expect(n).not.toMatch(/2026-11-04|10:15|© 2026|utm_source|gclid|3f9a8c7d6e5b4a3f/);
  });
  it("gives the same hash when only the noise moved, a different one when a price did", () => {
    const a = contentHash(page);
    const b = contentHash(page.replace("2026-11-04 10:15", "2026-11-06 09:02").replace("utm_source=nav", "utm_source=footer"));
    const c = contentHash(page.replace("$49", "$59"));
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});

describe("pacing defaults", () => {
  it("has no daily manual-scan limit: an old stored value is dropped from the config", () => {
    expect(mergeCompetitorsConfig({ manualRescansPerDay: 3 })).not.toHaveProperty("manualRescansPerDay");
  });
  it("paces at 2 s and caps a site's Crawl-delay at 10 s", () => {
    expect(scanPauseMs()).toBe(2000);
    expect(CRAWL_DELAY_CAP_MS).toBe(10_000);
  });
});
