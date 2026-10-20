import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { editorExtensions } from "@/components/ideas/editor-extensions";
import {
  detailsForSave,
  docToMarkdown,
  markdownToDoc,
  type EditorNode,
} from "@/lib/ideas/editor-markdown";
import { markdownToAdf } from "@/lib/jira-adf";
import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * Round-trip safety of the idea Details editor (handoff 2026-10-19).
 *
 * Every body goes through the real editor schema (`schema.nodeFromJSON` +
 * `check()`), exactly as the Tiptap editor normalises it on load, so the
 * JSON compared here is the JSON the component compares at save.
 *
 * `scripts/check-idea-roundtrip.mjs` runs the same three checks over every
 * idea in a dev database; the fixtures below mirror the shapes found there
 * on 2026-10-19 (155 bodies) without copying customer text into the repo.
 */

const schema = getSchema(editorExtensions);

/** Markdown → document as the editor holds it. */
function load(md: string): EditorNode {
  const node = schema.nodeFromJSON(markdownToDoc(md));
  node.check();
  return node.toJSON() as EditorNode;
}

const roundTrip = (md: string) => docToMarkdown(load(md));

/** Collapse whitespace inside text and drop source positions. */
const normalise = (k: string, v: unknown) =>
  k === "position" ? undefined : k === "text" || k === "value" ? String(v).replace(/\s+/g, " ").trim() : v;

/** What the view renders (react-markdown is CommonMark, like mdast). */
const viewShape = (md: string) => JSON.stringify(fromMarkdown(md), normalise);

/** What the Jira push sends. */
const adfShape = (md: string) => JSON.stringify(markdownToAdf(md), normalise);

/** Bodies in the exact shape PMOS AI writes at import — must survive untouched. */
const CANONICAL: Record<string, string> = {
  "three sections": `## The Problem
Visual Reconnaissance does not surface email security issues such as missing or weak DMARC records. This is a common weakness customers expect to see.

## Proposed Solution
Add email security configuration checks and report them as incidents in the Monitor feed.

## Additional Info
Competing products already offer this check.`,

  "lead-in paragraph, bullets, paragraph after the list": `## The Problem
The Monitor Report is hard to hand to stakeholders outside the security team.

Two issues:
- Wording. Everything surfaced is called an "incident", even when it is only an alert.
- Structure. The report groups findings by source rather than by what the finding is.

The report also has no narrative layer.

## Proposed Solution
Restructure the report:
- An opening overview of the reporting period: trend vs. previous period, key takeaways.
- One section per threat type — credentials, vulnerabilities, hacking discussions.
- Neutral terminology for findings that are detections rather than confirmed incidents.`,

  "underscore italic, inline hostnames": `## The Problem
Severity for well-known high-risk services depends on each tenant configuring its own rules.

## Additional Info
Raised during a POC: incidents tied to _smtp.office365.com_ were not flagged Critical out of the box.`,

  "bold, link, inline code, h3, numbered list, nested bullets, hard break": `## The Problem
Exports fail for **large** workspaces. See [the runbook](https://wiki.example.com/exports) and the \`EXPORT_TIMEOUT\` flag.

### Steps
1. Open the Reports page.
2. Export as CSV with more than 50k rows.
   - Wait for the spinner.
   - Observe the timeout.
3. Retry: same result.

## Proposed Solution
Stream the export in pages.  
Keep the download link stable across pages.`,

  "bare URLs stay bare": `## The Problem
Customers asked for this in https://kelatechnicalsupport.zendesk.com/agent/tickets/3834 and in a second ticket.

## Proposed Solution
Link the two: https://example.com/a and https://example.com/b.`,

  "trailing newline is kept": `## The Problem
Short one.

## Proposed Solution
Fix it.
`,

  "heading directly followed by a list": `## Proposed Solution
- First
- Second

## Additional Info
Nothing.`,

};

/** Shapes the markdown grammar cannot keep byte-for-byte; the save guard must. */
const LEGACY: Record<string, string> = {
  "jira-imported: blank line after headings": `## The Problem

Imported from Jira, blocks separated by blank lines.

## Proposed Solution

- One
- Two

Trailing paragraph.`,
  "soft line break and trailing space before a URL": `## The Problem

 This was requested in the following ticket: 
https://kelatechnicalsupport.zendesk.com/agent/tickets/3834`,
  "leading newline and double spaces": `
## The Problem
Two  spaces inside a sentence and a trailing space. 
Second line of the same paragraph.`,
  "literal blocks outside the subset are kept as text": `## The Problem
> quoted text stays quoted
#### a level-four heading stays literal

Then ~~tildes~~ and a lone * star stay text.`,
  "empty body": ``,
  "plain text from the old textarea": `just a sentence typed by a PM
with a second line`,
};

describe("markdown round trip through the editor schema", () => {
  for (const [name, md] of Object.entries(CANONICAL)) {
    it(`is byte-identical: ${name}`, () => {
      const doc = load(md);
      expect(detailsForSave(md, doc, doc)).toBe(md);
      // The serializer itself reproduces the PMOS AI shape, so an edit
      // elsewhere in the body never reflows these blocks.
      const out = docToMarkdown(doc);
      expect(md.endsWith("\n") ? `${out}\n` : out).toBe(md);
    });
  }

  for (const [name, md] of Object.entries({ ...CANONICAL, ...LEGACY })) {
    it(`unchanged save is a no-op; re-serialized text renders and pushes the same and is stable: ${name}`, () => {
      const doc = load(md);
      expect(detailsForSave(md, doc, doc)).toBe(md);
      const once = roundTrip(md);
      expect(viewShape(once)).toBe(viewShape(md));
      expect(adfShape(once)).toBe(adfShape(md));
      expect(roundTrip(once)).toBe(once);
    });
  }
});

describe("serializer", () => {
  it("writes the subset in the PMOS AI shape", () => {
    const doc: EditorNode = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "The Problem" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Mixed " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            { type: "text", text: "both", marks: [{ type: "bold" }, { type: "italic" }] },
            { type: "text", text: " then " },
            { type: "text", text: "a link", marks: [{ type: "link", attrs: { href: "https://x.io" } }] },
            { type: "text", text: "." },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ],
        },
        { type: "paragraph" },
      ],
    };
    expect(docToMarkdown(load(docToMarkdown(doc)))).toBe(docToMarkdown(doc));
    expect(docToMarkdown(doc)).toBe(
      `## The Problem\nMixed **bold** and **_both_** then [a link](https://x.io).\n- one\n- two`,
    );
  });

  it("keeps emphasis delimiters hugging the text", () => {
    const doc: EditorNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: " bold ", marks: [{ type: "bold" }] },
            { type: "text", text: "b" },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe("a **bold** b");
  });

  it("writes a link whose text is its URL as a bare URL", () => {
    const md = "See https://example.com/x now.";
    const doc = load(md);
    const link = doc.content![0].content!.find((n) => n.marks?.some((m) => m.type === "link"));
    expect(link?.text).toBe("https://example.com/x");
    expect(docToMarkdown(doc)).toBe(md);
  });

  it("re-serializes a changed document and keeps a trailing newline", () => {
    const md = "## The Problem\nOld.\n";
    const initial = load(md);
    const changed = load("## The Problem\nNew.");
    expect(detailsForSave(md, initial, changed)).toBe("## The Problem\nNew.\n");
  });
});
