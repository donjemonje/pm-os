/**
 * Markdown ⇄ editor document for the idea Details editor.
 *
 * `Idea.details` is a markdown string in the subset PMOS AI writes and
 * `markdownToAdf()` (src/lib/jira-adf.ts) converts for Jira: `##`/`###`
 * headings, `-`/`1.` lists, `**bold**`, `_italic_`, inline `code`,
 * `[text](url)`, bare URLs, hard breaks (two spaces + newline). This module
 * turns that markdown into a ProseMirror/Tiptap JSON document and back.
 *
 * Fidelity rules:
 * - Anything outside the subset (blockquotes, code fences, `#` / `####`
 *   headings, raw HTML, images) is kept as literal paragraph text — never
 *   dropped, never promoted.
 * - The serializer writes the PMOS AI shape: a blank line between blocks,
 *   except that text follows a heading directly and a bullet list follows
 *   its lead-in paragraph directly. Italic is `_x_`, bullets are `- `, a
 *   link whose text is its own URL is written bare.
 * - A document the PM did not change is never re-serialized: `detailsForSave`
 *   returns the original string byte-for-byte (see there). Whitespace the
 *   markdown grammar discards — trailing spaces, soft line breaks, leading
 *   indentation — can therefore never leak into Jira from an untouched idea.
 *
 * No React, no Tiptap runtime import: this file is unit-tested in Node and
 * is also imported by the drawer (for `URL_RE`) without pulling the editor
 * bundle in.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import type { PhrasingContent, RootContent } from "mdast";

/** A bare http(s) URL in prose. Shared with the drawer's view-mode autolinking. */
export const URL_RE = /(https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?])/g;

export interface EditorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface EditorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: EditorNode[];
  marks?: EditorMark[];
  text?: string;
}

export const HEADING_LEVELS = [2, 3] as const;

// ————— Markdown → document —————

function textNode(text: string, marks: EditorMark[]): EditorNode {
  return marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };
}

function hasMark(marks: EditorMark[], type: string): boolean {
  return marks.some((m) => m.type === type);
}

/** Plain text, with bare URLs turned into links (as the view does). */
function textWithAutolinks(text: string, marks: EditorMark[]): EditorNode[] {
  if (hasMark(marks, "link") || hasMark(marks, "code")) return text ? [textNode(text, marks)] : [];
  const out: EditorNode[] = [];
  const parts = text.split(URL_RE);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) out.push(textNode(part, [...marks, { type: "link", attrs: { href: part } }]));
    else out.push(textNode(part, marks));
  });
  return out;
}

function inline(nodes: PhrasingContent[], marks: EditorMark[], src: string): EditorNode[] {
  const out: EditorNode[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        // A soft line break inside a paragraph renders as a space in the
        // view; the editor shows the same.
        out.push(...textWithAutolinks(n.value.replace(/\n/g, " "), marks));
        break;
      case "strong":
        out.push(...inline(n.children, [...marks, { type: "bold" }], src));
        break;
      case "emphasis":
        out.push(...inline(n.children, [...marks, { type: "italic" }], src));
        break;
      case "inlineCode":
        out.push(textNode(n.value, [...marks, { type: "code" }]));
        break;
      case "link":
        out.push(...inline(n.children, [...marks, { type: "link", attrs: { href: n.url } }], src));
        break;
      case "break":
        out.push({ type: "hardBreak" });
        break;
      default:
        // Images, raw HTML, footnotes… stay literal.
        out.push(...textWithAutolinks(slice(n, src), marks));
    }
  }
  return mergeText(out);
}

/** Adjacent text nodes with identical marks become one node. */
function mergeText(nodes: EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === "text" &&
      n.type === "text" &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])
    ) {
      prev.text = (prev.text ?? "") + (n.text ?? "");
    } else {
      out.push({ ...n });
    }
  }
  return out;
}

function slice(n: { position?: { start: { offset?: number }; end: { offset?: number } } }, src: string): string {
  const s = n.position?.start.offset;
  const e = n.position?.end.offset;
  return s != null && e != null ? src.slice(s, e) : "";
}

/** A block we cannot represent: its source text, line breaks kept as hard breaks. */
function literalParagraph(text: string): EditorNode {
  const content: EditorNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    if (line) content.push(textNode(line, []));
  });
  return { type: "paragraph", content };
}

function block(n: RootContent, src: string): EditorNode[] {
  switch (n.type) {
    case "heading":
      if ((HEADING_LEVELS as readonly number[]).includes(n.depth)) {
        return [{ type: "heading", attrs: { level: n.depth }, content: inline(n.children, [], src) }];
      }
      return [literalParagraph(slice(n, src))];
    case "paragraph":
      return [{ type: "paragraph", content: inline(n.children, [], src) }];
    case "list": {
      const items: EditorNode[] = n.children.map((item) => {
        const blocks = item.children.flatMap((c) => block(c, src));
        // Tiptap's listItem is "paragraph block*": lead with a paragraph.
        if (blocks.length === 0 || blocks[0].type !== "paragraph") blocks.unshift({ type: "paragraph" });
        return { type: "listItem", content: blocks };
      });
      if (n.ordered) {
        return [{ type: "orderedList", attrs: { start: n.start ?? 1 }, content: items }];
      }
      return [{ type: "bulletList", content: items }];
    }
    default:
      // Blockquote, code fence, thematic break, HTML, table…
      return [literalParagraph(slice(n, src))];
  }
}

/** Markdown → Tiptap JSON document (`{ type: "doc", content }`). */
export function markdownToDoc(markdown: string): EditorNode {
  const src = markdown.replace(/\r\n/g, "\n");
  const root = fromMarkdown(src);
  const content = root.children.flatMap((c) => block(c, src));
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

// ————— Document → markdown —————

/** Outer to inner: a link wraps bold wraps italic wraps code. */
const MARK_ORDER = ["link", "bold", "italic", "code"] as const;

function markKey(node: EditorNode, type: string): string | null {
  const m = (node.marks ?? []).find((x) => x.type === type);
  if (!m) return null;
  return type === "link" ? String(m.attrs?.href ?? "") : "";
}

function withoutMark(node: EditorNode, type: string): EditorNode {
  return { ...node, marks: (node.marks ?? []).filter((m) => m.type !== type) };
}

/** `**x **` is not bold in markdown — emphasis delimiters hug the text. */
function wrapHugging(inner: string, open: string, close: string): string {
  const lead = inner.match(/^\s*/)![0];
  const trail = inner.match(/\s*$/)![0];
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (!core) return inner;
  return `${lead}${open}${core}${close}${trail}`;
}

function serializeInline(nodes: EditorNode[], level = 0): string {
  if (level >= MARK_ORDER.length) {
    return nodes
      .map((n) => (n.type === "hardBreak" ? "  \n" : n.type === "text" ? n.text ?? "" : ""))
      .join("");
  }
  const type = MARK_ORDER[level];
  let out = "";
  let i = 0;
  while (i < nodes.length) {
    const key = nodes[i].type === "text" ? markKey(nodes[i], type) : null;
    let j = i + 1;
    while (j < nodes.length && nodes[j].type === "text" && markKey(nodes[j], type) === key) j++;
    const run = nodes.slice(i, j);
    if (key === null) {
      out += serializeInline(run, level + 1);
    } else {
      const inner = serializeInline(run.map((n) => withoutMark(n, type)), level + 1);
      switch (type) {
        case "link":
          out += inner === key ? key : `[${inner}](${key})`;
          break;
        case "bold":
          out += wrapHugging(inner, "**", "**");
          break;
        case "italic":
          out += wrapHugging(inner, "_", "_");
          break;
        case "code":
          out += inner ? `\`${inner}\`` : "";
          break;
      }
    }
    i = j;
  }
  return out;
}

function isEmptyParagraph(n: EditorNode): boolean {
  return n.type === "paragraph" && !(n.content ?? []).some((c) => c.type !== "text" || (c.text ?? "") !== "");
}

/** Lines of one block. Lists return one line per item line. */
function serializeBlock(n: EditorNode): string[] {
  switch (n.type) {
    case "heading":
      return [`${"#".repeat(Number(n.attrs?.level) || 2)} ${serializeInline(n.content ?? [])}`];
    case "paragraph":
      return serializeInline(n.content ?? []).split("\n");
    case "bulletList":
    case "orderedList": {
      const ordered = n.type === "orderedList";
      let num = Number(n.attrs?.start) || 1;
      const lines: string[] = [];
      for (const item of n.content ?? []) {
        const marker = ordered ? `${num++}. ` : "- ";
        const indent = " ".repeat(marker.length);
        const inner = serializeBlocks((item.content ?? []).filter((b) => !isEmptyParagraph(b)));
        const [first = "", ...rest] = inner;
        lines.push(marker + first);
        for (const r of rest) lines.push(r ? indent + r : "");
      }
      return lines;
    }
    default:
      return [];
  }
}

function isList(n: EditorNode | undefined): boolean {
  return n?.type === "bulletList" || n?.type === "orderedList";
}

function serializeBlocks(blocks: EditorNode[]): string[] {
  const out: string[] = [];
  let prev: EditorNode | undefined;
  for (const b of blocks) {
    if (isEmptyParagraph(b)) continue;
    const lines = serializeBlock(b);
    if (lines.length === 0) continue;
    if (prev) {
      // PMOS AI shape: text hugs its heading; a bullet list hugs its
      // lead-in paragraph; everything else gets a blank line.
      const tight =
        prev.type === "heading" || (b.type === "bulletList" && prev.type === "paragraph" && !isList(prev));
      if (!tight) out.push("");
    }
    out.push(...lines);
    prev = b;
  }
  return out;
}

/** Tiptap JSON document → markdown in the PMOS AI shape. No trailing newline. */
export function docToMarkdown(doc: EditorNode): string {
  return serializeBlocks(doc.content ?? []).join("\n");
}

/**
 * What `saveEdit()` stores. An unchanged document returns `original`
 * untouched — this is the byte-identical guarantee for every idea PMOS AI
 * or Jira ever wrote, independent of the serializer. A changed document is
 * re-serialized; a trailing newline the original had is kept.
 */
export function detailsForSave(original: string, initialDoc: EditorNode, currentDoc: EditorNode): string {
  if (JSON.stringify(initialDoc) === JSON.stringify(currentDoc)) return original;
  const md = docToMarkdown(currentDoc);
  return original.endsWith("\n") && md ? `${md}\n` : md;
}
