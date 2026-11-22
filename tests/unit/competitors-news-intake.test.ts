import { describe, expect, it } from "vitest";
import { abilityPhrase, codeList, NEWS_INTAKE_PROMPT, NEWS_REQUEST_MAX_PAGES, NEWS_SYSTEM_PROMPT, newsTool, parseNews, planRequests, renderList, renderPages, type NewsPage } from "@/lib/competitors/news/intake";
import { changedText } from "@/lib/competitors/news/changed";
import { renderNewsEmail, type NewsEmailRow } from "@/lib/competitors/news/email";
import { blocksOf, FEATURE_FIELDS } from "@/lib/competitors/prompts/blocks";

const list = codeList(
  [
    { id: "k1", name: "Roadmaps", description: "Plans on a timeline." },
    { id: "f1", name: "Roadmap image export", companyName: "Export to PNG", description: "Saves a roadmap as an image." },
    { id: null, name: "Issue tracker sync", description: "Pushes work to issue trackers." },
  ],
  ["Jira"],
);
const notes: NewsPage = { url: "https://example.test/notes", title: "Notes", kind: "release_notes", publishedAt: "2026-11-20", text: "You can now compare two snapshots of a roadmap. We also hired a new sales lead. Roadmaps still export to PNG." };
const help: NewsPage = { url: "https://example.test/help", title: "Compare snapshots", kind: "help", publishedAt: null, text: "Pick two snapshots and the comparison marks every item that moved." };
const { requests } = planRequests([notes, help]);
const pages = requests[0];
const feature = (over: Record<string, unknown>) => ({
  name: "Roadmap snapshot comparison", company_name: "Compare snapshots", problem: "Without it, nobody sees what moved on a roadmap", problem_source: "stated",
  how_it_works: "Two saved versions of a roadmap go in; the product marks what moved.", users: [{ name: "Product manager", kind: "person" }, { name: "Planning agent", kind: "agent" }],
  workflows: [{ workflow: "prepare the quarterly review", step: "check what changed" }],
  evidence: [{ quote: "compare two snapshots of a roadmap", page: "P1", strength: "describes" }, { quote: "the comparison marks every item that moved", page: "P2", strength: "explains" }],
  reason: "Roadmaps holds no comparison.", ...over,
});
const answer = (over: Record<string, unknown>) => ({ pages: [{ page: "P1", about: "release notes" }, { page: "P2", about: "help" }], new_features: [], on_the_list: [], integrations: [], not_understood: [], left_out: [], ...over });

describe("news intake: the prompt is built from the list-building prompt's blocks", () => {
  it("uses the block that says how a feature is understood, not a second wording", () => {
    expect(blocksOf(NEWS_INTAKE_PROMPT).map((b) => b.name)).toEqual(["page-kinds", "feature-is", "feature-fields", "not-a-feature", "integrations-by-name", "found-means-understood"]);
    expect(NEWS_SYSTEM_PROMPT).toContain(FEATURE_FIELDS.text);
  });
  it("has no sizes: a capability and a feature are the table's words", () => {
    expect(NEWS_SYSTEM_PROMPT).not.toMatch(/capabilit/i);
  });
});

describe("news intake: the list and the request", () => {
  it("codes the list F1… as one flat list and shows the known integrations", () => {
    expect(list.features.map((f) => f.code)).toEqual(["F1", "F2", "F3"]);
    const text = renderList("Acme", list);
    expect(text).toContain("F2 | Roadmap image export | Export to PNG — Saves a roadmap as an image.");
    expect(text).toContain("KNOWN INTEGRATIONS: Jira");
  });
  it("puts several pages in one request, each with a code, its status and its kind", () => {
    expect(requests).toHaveLength(1);
    const text = renderPages(pages);
    expect(text).toContain("=== P1 | new | release note | Notes | https://example.test/notes | dated 2026-11-20");
    expect(text).toContain("=== P2 | new | help center | Compare snapshots");
  });
  it("opens another request when one is full", () => {
    const many = Array.from({ length: NEWS_REQUEST_MAX_PAGES + 1 }, (_, i) => ({ ...help, url: `https://example.test/${i}` }));
    expect(planRequests(many).requests.map((r) => r.length)).toEqual([NEWS_REQUEST_MAX_PAGES, 1]);
  });
  it("sends only the changed text of a changed page, and nothing of one with no new line", () => {
    const before = "Roadmaps\nShare a roadmap\nSend a link to anyone.";
    const plan = planRequests([{ ...help, previousText: before, text: `${before}\nCompare snapshots\nPick two snapshots and see what moved.` }, { ...notes, previousText: notes.text }]);
    expect(plan.nothingNew).toHaveLength(1);
    expect(plan.requests[0][0]).toMatchObject({ code: "P1", status: "changed" });
    expect(plan.requests[0][0].sent).toContain("Pick two snapshots and see what moved.");
    expect(plan.requests[0][0].sent).not.toContain("Send a link to anyone.");
  });
  it("requires every field of the answer (an optional field lets the model stop early)", () => {
    const walk = (node: unknown): void => {
      const n = node as { type?: string; properties?: Record<string, unknown>; required?: string[]; items?: unknown };
      if (n.type === "object") { expect([...(n.required ?? [])].sort()).toEqual(Object.keys(n.properties ?? {}).sort()); Object.values(n.properties ?? {}).forEach(walk); }
      if (n.type === "array") walk(n.items);
    };
    walk(newsTool(list.features, pages).input_schema);
  });
});

describe("news intake: what changed on a page", () => {
  const before = "Acme help\nRoadmaps\nA roadmap shows plans on a timeline.\nSharing\nSend a link to anyone.";
  it("gives the new lines under the nearest heading above them, with the page title", () => {
    const now = "Acme help\nRoadmaps\nA roadmap shows plans on a timeline.\nYou can now compare two snapshots.\nSharing\nSend a link to anyone.\nLinks can expire after a date you pick.";
    const c = changedText(before, now)!;
    expect(c.lines).toBe(2);
    expect(c.text).toBe("[page title] Acme help\n\n[under: Roadmaps]\nYou can now compare two snapshots.\n\n[under: Sharing]\nLinks can expire after a date you pick.");
  });
  it("is null when text only moved or went away", () => {
    expect(changedText(before, "Acme help\nSharing\nSend a link to anyone.\nRoadmaps")).toBeNull();
  });
});

describe("news intake: the verdict is decided in code", () => {
  it("new: a feature the list does not hold, with every quote that is on its page, the strongest first", () => {
    const { pieces, unanswered } = parseNews(answer({ new_features: [feature({})] }), list, pages);
    expect(unanswered).toEqual([]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ verdict: "new", quoteOk: true, companyName: "Compare snapshots", problemSource: "stated", audience: "Product manager, Planning agent (agent)", workflows: "prepare the quarterly review — check what changed" });
    expect(pieces[0].evidence.map((e) => e.strength)).toEqual(["explains", "describes"]);
    expect(pieces[0].page.code).toBe("P2");
  });
  it("a quote that is not on its page is left out; with none left the feature is kept but unproven", () => {
    const { pieces } = parseNews(answer({ new_features: [feature({ evidence: [{ quote: "this sentence is nowhere on the page", page: "P1", strength: "explains" }] })] }), list, pages);
    expect(pieces[0]).toMatchObject({ verdict: "new", quote: null, quoteOk: false });
  });
  it("covered: the answer names an item of the list", () => {
    const { pieces } = parseNews(answer({ on_the_list: [{ label: "PNG export", item: "F2", page: "P1", reason: "The same export." }] }), list, pages);
    expect(pieces[0]).toMatchObject({ verdict: "covered", name: "PNG export" });
    expect(pieces[0].covered?.id).toBe("f1");
  });
  it("other: what is left out, a tool we did not know, a name the pages do not explain", () => {
    const { pieces } = parseNews(answer({
      left_out: [{ label: "New sales lead", page: "P1", reason: "Hiring news.", type: "hr" }, { label: "Odd", page: "P1", reason: "x", type: "gossip" }],
      integrations: [{ tool: "Linear", page: "P1" }, { tool: "jira", page: "P1" }],
      not_understood: [{ label: "Pulse", page: "P2", missing: "No page says what it does." }],
    }), list, pages);
    expect(pieces.map((p) => `${p.verdict}/${p.otherType}/${p.name}`)).toEqual(["other/hr/New sales lead", "other/other/Odd", "other/integration/Linear", "other/not_understood/Pulse"]);
  });
  it("drops what names a code that was not given, and says which pages the answer left out", () => {
    const { pieces, dropped, unanswered } = parseNews({ ...answer({ pages: [{ page: "P1", about: "x" }], on_the_list: [{ label: "A", item: "F9", page: "P1", reason: "" }], left_out: [{ label: "B", page: "P7", reason: "", type: "hr" }], new_features: [feature({ name: "" }), feature({ evidence: [{ quote: "q", page: "P9", strength: "names" }] })] }) }, list, pages);
    expect(pieces).toHaveLength(0);
    expect(dropped).toBe(4);
    expect(unanswered).toEqual(["P2"]);
  });
});

describe("news notification", () => {
  const row = (over: Partial<NewsEmailRow>): NewsEmailRow => ({ verdict: "new", name: "Call recording", what: "A notetaker joins the call and writes the transcript.", problem: "Without it, notes are copied by hand", quote: "record the conversation", quoteOk: true, sourceUrl: "https://example.test/a", sourceTitle: "A", ...over });
  it("holds the new abilities and nothing else: title, name, one phrase, evidence and link", () => {
    const mail = renderNewsEmail({ competitorName: "Acme", simulated: false, rows: [row({}), row({ name: "Unproven", quoteOk: false, quote: null }), row({ verdict: "covered", name: "Copilot" }), row({ verdict: "other", name: "New CRO" })] });
    expect(mail.subject).toBe("Abilities updates for Acme");
    expect(mail.text).toBe("Abilities updates for Acme\n\nCall recording\nWithout it, notes are copied by hand. A notetaker joins the call and writes the transcript.\n\nEvidence\n“record the conversation”\nhttps://example.test/a\n");
    for (const absent of ["Unproven", "Copilot", "New CRO", "capability", "feature", "pages read"]) expect(mail.html).not.toContain(absent);
  });
  it("shows the stored evidence, the strongest first, and marks a simulation", () => {
    const mail = renderNewsEmail({ competitorName: "Acme", simulated: true, rows: [row({ evidence: [{ quote: "first quote here", url: "https://example.test/1", title: "One" }, { quote: "second quote here", url: "https://example.test/2", title: "Two" }] })] });
    expect(mail.subject).toBe("[Simulation] Abilities updates for Acme");
    expect(mail.text.indexOf("first quote here")).toBeLessThan(mail.text.indexOf("second quote here"));
    expect(mail.html).toContain("https://example.test/2");
  });
  it("escapes page text in the HTML", () => {
    const mail = renderNewsEmail({ competitorName: "Acme", simulated: false, rows: [row({ name: "<script>x</script>" })] });
    expect(mail.html).not.toContain("<script>x</script>");
  });
  it("one phrase: the problem, then how it works", () => {
    expect(abilityPhrase({ problem: "Without it, X.", what: "It does Y." })).toBe("Without it, X. It does Y.");
    expect(abilityPhrase({ problem: null, what: "It does Y." })).toBe("It does Y.");
  });
});
