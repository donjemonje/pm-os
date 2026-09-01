"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

interface Project {
  id: string;
  key: string;
  name: string;
}

export function JiraProjectsPanel({
  initialProjectKeys,
  siteUrl,
  showIdeasTarget = false,
  initialIdeasProjectKey = null,
  initialIdeasIssueType = "Task",
}: {
  initialProjectKeys: string[];
  siteUrl?: string;
  /** Rendered only when the Ideas feature is enabled for the caller's org. */
  showIdeasTarget?: boolean;
  initialIdeasProjectKey?: string | null;
  initialIdeasIssueType?: string;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string[]>(initialProjectKeys);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [ideasProject, setIdeasProject] = useState<string>(initialIdeasProjectKey ?? "");
  const [ideasIssueType, setIdeasIssueType] = useState<string>(initialIdeasIssueType);
  const [issueTypes, setIssueTypes] = useState<string[]>([]);
  const [issueTypesLoading, setIssueTypesLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch("/api/jira/projects")
      .then((r) => r.json())
      .then((data) => setProjects(data.projects ?? []))
      .finally(() => setLoading(false));
  }, []);

  // The effective target: the chosen project, or the single selected project.
  const effectiveIdeasProject =
    ideasProject && selected.includes(ideasProject)
      ? ideasProject
      : selected.length === 1
        ? selected[0]
        : "";

  useEffect(() => {
    if (!showIdeasTarget || !effectiveIdeasProject) {
      setIssueTypes([]);
      return;
    }
    let stale = false;
    setIssueTypesLoading(true);
    fetch(`/api/jira/issue-types?project=${encodeURIComponent(effectiveIdeasProject)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!stale) setIssueTypes(data.issueTypes ?? []);
      })
      .finally(() => {
        if (!stale) setIssueTypesLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [showIdeasTarget, effectiveIdeasProject]);

  async function saveProjects() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/jira/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKeys: selected,
          ideasProjectKey: effectiveIdeasProject || null,
          ideasIssueType,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: undefined }));
        setError(data.error ?? "Save failed");
      }
    } finally {
      setSaving(false);
    }
  }

  function toggleProject(key: string) {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  return (
    <div>
      {siteUrl && (
        <a
          href={siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          Open Jira
          <ExternalLink size={12} />
        </a>
      )}

      <p className="mb-3 text-sm text-muted">
        Choose which Jira projects PMOS can read for releases and user manuals.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" />
          Loading projects…
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 hover:bg-background"
            >
              <input
                type="checkbox"
                checked={selected.includes(p.key)}
                onChange={() => toggleProject(p.key)}
                className="rounded"
              />
              <span className="font-mono text-sm text-primary">{p.key}</span>
              <span className="text-sm">{p.name}</span>
            </label>
          ))}
        </div>
      )}

      {showIdeasTarget && !loading && (
        <div className="mt-5 rounded-lg border border-border bg-background px-4 py-3">
          <div className="text-sm font-medium">Ideas write-back</div>
          <p className="mb-3 mt-0.5 text-[13px] text-muted">
            New ideas approved in the Ideas screen are created as issues here. Existing Jira
            ideas are updated in place.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Project</span>
              <select
                value={effectiveIdeasProject}
                onChange={(e) => setIdeasProject(e.target.value)}
                className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm"
              >
                <option value="">Choose…</option>
                {selected.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Issue type</span>
              <select
                value={ideasIssueType}
                onChange={(e) => setIdeasIssueType(e.target.value)}
                disabled={issueTypesLoading || !effectiveIdeasProject}
                className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm disabled:opacity-50"
              >
                {/* Keep the saved value selectable even before types load. */}
                {!issueTypes.includes(ideasIssueType) && (
                  <option value={ideasIssueType}>{ideasIssueType}</option>
                )}
                {issueTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {issueTypesLoading && <Loader2 size={14} className="animate-spin text-muted" />}
          </div>
        </div>
      )}

      {error && <div className="mt-3 text-sm text-[#c94266]">{error}</div>}

      <button
        type="button"
        onClick={saveProjects}
        disabled={saving}
        className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
