/**
 * Atlassian Document Format ⇄ Markdown.
 *
 * Raw Jira issues must read in PM-OS as close to Jira as possible (headings,
 * bold, lists, links), and what PM-OS writes back must render in Jira as real
 * headings and lists — not "## Problem" as literal text (Daniel, 2026-10-13).
 * Both directions cover the same construct set, so a description PM-OS wrote
 * round-trips: ADF → markdown → ADF gives the same document.
 *
 * Supported: paragraphs, headings 1–6, bullet and ordered lists (nested),
 * bold / italic / strikethrough / inline code / links, code blocks,
 * blockquotes, rules, hard breaks, mentions (as @name), emoji (shortname),
 * inline cards (as the URL). Media is rendered as a short marker so the text
 * never silently loses the fact that an image was there.
 */

type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
};

// ————— ADF → Markdown —————

function inlineToMd(node: AdfNode): string {
  switch (node.type) {
    case "text": {
      let t = node.text ?? "";
      const marks = node.marks ?? [];
      const has = (m: string) => marks.some((x) => x.type === m);
      if (has("code")) return `\`${t}\``;
      if (has("strong")) t = `**${t}**`;
      if (has("em")) t = `_${t}_`;
      if (has("strike")) t = `~~${t}~~`;
      const link = marks.find((x) => x.type === "link");
      const href = link?.attrs?.href;
      if (typeof href === "string" && href) t = `[${t}](${href})`;
      return t;
    }
    case "hardBreak":
      return "  \n";
    case "mention":
      return `@${String(node.attrs?.text ?? "").replace(/^@/, "") || "user"}`;
    case "emoji":
      return String(node.attrs?.shortName ?? node.attrs?.text ?? "");
    case "inlineCard":
      return String(node.attrs?.url ?? "");
    case "status":
      return `[${String(node.attrs?.text ?? "")}]`;
    case "date": {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "";
    }
    default:
      return (node.content ?? []).map(inlineToMd).join("");
  }
}

function blocksToMd(nodes: AdfNode[], indent = ""): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out.push(indent + (node.content ?? []).map(inlineToMd).join(""));
        break;
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
        out.push(`${indent}${"#".repeat(level)} ${(node.content ?? []).map(inlineToMd).join("")}`);
        break;
      }
      case "bulletList":
      case "orderedList": {
        const ordered = node.type === "orderedList";
        let n = Number(node.attrs?.order) || 1;
        for (const item of node.content ?? []) {
          const marker = ordered ? `${n++}. ` : "- ";
          const inner = blocksToMd(item.content ?? [], "");
          // First block sits on the marker line; following blocks are indented.
          const [first, ...rest] = inner.length > 0 ? inner : [""];
          out.push(`${indent}${marker}${first}`);
          for (const r of rest) out.push(r ? `${indent}  ${r}` : "");
        }
        break;
      }
      case "codeBlock": {
        const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
        out.push(`${indent}\`\`\`${lang}`);
        for (const line of (node.content ?? []).map((c) => c.text ?? "").join("").split("\n")) {
          out.push(indent + line);
        }
        out.push(`${indent}\`\`\``);
        break;
      }
      case "blockquote":
        for (const line of blocksToMd(node.content ?? [], "")) out.push(`${indent}> ${line}`);
        break;
      case "rule":
        out.push(`${indent}---`);
        break;
      case "mediaSingle":
      case "mediaGroup":
      case "media":
        out.push(`${indent}[image]`);
        break;
      case "panel":
      case "expand":
      case "nestedExpand":
      case "layoutSection":
      case "layoutColumn":
      case "table":
      case "tableRow":
      case "tableCell":
      case "tableHeader":
      case "listItem":
        out.push(...blocksToMd(node.content ?? [], indent));
        break;
      default:
        if (node.content) out.push(...blocksToMd(node.content, indent));
        else if (node.text) out.push(indent + inlineToMd(node));
    }
  }
  return out;
}

/** Markdown for an ADF document; plain strings pass through. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (!doc || typeof doc !== "object") return "";
  const root = doc as AdfNode;
  const lines = blocksToMd(root.type === "doc" ? root.content ?? [] : [root]);
  // Blocks are separated by one blank line; consecutive list items stay tight.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const prev = lines[i - 1];
    const listLike = (s: string | undefined) => !!s && /^\s*(?:[-*]|\d+\.) /.test(s);
    const quoteLike = (s: string | undefined) => !!s && /^> /.test(s);
    const fence = (s: string | undefined) => !!s && /^\s*```/.test(s);
    if (
      i > 0 &&
      !(listLike(cur) && listLike(prev)) &&
      !(quoteLike(cur) && quoteLike(prev)) &&
      !(cur.startsWith("  ") && listLike(prev)) &&
      !fence(prev) &&
      !(fence(cur) && out.length > 0 && out[out.length - 1] !== "")
    ) {
      out.push("");
    }
    out.push(cur);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ————— Markdown → ADF —————

function mdInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  // Tokens: inline code, links, bold, italic, strikethrough.
  const re = /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|((?<![\w*])\*([^*\n]+)\*(?![\w*]))|((?<!\w)_([^_\n]+)_(?!\w))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string, marks?: AdfNode["marks"]) => {
    if (!t) return;
    nodes.push(marks && marks.length > 0 ? { type: "text", text: t, marks } : { type: "text", text: t });
  };
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index));
    if (m[1]) push(m[1].slice(1, -1), [{ type: "code" }]);
    else if (m[2]) {
      const inner = mdInline(m[3]);
      for (const n of inner) {
        n.marks = [...(n.marks ?? []), { type: "link", attrs: { href: m[4] } }];
        nodes.push(n);
      }
    } else if (m[5]) {
      for (const n of mdInline(m[6])) {
        n.marks = [...(n.marks ?? []), { type: "strong" }];
        nodes.push(n);
      }
    } else if (m[7]) push(m[8], [{ type: "strike" }]);
    else if (m[9]) push(m[10], [{ type: "em" }]);
    else if (m[11]) push(m[12], [{ type: "em" }]);
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return nodes;
}

function paragraph(text: string): AdfNode {
  // Markdown hard break ("two spaces + newline") → hardBreak node.
  const parts = text.split(/ {2,}\n|\\\n/);
  const content: AdfNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    content.push(...mdInline(p.replace(/\n/g, " ")));
  });
  return { type: "paragraph", content };
}

/**
 * Markdown (the subset PMOS AI writes: ## headings, lists, bold, links) to
 * an ADF document. Unknown syntax is kept as text, never dropped.
 */
export function markdownToAdf(markdown: string): { type: "doc"; version: 1; content: AdfNode[] } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let i = 0;
  const listRe = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      content.push({ type: "heading", attrs: { level: h[1].length }, content: mdInline(h[2].trim()) });
      i++;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      content.push({ type: "rule" });
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      content.push({
        type: "codeBlock",
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: code.length > 0 ? [{ type: "text", text: code.join("\n") }] : [],
      });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
      content.push({ type: "blockquote", content: markdownToAdf(quoted.join("\n")).content });
      continue;
    }
    if (listRe.test(line)) {
      const [list, next] = parseList(lines, i, 0);
      content.push(list);
      i = next;
      continue;
    }
    // Paragraph: consecutive non-blank, non-block lines.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !listRe.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    content.push(paragraph(para.join("\n")));
  }
  return { type: "doc", version: 1, content: content.length > 0 ? content : [{ type: "paragraph", content: [] }] };
}

/** Parse a (possibly nested) list starting at `start`; returns the node and the next line index. */
function parseList(lines: string[], start: number, indent: number): [AdfNode, number] {
  const listRe = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
  const first = lines[start].match(listRe)!;
  const ordered = /\d/.test(first[2]);
  const node: AdfNode = {
    type: ordered ? "orderedList" : "bulletList",
    ...(ordered ? { attrs: { order: parseInt(first[2], 10) || 1 } } : {}),
    content: [],
  };
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(listRe);
    if (!m) break;
    const depth = m[1].length;
    if (depth < indent) break;
    if (depth > indent) {
      // Nested list belongs to the previous item.
      const [sub, next] = parseList(lines, i, depth);
      const prev = node.content![node.content!.length - 1];
      if (prev) prev.content!.push(sub);
      else node.content!.push({ type: "listItem", content: [sub] });
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    // Continuation lines (indented, non-list) extend the item's paragraph.
    const textLines = [m[3]];
    i++;
    while (i < lines.length && lines[i].trim() && !listRe.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
      textLines.push(lines[i++].trim());
    }
    node.content!.push({ type: "listItem", content: [paragraph(textLines.join("\n"))] });
  }
  return [node, i];
}
