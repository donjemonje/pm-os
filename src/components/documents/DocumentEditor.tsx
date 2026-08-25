"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, FileDown, Loader2, Save, Sparkles, Trash2 } from "lucide-react";
import { UmMarkdown } from "./UmMarkdown";
import { exportDocumentAsPdf } from "@/lib/export-document-pdf";

interface DocumentEditorProps {
  documentId: string;
  initialTitle: string;
  initialBody: string;
  initialStatus: string;
  type: "RN" | "UM";
  audience?: string;
  jiraKeys?: string[];
}

const AUDIENCE_LABELS: Record<string, string> = {
  external: "Customer-facing",
  internal: "Internal",
  configuration: "Operations / config",
};

export function DocumentEditor({
  documentId,
  initialTitle,
  initialBody,
  initialStatus,
  type,
  audience,
  jiraKeys = [],
}: DocumentEditorProps) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [status, setStatus] = useState(initialStatus);
  const [preview, setPreview] = useState(type === "UM");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(`/api/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, status }),
      });
      if (!res.ok) throw new Error("Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [documentId, title, body, status]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (title !== initialTitle || body !== initialBody || status !== initialStatus) {
        save();
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [title, body, status, initialTitle, initialBody, initialStatus, save]);

  async function deleteDocument() {
    if (type !== "UM") return;

    const confirmed = window.confirm(
      `Delete user manual "${title}"?\n\nThis cannot be undone.`
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/documents/${documentId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      router.push("/docs?type=UM");
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  async function generate() {
    setGenerating(true);
    try {
      const res = await fetch(`/api/documents/${documentId}/generate`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      if (data.body) setBody(data.body);
      if (data.title) setTitle(data.title);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  function exportPdf() {
    if (!exportRef.current) return;

    setExporting(true);
    exportDocumentAsPdf(exportRef.current, title)
      .catch((err) => {
        alert(err instanceof Error ? err.message : "Export failed");
      })
      .finally(() => {
        setExporting(false);
      });
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-6 py-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
        >
          <option value="draft">Draft</option>
          <option value="review">Review</option>
          <option value="published">Published</option>
        </select>
        <button
          onClick={() => setPreview((p) => !p)}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
        >
          {preview ? <EyeOff size={14} /> : <Eye size={14} />}
          {preview ? "Edit" : "Preview"}
        </button>
        <button
          onClick={generate}
          disabled={generating}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          AI Generate
        </button>
        <button
          onClick={exportPdf}
          disabled={exporting || !body.trim()}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background disabled:opacity-50"
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
          Export PDF
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saved ? "Saved" : "Save"}
        </button>
        {type === "UM" && (
          <button
            onClick={deleteDocument}
            disabled={deleting}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete
          </button>
        )}
      </div>

      <div
        ref={exportRef}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 -z-50 w-[800px] bg-white p-8 opacity-0"
      >
        {type === "UM" ? (
          <UmMarkdown content={body || "*No content yet.*"} />
        ) : (
          <div className="markdown-body">
            <ReactMarkdown>{body || "*No content yet.*"}</ReactMarkdown>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-6 py-2 text-xs text-muted">
        {type === "UM" && audience && (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
            {AUDIENCE_LABELS[audience] ?? audience}
          </span>
        )}
        {jiraKeys.length > 0 && (
          <span>
            Linked Jira:{" "}
            {jiraKeys.map((k) => (
              <span key={k} className="mr-2 font-mono text-primary">
                {k}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {preview ? (
          <div className="flex-1 overflow-y-auto">
            {type === "UM" ? (
              <UmMarkdown content={body || "*No content yet.*"} className="mx-auto max-w-3xl p-8" />
            ) : (
              <div className="markdown-body mx-auto max-w-3xl p-8">
                <ReactMarkdown>{body || "*No content yet.*"}</ReactMarkdown>
              </div>
            )}
          </div>
        ) : (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              type === "RN"
                ? "# Release Notes\n\n## Highlights\n..."
                : "# User Manual\n\n## Overview\n..."
            }
            className="flex-1 resize-none bg-card p-6 font-mono text-sm leading-relaxed outline-none"
          />
        )}
      </div>
    </div>
  );
}
