/**
 * Story 2 scanner rules — the pure parts: the PII check (rule 6), outcome
 * categories, people-page policy, Crawl-delay parsing, config defaults.
 */
import { describe, expect, it } from "vitest";
import { checkPii } from "@/lib/competitors/pii";
import { outcomeCategoryOf } from "@/lib/competitors/fetcher";
import { isPeoplePage } from "@/lib/competitors/crawl";
import { mergeCompetitorsConfig, SCAN_PAUSE_MS, CRAWL_DELAY_CAP_MS } from "@/lib/competitors/config";

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
    expect(outcomeCategoryOf("noindex")).toBe("policy");
    expect(outcomeCategoryOf(undefined)).toBe("timeout");
  });
});

describe("people pages are never fetched", () => {
  it("recognises team, leadership, careers and author paths, not product pages", () => {
    for (const p of ["/team", "/about/team/", "/company/leadership", "/careers/engineer", "/people", "/authors/jane", "/our-team"]) {
      expect(isPeoplePage(new URL(`https://e.com${p}`)), p).toBe(true);
    }
    for (const p of ["/platform/teams", "/pricing", "/products/team-collaboration", "/blog/team-of-one"]) {
      expect(isPeoplePage(new URL(`https://e.com${p}`)), p).toBe(false);
    }
  });
});

describe("rescan limit and pacing defaults", () => {
  it("defaults to 1 manual rescan per site per day and clamps the setting", () => {
    expect(mergeCompetitorsConfig(null).manualRescansPerDay).toBe(1);
    expect(mergeCompetitorsConfig({ manualRescansPerDay: 0 }).manualRescansPerDay).toBe(1);
    expect(mergeCompetitorsConfig({ manualRescansPerDay: 99 }).manualRescansPerDay).toBe(50);
    expect(mergeCompetitorsConfig({ manualRescansPerDay: 3 }).manualRescansPerDay).toBe(3);
  });
  it("paces at 2 s and caps a site's Crawl-delay at 10 s", () => {
    expect(SCAN_PAUSE_MS).toBe(2000);
    expect(CRAWL_DELAY_CAP_MS).toBe(10_000);
  });
});
