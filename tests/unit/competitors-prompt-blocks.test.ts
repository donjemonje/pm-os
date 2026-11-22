import { describe, expect, it } from "vitest";
import { ALL_BLOCKS, blocksOf, BUILD_DOMAIN_PROMPT, printPrompt, promptText, promptVersion, READ_PAGES_PROMPT, SHARED_BLOCKS, SORT_FEATURES_PROMPT, strayBlockText, TABLE_BLOCKS, type PromptDef } from "@/lib/competitors/prompts/blocks";
import { REVIEW_FIX_PROMPT } from "@/lib/competitors/knowledge-review-prompts";
import { plainPrompt, PROMPTS, REEVALUATE_ROW_DEF, REVIEW_FIX_DEF } from "@/lib/competitors/prompts/registry";
import { REEVALUATE_SYSTEM_PROMPT } from "@/lib/competitors/reevaluate-prompt";

describe("shared prompt blocks", () => {
  it("every prompt of the app is registered once", () => {
    expect(new Set(PROMPTS.map((p) => p.name)).size).toBe(PROMPTS.length);
    expect(PROMPTS.map((p) => p.name)).toEqual(["read-pages", "review-repeats", "review-fix", "review-not-understood", "sort-features", "build-domain", "reevaluate-row", "news-intake", "table-new-intake"]);
  });
  it("a prompt kept as one text is registered with exactly its text", () => {
    const text = "First line.\nSecond line.\n\nNext paragraph.";
    expect(promptText(plainPrompt("x", "X", text))).toBe(text);
    expect(promptText(REVIEW_FIX_DEF)).toBe(REVIEW_FIX_PROMPT);
    expect(promptText(REEVALUATE_ROW_DEF)).toBe(REEVALUATE_SYSTEM_PROMPT);
  });
  it("no prompt holds a block's sentence in its own text: it uses the block", () => {
    // KNOWN COPIES, listed so they are seen and not grown. Two prompts are still one text each in their own file and
    // repeat sentences that are blocks elsewhere: the review prompt for missing parts (how strong a piece of evidence
    // is, from "feature-fields"), and the re-evaluation of one row (what a domain and a capability are, and how a
    // score is given, from the domain-building prompt). To clear: build those two prompts from the blocks.
    const knownCopies: Record<string, string[]> = {
      "review-fix": ['"explains" when the page explains how the feature works;', '"describes" when it says what it does in a sentence or two;'],
      "reevaluate-row": [
        "A domain is one area of the work of the people who use these solutions.",
        "a smaller area inside the domain's area.",
        "1 to 5 compares the companies with one another:",
        "5 is the company that covers this capability's area most fully among the companies given, 1 the one that covers the least of those that cover anything.",
        "Companies that cover it about equally get the same score.",
        "which parts of the capability's area the company covers and which it does not.",
      ],
    };
    for (const p of PROMPTS) {
      const stray = strayBlockText(p, ALL_BLOCKS).map((s) => s.sentence);
      expect({ prompt: p.name, stray }).toEqual({ prompt: p.name, stray: knownCopies[p.name] ?? [] });
    }
  });
  it("catches a block's sentence written a second time", () => {
    const copy: PromptDef = { name: "copy", title: "Copy", paragraphs: [["Found means understood. Use only the pages given, never what you know about this company or about others."]] };
    expect(strayBlockText(copy, SHARED_BLOCKS).map((s) => s.block)).toContain("found-means-understood");
  });
  it("PMOS AI gets plain text: no mark, no block name", () => {
    for (const p of PROMPTS) {
      const text = promptText(p);
      expect(text).not.toMatch(/>>>|<<<|SHARED BLOCK/);
      for (const b of blocksOf(p)) expect(text).toContain(b.text);
    }
  });
  it("a printed prompt marks each shared block with its name and the other prompts that use it", () => {
    const news = PROMPTS.find((p) => p.name === "news-intake")!;
    const printed = printPrompt(news, PROMPTS);
    expect(printed).toContain(`>>> SHARED BLOCK "feature-fields" — also in: ${READ_PAGES_PROMPT.title}`);
    expect(printed).toContain('<<< END OF "feature-fields"');
    // Without the marks and the two header lines it is the text PMOS AI gets.
    const plain = printed.split("\n").slice(3).filter((l) => !l.startsWith(">>> ") && !l.startsWith("<<< ")).join("\n").trimEnd();
    expect(plain).toBe(promptText(news));
  });
  it("every block has its own name, and every block is used by a registered prompt", () => {
    expect(new Set(ALL_BLOCKS.map((b) => b.name)).size).toBe(ALL_BLOCKS.length);
    const used = new Set(PROMPTS.flatMap((p) => blocksOf(p).map((b) => b.name)));
    for (const b of ALL_BLOCKS) expect(used.has(b.name), b.name).toBe(true);
    // And a prompt uses no block that is outside the list the stray check reads.
    for (const name of used) expect(ALL_BLOCKS.some((b) => b.name === name), name).toBe(true);
  });
  it("the prompts that build the table are in the app, built from blocks", () => {
    expect(SORT_FEATURES_PROMPT.file).toBe("2-sort-the-features-into-domains.txt");
    expect(BUILD_DOMAIN_PROMPT.file).toBe("3-build-the-domain.txt");
    expect(promptText(SORT_FEATURES_PROMPT).startsWith("We are building a table that compares the solutions of different companies in one market. The market is divided into domains")).toBe(true);
    expect(promptText(BUILD_DOMAIN_PROMPT).endsWith("Use only the codes and the company names given.")).toBe(true);
    // The market line is one block in both; the rules of the table are blocks of the build prompt.
    expect(blocksOf(SORT_FEATURES_PROMPT).map((b) => b.name)).toContain("given-market");
    expect(blocksOf(BUILD_DOMAIN_PROMPT).map((b) => b.name)).toEqual(expect.arrayContaining(["given-market", "table-aim", "capability-is", "capability-borders", "feature-row-is", "not-a-row", "coverage-score", "score-support", "facts-and-judgment"]));
    expect(TABLE_BLOCKS.length).toBeGreaterThan(10);
  });
  it("the table prompt for a new feature is printed with the prompts it shares each block with", () => {
    const printed = printPrompt(PROMPTS.find((p) => p.name === "table-new-intake")!, PROMPTS);
    expect(printed).toContain(`>>> SHARED BLOCK "capability-borders" — also in: ${BUILD_DOMAIN_PROMPT.title}`);
    expect(printed).toContain(`>>> SHARED BLOCK "domain-how-to-decide" — also in: ${SORT_FEATURES_PROMPT.title}`);
    expect(printed).toContain(`>>> SHARED BLOCK "given-market" — also in: ${SORT_FEATURES_PROMPT.title}; ${BUILD_DOMAIN_PROMPT.title}`);
    expect(printed).not.toContain("used by this prompt only");
  });
  it("a prompt's version moves when a block it uses changes, and only then", () => {
    const [block] = SHARED_BLOCKS;
    const using: PromptDef = { name: "a", title: "A", paragraphs: [["Own text."], [block]] };
    const notUsing: PromptDef = { name: "b", title: "B", paragraphs: [["Own text."]] };
    const edited = { ...block, text: `${block.text} One more rule.` };
    expect(promptVersion({ ...using, paragraphs: [["Own text."], [edited]] })).not.toBe(promptVersion(using));
    expect(promptVersion(notUsing)).toBe(promptVersion({ ...notUsing }));
  });
});
