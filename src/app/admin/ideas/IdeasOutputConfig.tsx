"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  ATTRIBUTE_LABELS,
  MAPPED_ATTRIBUTES,
  type IdeasJiraConfig,
  type MappedAttribute,
} from "@/lib/ideas/jira-mapping";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  config: IdeasJiraConfig;
  /** Jira issue type created ideas get; null when Jira isn't connected. */
  ideasIssueType: string | null;
}

const POLICY_LABELS: Record<string, string> = {
  set_if_empty: "Set only when empty (never replace a human's value)",
  increment: "Increment by this batch's new votes",
  union: "Add missing values (never remove)",
};

const TYPE_LABELS: Record<string, string> = {
  single_select: "Single select",
  number: "Number",
  multi_select: "Multi select",
};

export function IdeasOutputConfig({ organizations }: { organizations: OrgRow[] }) {
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? "");
  const [configs, setConfigs] = useState<Record<string, IdeasJiraConfig>>(
    Object.fromEntries(organizations.map((o) => [o.id, o.config]))
  );
  const [issueTypes, setIssueTypes] = useState<Record<string, string | null>>(
    Object.fromEntries(organizations.map((o) => [o.id, o.ideasIssueType]))
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const org = organizations.find((o) => o.id === orgId);
  const config = configs[orgId];
  if (!org || !config) {
    return <p className="text-sm text-slate-500">No organizations with a workspace yet.</p>;
  }

  const patch = (next: Partial<IdeasJiraConfig>) => {
    setSaved(false);
    setConfigs((prev) => ({ ...prev, [orgId]: { ...prev[orgId], ...next } }));
  };
  const patchField = (attr: MappedAttribute, next: Partial<IdeasJiraConfig["fields"][MappedAttribute]>) => {
    setSaved(false);
    setConfigs((prev) => ({
      ...prev,
      [orgId]: {
        ...prev[orgId],
        fields: { ...prev[orgId].fields, [attr]: { ...prev[orgId].fields[attr], ...next } },
      },
    }));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/organizations/${orgId}/ideas-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, ideasIssueType: issueTypes[orgId] ?? undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setConfigs((prev) => ({ ...prev, [orgId]: data.config }));
      setIssueTypes((prev) => ({ ...prev, [orgId]: data.ideasIssueType ?? prev[orgId] }));
      setSaved(true);
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-500";

  return (
    <div className="space-y-6">
      <label className="flex items-center gap-3 text-sm">
        <span className="font-medium">Organization</span>
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={inputCls}>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.slug})
            </option>
          ))}
        </select>
      </label>

      {/* Jira target */}
      {issueTypes[orgId] !== null && (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">Jira target</h2>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">
            New ideas are created as this work type in the connected project (also settable in
            Settings → Jira). The name must match a work type of the project exactly.
          </p>
          <label className="flex items-center gap-3 text-sm">
            <span className="text-xs font-medium text-slate-600">Issue type</span>
            <input
              type="text"
              value={issueTypes[orgId] ?? ""}
              onChange={(e) => {
                setSaved(false);
                setIssueTypes((prev) => ({ ...prev, [orgId]: e.target.value }));
              }}
              placeholder="Story"
              className={`${inputCls} w-44`}
            />
          </label>
        </section>
      )}

      {/* Description format */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Description</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          On every merge the Jira description is replaced with the PM-OS details, a gap, and the
          supported-tickets list.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-slate-600">Tickets heading</span>
            <input
              type="text"
              value={config.supportedTicketsHeading}
              onChange={(e) => patch({ supportedTicketsHeading: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-slate-600">Blank lines before the list</span>
            <input
              type="number"
              min={0}
              max={10}
              value={config.descriptionGapLines}
              onChange={(e) => patch({ descriptionGapLines: Math.max(0, parseInt(e.target.value, 10) || 0) })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-xs font-medium text-slate-600">
              Zendesk ticket link template — {"{id}"} is replaced with the ticket id; empty = no links
            </span>
            <input
              type="text"
              value={config.zendeskTicketUrlTemplate}
              onChange={(e) => patch({ zendeskTicketUrlTemplate: e.target.value })}
              placeholder="https://customer.zendesk.com/agent/tickets/{id}"
              className={inputCls}
            />
          </label>
        </div>
      </section>

      {/* Field mapping */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Jira field mapping</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          PM-OS attribute → Jira field (matched by display name). Values that aren&apos;t options of
          the Jira field are skipped with a warning in the merge preview — add the options in Jira.
        </p>
        <div className="space-y-3">
          {MAPPED_ATTRIBUTES.map((attr) => {
            const f = config.fields[attr];
            return (
              <div
                key={attr}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5"
              >
                <label className="flex w-40 items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    onChange={(e) => patchField(attr, { enabled: e.target.checked })}
                    className="rounded"
                  />
                  {ATTRIBUTE_LABELS[attr]}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-slate-500">Jira field</span>
                  <input
                    type="text"
                    value={f.jiraField}
                    onChange={(e) => patchField(attr, { jiraField: e.target.value })}
                    disabled={!f.enabled}
                    className={`${inputCls} w-44 disabled:opacity-50`}
                  />
                </label>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {TYPE_LABELS[f.type]}
                </span>
                <span className="text-xs text-slate-500">{POLICY_LABELS[f.policy]}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Update comment */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Update comment</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          Added to the Jira issue after every update, listing the affected fields.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={config.updateComment}
              onChange={(e) => patch({ updateComment: e.target.checked })}
              className="rounded"
            />
            Post a comment on updates
          </label>
          <label className="flex flex-1 items-center gap-2 text-sm">
            <span className="whitespace-nowrap text-xs text-slate-500">Prefix</span>
            <input
              type="text"
              value={config.commentPrefix}
              onChange={(e) => patch({ commentPrefix: e.target.value })}
              disabled={!config.updateComment}
              className={`${inputCls} w-full min-w-56 disabled:opacity-50`}
            />
          </label>
        </div>
      </section>

      {error && <div className="text-sm text-red-600">{error}</div>}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-green-700">
            <Check size={14} strokeWidth={2.5} />
            Saved — applies to the next merge
          </span>
        )}
      </div>
    </div>
  );
}
