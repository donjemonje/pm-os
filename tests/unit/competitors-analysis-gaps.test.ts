/** Capability Analysis — gaps and going back for them (analysis/gaps.ts): the gap checks, which items are due, which deep pages are picked. Pure module. */
import { describe, expect, it } from "vitest";
import {
  dueForGoBack,
  gapFeatureWithoutDescription,
  gapNoDescription,
  gapNoFeature,
  gapsOf,
  GO_BACK_MAX_ROUNDS,
  GO_BACK_PAGES_PER_ITEM,
  hasGap,
  MARKETING_KINDS,
  pickForItem,
  pickGoBackPages,
  savedGoBackRounds,
  type GapFinding,
  type GoBackItem,
} from "@/lib/competitors/analysis/gaps";
import { LABEL_RULES } from "@/lib/competitors/analysis/sections";
import { indexPages, type LookPage } from "@/lib/competitors/analysis/secondlook";

const f = (pageKind: string, description: string | null = null): GapFinding => ({ pageKind, description });
const said = "Signs every user in once.";

describe("g1 — no description, or marketing pages only give it one", () => {
  it("no finding has a description → gap", () => {
    expect(gapNoDescription({ findings: [] })).toBe(true);
    expect(gapNoDescription({ findings: [f("product"), f("docs"), f("pricing", "   ")] })).toBe(true);
  });
  it("every description comes from a product or compare page → gap", () => {
    expect(MARKETING_KINDS).toEqual([LABEL_RULES.product.kind, LABEL_RULES.compare.kind]);
    expect(gapNoDescription({ findings: [f("product", said)] })).toBe(true);
    expect(gapNoDescription({ findings: [f("product", said), f("content", said), f("docs")] })).toBe(true);
  });
  it("one description from a help, release-notes, API-docs, pricing or news page → no gap", () => {
    for (const kind of ["docs", "pricing", "news"]) expect(gapNoDescription({ findings: [f("product", said), f(kind, said)] }), kind).toBe(false);
    expect(gapNoDescription({ findings: [f("docs", said)] })).toBe(false);
  });
});

describe("g2 — no feature", () => {
  it("yes with none, no with one", () => {
    expect(gapNoFeature({ features: [] })).toBe(true);
    expect(gapNoFeature({ features: [{ findings: [] }] })).toBe(false);
  });
});

describe("g3 — one of its features has no description", () => {
  it("a feature none of whose findings has a description → gap; a description from any page closes it", () => {
    expect(gapFeatureWithoutDescription({ features: [{ findings: [f("product", said)] }, { findings: [f("docs")] }] })).toBe(true);
    expect(gapFeatureWithoutDescription({ features: [{ findings: [] }] })).toBe(true);
    expect(gapFeatureWithoutDescription({ features: [{ findings: [f("product", said)] }, { findings: [f("docs"), f("content", said)] }] })).toBe(false);
  });
  it("no feature is g2's gap, not g3's", () => {
    expect(gapFeatureWithoutDescription({ features: [] })).toBe(false);
  });
});

describe("gapsOf / hasGap", () => {
  it("each check answers on its own", () => {
    expect(gapsOf({ findings: [f("product", said)], features: [] })).toEqual({ g1: true, g2: true, g3: false });
    expect(gapsOf({ findings: [f("docs", said)], features: [{ findings: [f("product")] }] })).toEqual({ g1: false, g2: false, g3: true });
  });
  it("an item with a description from a non-marketing page and described features has no gap", () => {
    const whole = { findings: [f("product", said), f("docs", said)], features: [{ findings: [f("product", said)] }] };
    expect(gapsOf(whole)).toEqual({ g1: false, g2: false, g3: false });
    expect(hasGap(whole)).toBe(false);
    expect(hasGap({ ...whole, features: [] })).toBe(true);
  });
});

describe("dueForGoBack — a run goes back for an item only when something about it is new", () => {
  const checked = new Date("2026-11-10T10:00:00Z");
  it("never checked → due", () => {
    expect(dueForGoBack({ gapCheckedAt: null, newestFindingAt: null })).toBe(true);
    expect(dueForGoBack({ gapCheckedAt: null, newestFindingAt: checked })).toBe(true);
  });
  it("checked, and nothing found since → not due (a run with nothing new to read reads nothing for it)", () => {
    expect(dueForGoBack({ gapCheckedAt: checked, newestFindingAt: new Date("2026-11-10T09:59:59Z") })).toBe(false);
    expect(dueForGoBack({ gapCheckedAt: checked, newestFindingAt: checked })).toBe(false);
    expect(dueForGoBack({ gapCheckedAt: checked, newestFindingAt: null })).toBe(false);
  });
  it("a finding after the check (a page of it was read again, or a new page carries it) → due again", () => {
    expect(dueForGoBack({ gapCheckedAt: checked, newestFindingAt: new Date("2026-11-12T08:00:00Z") })).toBe(true);
  });
});

describe("picking the pages to go back to", () => {
  const page = (path: string, title: string, text: string): LookPage => ({ id: path, url: `https://acme.example${path}`, title, text, hash: `h${path}` });
  const pages = indexPages([
    page("/help/sso/setup", "Set up single sign-on", "Single sign-on with SAML. Single sign-on for every plan."),
    page("/help/sso/okta", "Okta", "Connect Okta for single sign-on."),
    page("/help/sso/azure", "Azure AD", "single sign-on through Azure."),
    page("/help/sso/faq", "FAQ", "About single sign-on."),
    page("/help/audit/export", "Export the audit log", "Audit log export to your SIEM."),
    page("/help/billing/invoices", "Invoices", "Download your invoices."),
  ]);
  const item = (id: string, key: string, ...terms: string[]): GoBackItem => ({ id, key, terms });

  it("the constants: 2 rounds per run, 3 pages per item per round", () => {
    expect(GO_BACK_MAX_ROUNDS).toBe(2);
    expect(GO_BACK_PAGES_PER_ITEM).toBe(3);
  });
  it("an item takes its best-scoring pages, at most the limit, best first", () => {
    const taken = new Set<string>();
    expect(pickForItem(item("i1", "c:single sign on", "Single sign-on", "SSO"), pages, taken)).toEqual(["/help/sso/setup", "/help/sso/azure", "/help/sso/faq"]);
    expect([...taken].sort()).toEqual(["/help/sso/azure", "/help/sso/faq", "/help/sso/setup"]);
    expect(pickForItem(item("i1", "c:single sign on", "Single sign-on"), pages, new Set(), 1)).toEqual(["/help/sso/setup"]);
  });
  it("no page scores above zero → nothing for that item", () => {
    expect(pickForItem(item("i9", "c:quantum routing", "Quantum routing"), pages, new Set())).toEqual([]);
    expect(pickGoBackPages([item("i9", "c:quantum routing", "Quantum routing")], pages)).toEqual({ picks: [], pageIds: [] });
  });
  it("a page is picked once: the item that comes first (by key) keeps it, the next takes its next best", () => {
    const r = pickGoBackPages([item("b", "c:sso", "single sign-on"), item("a", "c:identity", "single sign-on")], pages, { perItem: 2 });
    expect(r.picks).toEqual([
      { itemId: "a", pageIds: ["/help/sso/setup", "/help/sso/azure"] },
      { itemId: "b", pageIds: ["/help/sso/faq", "/help/sso/okta"] },
    ]);
    expect(new Set(r.pageIds).size).toBe(r.pageIds.length);
  });
  it("pages an earlier round chose are never picked again", () => {
    const r = pickGoBackPages([item("a", "c:sso", "single sign-on")], pages, { taken: ["/help/sso/setup", "/help/sso/azure", "/help/sso/faq"] });
    expect(r.pageIds).toEqual(["/help/sso/okta"]);
  });
  it("the item's wordings count like its name", () => {
    expect(pickGoBackPages([item("a", "c:log export", "Activity trail", "Audit log export")], pages).pageIds).toEqual(["/help/audit/export"]);
  });
  it("deterministic: the same items in any order give the same picks", () => {
    const items = [item("a", "c:identity", "single sign-on"), item("b", "c:audit", "Audit log export"), item("c", "c:sso", "SSO", "single sign-on")];
    expect(pickGoBackPages([...items].reverse(), pages)).toEqual(pickGoBackPages(items, pages));
  });
});

describe("savedGoBackRounds — what the run's cursor holds", () => {
  it("the page ids of each round, in order", () => {
    expect(savedGoBackRounds({ goBack: { rounds: [["p1", "p2"], ["p3"]] } })).toEqual([["p1", "p2"], ["p3"]]);
  });
  it("nothing saved, or a cursor that holds something else → no round", () => {
    for (const cursor of [{}, { goBack: null }, { goBack: [] }, { goBack: { rounds: "x" } }, { factsBaselineSources: ["s"] }]) expect(savedGoBackRounds(cursor)).toEqual([]);
  });
  it("never more rounds than a run makes; values that are not ids are dropped", () => {
    expect(savedGoBackRounds({ goBack: { rounds: [["a", 7, null], "x", ["c"]] } })).toEqual([["a"], []]);
    expect(savedGoBackRounds({ goBack: { rounds: [["a"], ["b"], ["c"]] } })).toHaveLength(GO_BACK_MAX_ROUNDS);
  });
});
