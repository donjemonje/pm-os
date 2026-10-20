"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import {
  Bold,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Pilcrow,
  Redo2,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { detailsForSave, markdownToDoc, type EditorNode } from "@/lib/ideas/editor-markdown";
import { editorExtensions } from "./editor-extensions";

/**
 * WYSIWYG editor for an idea's Details (the drawer's edit mode). Markdown
 * in, markdown out — see src/lib/ideas/editor-markdown.ts for the subset and
 * the round-trip rules. The editing surface carries the same `um-doc
 * idea-text` classes as the view, so text looks identical in and out of
 * edit.
 *
 * Loaded with `next/dynamic` from the drawer: nothing here reaches the Ideas
 * page bundle until a PM clicks Edit.
 *
 * `defaultValue` is read once, when the editor mounts. Cmd+Enter (save) and
 * Esc (cancel) are not handled here: they bubble to the drawer's edit form,
 * which owns the whole edit. Cmd+K opens the link bar.
 */
export function IdeaDetailsEditor({
  defaultValue,
  onChange,
}: {
  defaultValue: string;
  onChange: (markdown: string) => void;
}) {
  const original = useRef(defaultValue);
  const initialDoc = useRef<EditorNode | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [linkBar, setLinkBar] = useState<{ href: string } | null>(null);
  const openLinkBar = useRef<() => void>(() => {});

  // Mod-K is not bound by the Link extension itself.
  const LinkShortcut = useMemo(
    () =>
      Extension.create({
        name: "ideaLinkShortcut",
        addKeyboardShortcuts() {
          return {
            "Mod-k": () => {
              openLinkBar.current();
              return true;
            },
          };
        },
      }),
    [],
  );

  const editor = useEditor({
    extensions: [...editorExtensions, LinkShortcut],
    content: markdownToDoc(original.current),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "um-doc markdown-body idea-text idea-editor-surface",
        "aria-label": "Details",
      },
      // Plain-text paste (a markdown body from another idea, notes from a
      // doc) is parsed as markdown, so headings and lists arrive as such.
      clipboardTextParser: (text, _context, _plain, view) => {
        const node = view.state.schema.nodeFromJSON(markdownToDoc(text));
        return Slice.maxOpen(node.content);
      },
    },
    onCreate: ({ editor }) => {
      initialDoc.current = editor.getJSON() as EditorNode;
    },
    onUpdate: ({ editor }) => {
      if (!initialDoc.current) return;
      onChangeRef.current(
        detailsForSave(original.current, initialDoc.current, editor.getJSON() as EditorNode),
      );
    },
  });

  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      h2: editor?.isActive("heading", { level: 2 }) ?? false,
      h3: editor?.isActive("heading", { level: 3 }) ?? false,
      paragraph: editor?.isActive("paragraph") ?? false,
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      bulletList: editor?.isActive("bulletList") ?? false,
      orderedList: editor?.isActive("orderedList") ?? false,
      link: editor?.isActive("link") ?? false,
      canUndo: editor?.can().undo() ?? false,
      canRedo: editor?.can().redo() ?? false,
    }),
  });

  openLinkBar.current = () => {
    if (!editor) return;
    const href = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkBar({ href });
  };

  const linkInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (linkBar) linkInput.current?.select();
  }, [linkBar]);

  const applyLink = () => {
    if (!editor || !linkBar) return;
    const href = linkBar.href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) {
      chain.unsetLink().run();
    } else if (editor.state.selection.empty && !editor.isActive("link")) {
      // Nothing selected: the URL itself becomes the link text.
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      chain.setLink({ href }).run();
    }
    setLinkBar(null);
  };

  const closeLinkBar = () => {
    setLinkBar(null);
    editor?.commands.focus();
  };

  if (!editor || !state) return <div className="idea-editor idea-editor-loading" />;

  const tool = (
    label: string,
    Icon: typeof Bold,
    active: boolean,
    run: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keep the editor selection: the click must not move focus first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cn("idea-editor-tool", active && "is-active")}
    >
      <Icon size={15} strokeWidth={2.1} />
    </button>
  );
  const focus = () => editor.chain().focus();

  return (
    <div className="idea-editor">
      <div className="idea-editor-toolbar" role="toolbar" aria-label="Formatting">
        {tool("Heading 2", Heading2, state.h2, () => focus().toggleHeading({ level: 2 }).run())}
        {tool("Heading 3", Heading3, state.h3, () => focus().toggleHeading({ level: 3 }).run())}
        {tool("Paragraph", Pilcrow, state.paragraph, () => focus().setParagraph().run())}
        <span className="idea-editor-sep" />
        {tool("Bold (⌘B)", Bold, state.bold, () => focus().toggleBold().run())}
        {tool("Italic (⌘I)", Italic, state.italic, () => focus().toggleItalic().run())}
        <span className="idea-editor-sep" />
        {tool("Bullet list", List, state.bulletList, () => focus().toggleBulletList().run())}
        {tool("Numbered list", ListOrdered, state.orderedList, () => focus().toggleOrderedList().run())}
        <span className="idea-editor-sep" />
        {tool("Link (⌘K)", LinkIcon, state.link, () => openLinkBar.current())}
        <span className="idea-editor-sep" />
        {tool("Undo (⌘Z)", Undo2, false, () => focus().undo().run(), !state.canUndo)}
        {tool("Redo (⇧⌘Z)", Redo2, false, () => focus().redo().run(), !state.canRedo)}
      </div>
      {linkBar && (
        <div className="idea-editor-linkbar">
          <input
            ref={linkInput}
            type="url"
            value={linkBar.href}
            placeholder="https://…"
            aria-label="Link URL"
            onChange={(e) => setLinkBar({ href: e.target.value })}
            onKeyDown={(e) => {
              // Enter applies, Esc closes the bar only — never the edit.
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeLinkBar();
              }
            }}
          />
          <button type="button" className="idea-editor-linkbtn" onClick={applyLink}>
            {linkBar.href.trim() ? "Apply" : state.link ? "Remove link" : "Apply"}
          </button>
          <button type="button" className="idea-editor-linkbtn is-quiet" onClick={closeLinkBar}>
            Cancel
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

export default IdeaDetailsEditor;
