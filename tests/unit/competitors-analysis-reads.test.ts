/** Capability Analysis — "What the analysis reads" (analysis/reads.ts): one switch per kind of content, for the installation; release notes win over where they sit; a setting, not a cap. Pure module. */
import { describe, expect, it } from "vitest";
import { checkReadSetting, effectiveReads, looksForReleaseNotes, notReadLine, READ_DEFAULTS, READ_KIND_TEXT, READ_KINDS, readKindOf, readNotRead, readRunReads, readSettingOf, readsLine, splitByReads, storedReadSetting, type ReadSetting } from "@/lib/competitors/analysis/reads";
import { pickReadable, ReadingPlan, READ_ORDER, SECTION_LABELS, sortByWhereAPmLooks, type PlanPage, type SectionLabel } from "@/lib/competitors/analysis/sections";

const HOST = "acme.example";
const page = (path: string, extra: Partial<PlanPage> = {}): PlanPage => ({ id: path, url: `https://www.${HOST}${path}`, state: "present", kind: "page", sourceId: "web", sourceType: "website", hasText: true, chars: 4_000, ...extra });
const plan = new ReadingPlan((Object.entries({ "/": "product", "/pricing": "pricing", "/vs": "compare", "/changelog": "release_notes", "/developers": "api_docs", "/help": "help", "/blog": "news", "/customers": "noise" }) as Array<[string, SectionLabel]>).map(([path, label]) => ({ sourceId: "web", prefix: `${HOST}${path}`, label })));
const PAGES = [page("/"), page("/pricing"), page("/vs/other"), page("/changelog/2026"), page("/developers/api"), page("/help/add-a-user"), page("/help/sso", { chars: 8_000 }), page("/help/whats-new", { readAs: "release_notes" }), page("/blog/opinion"), page("/blog/changelog-may", { readAs: "release_notes" }), page("/customers/big-bank")];
const withKind = pickReadable(PAGES, plan);
const idsOf = (setting: ReadSetting) => splitByReads(withKind, setting).read.map((p) => p.id);

describe("the setting", () => {
  it("one switch per kind of content the map labels — every label but noise, which is not a kind of content", () => {
    expect([...READ_KINDS]).toEqual(["product", "pricing", "compare", "release_notes", "api_docs", "help", "news"]);
    expect([...READ_KINDS].sort()).toEqual(SECTION_LABELS.filter((l) => l !== "noise").sort());
    expect([...READ_KINDS].sort()).toEqual([...READ_ORDER].sort());
  });
  it("defaults: help center OFF, blog and news OFF, everything else ON", () => {
    expect(READ_DEFAULTS).toEqual({ product: true, pricing: true, compare: true, release_notes: true, api_docs: true, help: false, news: false });
    expect(readSettingOf(undefined)).toEqual(READ_DEFAULTS);
    expect(readSettingOf("junk")).toEqual(READ_DEFAULTS);
  });
  it("what is stored wins kind by kind; a kind that was never stored — or is not true or false — keeps its default", () => {
    expect(readSettingOf({ kinds: { help: true, product: false, news: "yes", bogus: true } })).toEqual({ ...READ_DEFAULTS, help: true, product: false });
    expect(readSettingOf(storedReadSetting({ ...READ_DEFAULTS, news: true }))).toEqual({ ...READ_DEFAULTS, news: true });
  });
  it("what an admin sends is checked: only kinds, only true or false, at least one", () => {
    expect(checkReadSetting({ help: true })).toEqual({ value: { help: true } });
    expect(checkReadSetting({ help: true, news: false })).toEqual({ value: { help: true, news: false } });
    expect(checkReadSetting({ noise: true })).toMatchObject({ error: expect.stringContaining('"noise" is not a kind of content') });
    expect(checkReadSetting({ help: "on" })).toMatchObject({ error: '"help" must be true or false.' });
    for (const bad of [null, [], "help", {}]) expect("error" in checkReadSetting(bad)).toBe(true);
  });
  it("every switch has a label, one line of help and a short name — the text Administration shows", () => {
    for (const k of READ_KINDS) {
      expect(READ_KIND_TEXT[k].label.length, k).toBeGreaterThan(3);
      expect(READ_KIND_TEXT[k].help.split("\n"), k).toHaveLength(1);
    }
    expect(READ_KINDS.map((k) => READ_KIND_TEXT[k].label)).toEqual(["Product pages", "Pricing", "Compare pages", "Release notes", "Developer / API docs", "Help center", "Blog and news"]);
  });
  it("one line for the run's log and for Administration", () => {
    expect(readsLine(READ_DEFAULTS)).toBe("Reading: product, pricing, compare, release notes, developer docs — not read: help center, blog and news");
    expect(readsLine({ ...READ_DEFAULTS, help: true, news: true })).toBe("Reading: product, pricing, compare, release notes, developer docs, help center, blog and news");
  });
  it("room for a company's own override: it is laid on top of the installation's setting; none exists today", () => {
    expect(effectiveReads(READ_DEFAULTS, null)).toEqual(READ_DEFAULTS);
    expect(effectiveReads(READ_DEFAULTS)).toEqual(READ_DEFAULTS);
    expect(effectiveReads(READ_DEFAULTS, { help: true, api_docs: false })).toEqual({ ...READ_DEFAULTS, help: true, api_docs: false });
  });
});

describe("the reading asks the setting — no kind is read or left out because the code says so", () => {
  it("with the defaults: product, pricing, compare, release notes and developer docs are read; the help center and the blog are not", () => {
    expect(idsOf(READ_DEFAULTS)).toEqual(["/", "/blog/changelog-may", "/changelog/2026", "/developers/api", "/help/whats-new", "/pricing", "/vs/other"]);
  });
  it("every kind can be turned off, and every kind can be turned on", () => {
    for (const k of READ_KINDS) {
      const off = splitByReads(withKind, { ...READ_DEFAULTS, [k]: false }).read;
      expect(off.some((p) => readKindOf(p.read) === k), `${k} off`).toBe(false);
      const on = splitByReads(withKind, { ...READ_DEFAULTS, [k]: true }).read;
      expect(on.some((p) => readKindOf(p.read) === k), `${k} on`).toBe(true);
    }
    const nothing = Object.fromEntries(READ_KINDS.map((k) => [k, false])) as ReadSetting;
    expect(idsOf(nothing)).toEqual([]);
    expect(readsLine(nothing)).toBe("Reading: nothing — not read: product, pricing, compare, release notes, developer docs, help center, blog and news");
  });
  it("noise is never read, whatever the setting says", () => {
    const everything = Object.fromEntries(READ_KINDS.map((k) => [k, true])) as ReadSetting;
    expect(idsOf(everything)).not.toContain("/customers/big-bank");
    expect(idsOf(everything)).toHaveLength(PAGES.length - 1);
  });
});

describe("release notes win over where they sit", () => {
  it("help center OFF, release notes ON: a release-notes page INSIDE the help center is still read; the other help pages are not", () => {
    const read = idsOf(READ_DEFAULTS);
    expect(read).toContain("/help/whats-new");
    expect(read).not.toContain("/help/add-a-user");
    expect(read).not.toContain("/help/sso");
  });
  it("blog OFF, release notes ON: a changelog published as a blog post is read as release notes; the rest of the blog stays unread", () => {
    const read = idsOf(READ_DEFAULTS);
    expect(read).toContain("/blog/changelog-may");
    expect(read).not.toContain("/blog/opinion");
  });
  it("release notes OFF: those pages are not read either — they are release notes, not help or blog pages — even with the help center and the blog ON", () => {
    const read = idsOf({ ...READ_DEFAULTS, release_notes: false, help: true, news: true });
    expect(read).not.toContain("/help/whats-new");
    expect(read).not.toContain("/blog/changelog-may");
    expect(read).not.toContain("/changelog/2026");
    expect(read).toContain("/help/sso");
    expect(read).toContain("/blog/opinion");
  });
  it("the map looks for them only while Release notes is on — whether the help center and the blog are on or off", () => {
    expect(looksForReleaseNotes(READ_DEFAULTS)).toBe(true);
    expect(looksForReleaseNotes({ ...READ_DEFAULTS, help: true, news: true })).toBe(true);
    expect(looksForReleaseNotes({ ...READ_DEFAULTS, release_notes: false })).toBe(false);
    expect(looksForReleaseNotes({ ...READ_DEFAULTS, release_notes: false, help: true, news: true })).toBe(false);
  });
  it("a page the map could not look at (its call's answer was unusable) is what its section is — nothing later depends on the look", () => {
    const notLooked = pickReadable([page("/help/maybe-release-notes"), page("/blog/maybe-changelog")], plan);
    expect(notLooked.map((p) => p.read.label)).toEqual(["news", "help"]);
    expect(splitByReads(notLooked, READ_DEFAULTS).read).toEqual([]);
    // Looked at by a later run and named: it becomes due as a release-notes page.
    const named = pickReadable([page("/help/maybe-release-notes", { readAs: "release_notes" })], plan);
    expect(splitByReads(named, READ_DEFAULTS).read.map((p) => p.read.label)).toEqual(["release_notes"]);
  });
  it("they are read first, with the other release notes — where a PM looks first", () => {
    const ordered = sortByWhereAPmLooks(splitByReads(withKind, READ_DEFAULTS).read).map((p) => p.id);
    expect(ordered.slice(0, 3)).toEqual(["/blog/changelog-may", "/changelog/2026", "/help/whats-new"]);
  });
});

describe("a kind that is OFF is a configuration, not a cap: what it leaves out is counted and recorded, nothing is deleted", () => {
  const { read, notRead } = splitByReads(withKind, READ_DEFAULTS);
  it("counts the pages and the tokens left out, per kind that is off", () => {
    expect(notRead).toEqual({ help: { pages: 2, tokens: 3_000 }, news: { pages: 1, tokens: 1_000 } });
    expect(read.length + 3).toBe(withKind.length);
  });
  it("one line of it, for the run's log and for the company's chunk list", () => {
    expect(notReadLine(notRead)).toBe("2 help center pages (~3k tokens as stored), 1 blog and news page (~1k tokens as stored)");
    expect(notReadLine({})).toBe("");
    expect(notReadLine({ help: { pages: 5_546, tokens: 113_109_000 } })).toBe("5,546 help center pages (~113,109k tokens as stored)");
  });
  it("turning a kind ON makes its pages due: they were never dropped, only left out", () => {
    const on = splitByReads(withKind, { ...READ_DEFAULTS, help: true });
    expect(on.notRead).toEqual({ news: { pages: 1, tokens: 1_000 } });
    expect(on.read.map((p) => p.id)).toEqual(expect.arrayContaining(["/help/add-a-user", "/help/sso"]));
  });
  it("every run records the kinds that were on, and what it left out; a run from before the setting has no record", () => {
    const stored = JSON.parse(JSON.stringify({ kinds: READ_DEFAULTS, notRead }));
    expect(readRunReads(stored)).toEqual({ kinds: READ_DEFAULTS, notRead });
    expect(readsLine(readRunReads(stored)!.kinds)).toBe("Reading: product, pricing, compare, release notes, developer docs — not read: help center, blog and news");
    expect(readRunReads(null)).toBeNull();
    expect(readRunReads({})).toBeNull();
    expect(readNotRead({ help: { pages: 0, tokens: 9 }, bogus: { pages: 3 }, news: "x" })).toEqual({});
  });
});
