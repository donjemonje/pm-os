"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  Square,
} from "lucide-react";
import type { AggregationResult, DocumentAudience, JiraIssue, TicketGroup } from "@/lib/types";
import { GoogleDrivePrdPicker } from "@/components/google-drive/GoogleDrivePrdPicker";
import { cn } from "@/lib/utils";

interface Project {
  key: string;
  name: string;
}

interface Version {
  id: string;
  name: string;
}

interface Epic {
  key: string;
  summary: string;
}

type ManualSource = "jira" | "drive";

const SOURCE_OPTIONS: { value: ManualSource; label: string; description: string }[] = [
  {
    value: "jira",
    label: "Jira tickets",
    description: "Aggregate and group related tickets from a Jira project",
  },
  {
    value: "drive",
    label: "Google Drive PRDs",
    description: "Select Google Docs with product requirements",
  },
];

const AUDIENCE_OPTIONS: { value: DocumentAudience; label: string; description: string }[] = [
  {
    value: "external",
    label: "Customer-facing",
    description: "End users and clients — no internal-only details",
  },
  {
    value: "internal",
    label: "Internal",
    description: "Staff-only workflows and admin capabilities",
  },
  {
    value: "configuration",
    label: "Operations / config",
    description: "Product configuration and ops setup guides",
  },
];

export function UserManualWizard() {
  const router = useRouter();
  const [source, setSource] = useState<ManualSource>("jira");
  const [projects, setProjects] = useState<Project[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [scope, setScope] = useState({
    projectKey: "",
    versionName: "",
    epicKey: "",
    statuses: ["Done"] as string[],
  });
  const [aggregation, setAggregation] = useState<AggregationResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectedDriveIds, setSelectedDriveIds] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState<DocumentAudience>("external");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/jira/projects")
      .then((r) => r.json())
      .then((data) => {
        setProjects(data.projects ?? []);
        setLoadingProjects(false);
      })
      .catch(() => setLoadingProjects(false));
  }, []);

  useEffect(() => {
    if (!scope.projectKey) return;
    fetch(`/api/jira/versions?projectKey=${scope.projectKey}`)
      .then((r) => r.json())
      .then((data) => setVersions(data.versions ?? []));
    fetch(`/api/jira/epics?projectKey=${scope.projectKey}`)
      .then((r) => r.json())
      .then((data) =>
        setEpics(
          (data.epics ?? []).map((e: { key: string; summary: string }) => ({
            key: e.key,
            summary: e.summary,
          }))
        )
      );
  }, [scope.projectKey]);

  const issueByKey = useMemo(() => {
    const map = new Map<string, JiraIssue>();
    aggregation?.issues.forEach((i) => map.set(i.key, i));
    return map;
  }, [aggregation]);

  const analyzeTickets = useCallback(async () => {
    if (!scope.projectKey) {
      setError("Select a Jira project");
      return;
    }
    setAnalyzing(true);
    setError(null);
    setAggregation(null);

    try {
      const res = await fetch("/api/jira/aggregate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: scope.projectKey,
          versionName: scope.versionName || undefined,
          epicKey: scope.epicKey || undefined,
          statuses: scope.statuses.length ? scope.statuses : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to analyze tickets");

      setAggregation(data);
      setSelectedKeys(new Set(data.suggestedKeys ?? []));
      setExpandedGroups(new Set((data.groups ?? []).map((g: TicketGroup) => g.id)));

      if (!title && data.groups?.[0]?.label) {
        setTitle(`User Manual — ${data.groups[0].label}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }, [scope, title]);

  function toggleKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleGroup(group: TicketGroup) {
    const allSelected = group.issueKeys.every((k) => selectedKeys.has(k));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const key of group.issueKeys) {
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  function selectAll() {
    if (!aggregation) return;
    setSelectedKeys(new Set(aggregation.issues.map((i) => i.key)));
  }

  function selectSuggested() {
    if (!aggregation) return;
    setSelectedKeys(new Set(aggregation.suggestedKeys));
  }

  function clearSelection() {
    setSelectedKeys(new Set());
  }

  async function generateManual() {
    if (!title.trim()) {
      setError("Enter a title for the user manual");
      return;
    }
    if (source === "jira" && selectedKeys.size === 0) {
      setError("Select at least one Jira ticket");
      return;
    }
    if (source === "drive" && selectedDriveIds.size === 0) {
      setError("Select at least one Google Drive PRD file");
      return;
    }

    setGenerating(true);
    setError(null);

    try {
      const res = await fetch("/api/documents/generate-um", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          issueKeys: source === "jira" ? Array.from(selectedKeys) : [],
          driveFileIds: source === "drive" ? Array.from(selectedDriveIds) : [],
          audience,
          projectKey: source === "jira" ? scope.projectKey : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      if (data.notice) {
        setNotice(data.notice);
      }
      router.push(`/docs/${data.document.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setGenerating(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold">1. Choose a source</h2>
        <p className="mb-4 text-sm text-muted">
          Build the manual from Jira tickets or from PRDs in Google Drive.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {SOURCE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={cn(
                "cursor-pointer rounded-lg border p-3 text-sm transition",
                source === opt.value
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-background"
              )}
            >
              <input
                type="radio"
                name="source"
                value={opt.value}
                checked={source === opt.value}
                onChange={() => setSource(opt.value)}
                className="sr-only"
              />
              <div className="font-medium">{opt.label}</div>
              <div className="mt-1 text-xs text-muted">{opt.description}</div>
            </label>
          ))}
        </div>
      </section>

      {source === "jira" && (
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="mb-1 text-lg font-semibold">2. Scope from Jira</h2>
        <p className="mb-4 text-sm text-muted">
          Pull tickets from Jira, then PMOS will group related items (epic, component, similar
          titles).
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            Project
            <select
              value={scope.projectKey}
              onChange={(e) =>
                setScope({
                  projectKey: e.target.value,
                  versionName: "",
                  epicKey: "",
                  statuses: scope.statuses,
                })
              }
              className="mt-1 w-full rounded-lg border border-border px-3 py-2"
              disabled={loadingProjects}
            >
              <option value="">Select project</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            Fix version (optional)
            <select
              value={scope.versionName}
              onChange={(e) => setScope({ ...scope, versionName: e.target.value })}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2"
              disabled={!scope.projectKey}
            >
              <option value="">All versions</option>
              {versions.map((v) => (
                <option key={v.id} value={v.name}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm sm:col-span-2">
            Epic (optional)
            <select
              value={scope.epicKey}
              onChange={(e) => setScope({ ...scope, epicKey: e.target.value })}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2"
              disabled={!scope.projectKey}
            >
              <option value="">All epics</option>
              {epics.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.key} — {e.summary}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {["Done", "In Progress", "To Do"].map((status) => (
            <label
              key={status}
              className={cn(
                "cursor-pointer rounded-full border px-3 py-1 text-xs",
                scope.statuses.includes(status)
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted"
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={scope.statuses.includes(status)}
                onChange={() => {
                  setScope((s) => ({
                    ...s,
                    statuses: s.statuses.includes(status)
                      ? s.statuses.filter((x) => x !== status)
                      : [...s.statuses, status],
                  }));
                }}
              />
              {status}
            </label>
          ))}
        </div>

        <button
          onClick={analyzeTickets}
          disabled={analyzing || !scope.projectKey}
          className="mt-4 flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {analyzing ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Sparkles size={16} />
          )}
          {analyzing ? "Analyzing…" : "Analyze & group tickets"}
        </button>
      </section>
      )}

      {source === "drive" && (
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-1 text-lg font-semibold">2. PRDs from Google Drive</h2>
          <p className="mb-4 text-sm text-muted">
            Browse My Drive or shared drives, search and select Google Docs with product
            requirements to generate the manual from.
          </p>
          <GoogleDrivePrdPicker
            selectedIds={selectedDriveIds}
            onChange={setSelectedDriveIds}
          />
        </section>
      )}

      {source === "jira" && aggregation && (
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">3. Review & select tickets</h2>
              <p className="text-sm text-muted">
                {aggregation.issues.length} tickets found · {selectedKeys.size} selected
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <button
                onClick={selectSuggested}
                className="rounded-lg border border-border px-2 py-1 hover:bg-background"
              >
                AI suggestion
              </button>
              <button
                onClick={selectAll}
                className="rounded-lg border border-border px-2 py-1 hover:bg-background"
              >
                Select all
              </button>
              <button
                onClick={clearSelection}
                className="rounded-lg border border-border px-2 py-1 hover:bg-background"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {aggregation.groups.map((group) => {
              const expanded = expandedGroups.has(group.id);
              const groupSelected = group.issueKeys.filter((k) => selectedKeys.has(k)).length;
              const allInGroup = groupSelected === group.issueKeys.length;

              return (
                <div key={group.id} className="rounded-lg border border-border">
                  <div className="flex w-full items-center gap-2 px-3 py-2 text-sm">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-primary"
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <span className="font-medium">{group.label}</span>
                      <span className="text-xs text-muted">({group.reason})</span>
                    </button>
                    <span className="text-xs text-muted">
                      {groupSelected}/{group.issueKeys.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group)}
                      className="rounded p-0.5 hover:bg-background"
                      title={allInGroup ? "Deselect group" : "Select group"}
                    >
                      {allInGroup ? (
                        <CheckSquare size={14} className="text-primary" />
                      ) : (
                        <Square size={14} className="text-muted" />
                      )}
                    </button>
                  </div>

                  {expanded && (
                    <div className="border-t border-border">
                      {group.issueKeys.map((key) => {
                        const issue = issueByKey.get(key);
                        if (!issue) return null;
                        const checked = selectedKeys.has(key);
                        return (
                          <label
                            key={key}
                            className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2 last:border-0 hover:bg-background"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleKey(key)}
                              className="mt-1 rounded"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs text-primary">{key}</span>
                                <span className="text-xs text-muted">{issue.issueType}</span>
                                <span className="text-xs text-muted">{issue.status}</span>
                              </div>
                              <div className="text-sm">{issue.summary}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {aggregation.groups.length === 0 && (
            <div className="space-y-2">
              {aggregation.issues.map((issue) => (
                <label
                  key={issue.key}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 hover:bg-background"
                >
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(issue.key)}
                    onChange={() => toggleKey(issue.key)}
                    className="mt-1 rounded"
                  />
                  <div>
                    <span className="font-mono text-xs text-primary">{issue.key}</span>
                    <div className="text-sm">{issue.summary}</div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      {(source === "jira" ? aggregation !== null : selectedDriveIds.size > 0) && (
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">
            {source === "jira" ? "4" : "3"}. Generate user manual
          </h2>

          <label className="mb-4 block text-sm">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2"
              placeholder="User Manual — Feature name"
            />
          </label>

          <div className="mb-6">
            <div className="mb-2 text-sm font-medium">Audience</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {AUDIENCE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={cn(
                    "cursor-pointer rounded-lg border p-3 text-sm transition",
                    audience === opt.value
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-background"
                  )}
                >
                  <input
                    type="radio"
                    name="audience"
                    value={opt.value}
                    checked={audience === opt.value}
                    onChange={() => setAudience(opt.value)}
                    className="sr-only"
                  />
                  <div className="font-medium">{opt.label}</div>
                  <div className="mt-1 text-xs text-muted">{opt.description}</div>
                </label>
              ))}
            </div>
          </div>

          <button
            onClick={generateManual}
            disabled={
              generating ||
              (source === "jira" ? selectedKeys.size === 0 : selectedDriveIds.size === 0)
            }
            className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {generating ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Sparkles size={16} />
            )}
            {generating
              ? "Generating…"
              : source === "jira"
                ? `Generate from ${selectedKeys.size} ticket${selectedKeys.size === 1 ? "" : "s"}`
                : `Generate from ${selectedDriveIds.size} PRD${selectedDriveIds.size === 1 ? "" : "s"}`}
          </button>
        </section>
      )}

      {notice && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {notice}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}
