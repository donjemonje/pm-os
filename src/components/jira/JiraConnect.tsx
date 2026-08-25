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
}: {
  initialProjectKeys: string[];
  siteUrl?: string;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string[]>(initialProjectKeys);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch("/api/jira/projects")
      .then((r) => r.json())
      .then((data) => setProjects(data.projects ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function saveProjects() {
    setSaving(true);
    try {
      await fetch("/api/jira/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKeys: selected }),
      });
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
