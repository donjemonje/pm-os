import { describe, expect, it } from "vitest";
import { blocksOf, printPrompt, promptText, promptVersion, READ_PAGES_PROMPT, SHARED_BLOCKS, strayBlockText, type PromptDef } from "@/lib/competitors/prompts/blocks";
import { PROMPTS } from "@/lib/competitors/prompts/registry";

describe("shared prompt blocks", () => {
  it("every prompt of the app is registered once", () => {
    expect(new Set(PROMPTS.map((p) => p.name)).size).toBe(PROMPTS.length);
    expect(PROMPTS.map((p) => p.name)).toEqual(expect.arrayContaining(["read-pages", "news-intake"]));
  });
  it("no prompt holds a block's sentence in its own text: it uses the block", () => {
    for (const p of PROMPTS) expect({ prompt: p.name, stray: strayBlockText(p, SHARED_BLOCKS) }).toEqual({ prompt: p.name, stray: [] });
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
  it("a prompt's version moves when a block it uses changes, and only then", () => {
    const [block] = SHARED_BLOCKS;
    const using: PromptDef = { name: "a", title: "A", paragraphs: [["Own text."], [block]] };
    const notUsing: PromptDef = { name: "b", title: "B", paragraphs: [["Own text."]] };
    const edited = { ...block, text: `${block.text} One more rule.` };
    expect(promptVersion({ ...using, paragraphs: [["Own text."], [edited]] })).not.toBe(promptVersion(using));
    expect(promptVersion(notUsing)).toBe(promptVersion({ ...notUsing }));
  });
});
