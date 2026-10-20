/**
 * The Tiptap extension set of the idea Details editor — exactly the subset
 * `markdownToAdf()` can push to Jira (headings 2–3, paragraphs, bullet and
 * numbered lists, bold, italic, inline code, links, hard breaks). No
 * blockquotes, code blocks, rules, strike, underline, tables or images.
 *
 * Shared by the editor component and the round-trip unit test so both
 * normalise documents through the same schema. No React here.
 */

import StarterKit from "@tiptap/starter-kit";
import { HEADING_LEVELS } from "@/lib/ideas/editor-markdown";

export const editorExtensions = [
  StarterKit.configure({
    heading: { levels: [...HEADING_LEVELS] },
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    underline: false,
    // An always-present empty trailing paragraph would change every document
    // that ends with a list or heading on load.
    trailingNode: false,
    link: {
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
      // Bare URLs are stored bare (see docToMarkdown); the view adds target.
      HTMLAttributes: { class: "um-link" },
    },
  }),
];
