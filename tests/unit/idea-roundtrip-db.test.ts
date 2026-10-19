import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { PrismaClient } from "@prisma/client";
import { editorExtensions } from "@/components/ideas/editor-extensions";
import { detailsForSave, docToMarkdown, markdownToDoc, type EditorNode } from "@/lib/ideas/editor-markdown";
import { markdownToAdf } from "@/lib/jira-adf";
import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * The round-trip checks of editor-markdown.test.ts over every real idea in
 * a database. Opt-in — needs a DATABASE_URL and is not part of `test:unit`:
 *
 *   IDEA_ROUNDTRIP_DB=1 node scripts/with-apphosting-env.mjs dev-apphosting.yaml -- npx vitest run tests/unit/idea-roundtrip-db.test.ts
 *
 * For each Idea.details: an unchanged document saves byte-identical; parse →
 * serialize renders the same in the view (same CommonMark tree after
 * whitespace collapse); the serializer is stable. Reports how many bodies it
 * also reproduces byte-for-byte, and how many the Jira converter
 * (`markdownToAdf`, a looser line-based parser) would push differently —
 * those are bodies where the view and Jira already disagree today, e.g. a
 * one-space-indented `- ` list or a stray ` - ` line (a setext underline).
 */
describe.skipIf(!process.env.IDEA_ROUNDTRIP_DB)("every idea in the database", () => {
  it("round-trips", async () => {
    const schema = getSchema(editorExtensions);
    const load = (md: string): EditorNode => {
      const node = schema.nodeFromJSON(markdownToDoc(md));
      node.check();
      return node.toJSON() as EditorNode;
    };
    const normalise = (k: string, v: unknown) =>
      k === "position" ? undefined : k === "text" || k === "value" ? String(v).replace(/\s+/g, " ").trim() : v;
    const viewShape = (md: string) => JSON.stringify(fromMarkdown(md), normalise);
    const adfShape = (md: string) => JSON.stringify(markdownToAdf(md), normalise);

    const prisma = new PrismaClient();
    const ideas = await prisma.idea.findMany({ select: { id: true, details: true } });
    await prisma.$disconnect();
    expect(ideas.length).toBeGreaterThan(0);

    let identical = 0;
    const jiraDiffers: string[] = [];
    const failures: string[] = [];
    for (const { id, details } of ideas) {
      const md = details ?? "";
      const doc = load(md);
      const once = docToMarkdown(doc);
      if (detailsForSave(md, doc, doc) !== md) failures.push(`${id}: unchanged save altered the text`);
      if (viewShape(once) !== viewShape(md)) failures.push(`${id}: re-serialized text renders differently`);
      if (docToMarkdown(load(once)) !== once) failures.push(`${id}: serializer is not stable`);
      if (adfShape(once) !== adfShape(md)) jiraDiffers.push(id);
      if ((md.endsWith("\n") ? `${once}\n` : once) === md) identical++;
    }
    console.log(
      `${ideas.length} ideas; serializer byte-identical on ${identical}; ` +
        `Jira converter reads ${jiraDiffers.length} differently after re-serialization: ${jiraDiffers.join(", ") || "none"}`,
    );
    expect(failures).toEqual([]);
  });
});
