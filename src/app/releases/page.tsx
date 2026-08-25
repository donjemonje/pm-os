"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";

interface Release {
  id: string;
  name: string;
  jiraProjectKey: string;
  jiraVersionName?: string | null;
  status: string;
  documents: Array<{ id: string; title: string }>;
}

interface Project {
  key: string;
  name: string;
}

interface Version {
  id: string;
  name: string;
}

export default function ReleasesPage() {
  const [releases, setReleases] = useState<Release[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    jiraProjectKey: "",
    jiraVersionId: "",
    jiraVersionName: "",
    generateNotes: true,
  });

  useEffect(() => {
    Promise.all([
      fetch("/api/releases").then((r) => r.json()),
      fetch("/api/jira/projects").then((r) => r.json()).catch(() => ({ projects: [] })),
    ]).then(([releasesData, projectsData]) => {
      setReleases(releasesData.releases ?? []);
      setProjects(projectsData.projects ?? []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!form.jiraProjectKey) return;
    fetch(`/api/jira/versions?projectKey=${form.jiraProjectKey}`)
      .then((r) => r.json())
      .then((data) => setVersions(data.versions ?? []));
  }, [form.jiraProjectKey]);

  async function createRelease(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create release");

      setReleases((prev) => [data.release, ...prev]);
      setShowForm(false);
      setForm({
        name: "",
        jiraProjectKey: "",
        jiraVersionId: "",
        jiraVersionName: "",
        generateNotes: true,
      });

      if (data.document?.id) {
        window.location.href = `/docs/${data.document.id}`;
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create release");
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppShell>
      <div className="p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Releases</h1>
            <p className="text-sm text-muted">Manage release notes tied to Jira fix versions.</p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover"
          >
            <Plus size={16} />
            New release
          </button>
        </div>

        {showForm && (
          <form
            onSubmit={createRelease}
            className="mb-8 rounded-xl border border-border bg-card p-6"
          >
            <h2 className="mb-4 font-semibold">Create release</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                Release name
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-border px-3 py-2"
                  placeholder="v2.4.0"
                />
              </label>
              <label className="block text-sm">
                Jira project
                <select
                  required
                  value={form.jiraProjectKey}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      jiraProjectKey: e.target.value,
                      jiraVersionId: "",
                      jiraVersionName: "",
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-border px-3 py-2"
                >
                  <option value="">Select project</option>
                  {projects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key} — {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm sm:col-span-2">
                Fix version (optional)
                <select
                  value={form.jiraVersionId}
                  onChange={(e) => {
                    const version = versions.find((v) => v.id === e.target.value);
                    setForm({
                      ...form,
                      jiraVersionId: e.target.value,
                      jiraVersionName: version?.name ?? "",
                    });
                  }}
                  className="mt-1 w-full rounded-lg border border-border px-3 py-2"
                >
                  <option value="">No fix version</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.generateNotes}
                onChange={(e) => setForm({ ...form, generateNotes: e.target.checked })}
              />
              Generate release notes with AI
            </label>
            <div className="mt-4 flex gap-2">
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        ) : releases.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted">
            No releases yet. Connect Jira in Settings, then create your first release.
          </div>
        ) : (
          <div className="space-y-3">
            {releases.map((release) => (
              <div
                key={release.id}
                className="flex items-center justify-between rounded-xl border border-border bg-card px-5 py-4"
              >
                <div>
                  <div className="font-semibold">{release.name}</div>
                  <div className="text-xs text-muted">
                    {release.jiraProjectKey}
                    {release.jiraVersionName ? ` · ${release.jiraVersionName}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs capitalize text-muted">{release.status}</span>
                  {release.documents[0] ? (
                    <Link
                      href={`/docs/${release.documents[0].id}?release=${release.id}`}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-background"
                    >
                      Edit RN
                    </Link>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
