"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";

interface Document {
  id: string;
  type: string;
  title: string;
  status: string;
  audience?: string;
  updatedAt: string;
}

function DocsPageContent() {
  const searchParams = useSearchParams();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "RN" | "UM">("all");

  useEffect(() => {
    const type = searchParams.get("type");
    if (type === "UM" || type === "RN") setFilter(type);
  }, [searchParams]);

  function loadDocuments() {
    const type = filter === "all" ? "" : `?type=${filter}`;
    return fetch(`/api/documents${type}`)
      .then((r) => r.json())
      .then((data) => setDocuments(data.documents ?? []));
  }

  useEffect(() => {
    setLoading(true);
    loadDocuments().finally(() => setLoading(false));
  }, [filter]);

  async function deleteUm(doc: Document, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (doc.type !== "UM") return;

    const confirmed = window.confirm(
      `Delete user manual "${doc.title}"?\n\nThis cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingId(doc.id);
    try {
      const res = await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function createDoc(type: "RN" | "UM") {
    setCreating(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title: type === "RN" ? "New Release Notes" : "New User Manual Section",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.location.href = `/docs/${data.document.id}`;
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppShell>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Documents</h1>
            <p className="text-sm text-muted">
              User manuals from Jira tickets or Google Drive PRDs · release notes from fix versions.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/docs/new"
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-white hover:bg-primary-hover"
            >
              <Plus size={14} />
              User Manual
            </Link>
            <button
              onClick={() => createDoc("RN")}
              disabled={creating}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-background disabled:opacity-50"
            >
              <Plus size={14} />
              Release Notes
            </button>
          </div>
        </div>

        <div className="mb-4 flex gap-2">
          {(["all", "RN", "UM"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                filter === f
                  ? "bg-primary text-white"
                  : "border border-border hover:bg-background"
              }`}
            >
              {f === "all" ? "All" : f}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        ) : documents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted">
            No documents yet.{" "}
            <Link href="/docs/new" className="text-primary hover:underline">
              Create a user manual
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 hover:bg-background"
              >
                <Link href={`/docs/${doc.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="rounded bg-background px-2 py-0.5 font-mono text-xs text-primary">
                      {doc.type}
                    </span>
                    <span className="truncate text-sm font-medium">{doc.title}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted">
                    {doc.type === "UM" && doc.audience && (
                      <span className="capitalize">{doc.audience}</span>
                    )}
                    <span className="capitalize">{doc.status}</span>
                    <span>{new Date(doc.updatedAt).toLocaleDateString()}</span>
                  </div>
                </Link>
                {doc.type === "UM" && (
                  <button
                    type="button"
                    onClick={(e) => deleteUm(doc, e)}
                    disabled={deletingId === doc.id}
                    className="shrink-0 rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
                    title="Delete user manual"
                    aria-label={`Delete ${doc.title}`}
                  >
                    {deletingId === doc.id ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Trash2 size={16} />
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function DocsPage() {
  return (
    <Suspense>
      <DocsPageContent />
    </Suspense>
  );
}
