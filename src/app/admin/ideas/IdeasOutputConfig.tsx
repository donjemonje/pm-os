"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  ATTRIBUTE_LABELS,
  DEFAULT_IDEA_TEMPLATE,
  JIRA_PULL_MAX_ISSUES,
  MAPPED_ATTRIBUTES,
  type IdeasJiraConfig,
  type JiraPullConfig,
  type MappedAttribute,
} from "@/lib/ideas/jira-mapping";
import {
  CSV_PARAM_META,
  CSV_PARAMS,
  type CsvParam,
} from "@/lib/ideas/csv-mapping";
import { ImportRuns } from "./ImportRuns";

export interface PromptView {
  id: string;
  title: string;
  note: string;
  text: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  config: IdeasJiraConfig;
  /** Admin → Enablements "Jira integration" for the org — makes the Jira onboarding mandatory. */
  jiraEnabled: boolean;
  jiraConnected: boolean;
  jiraConnection: {
    authType: string;
    connectedBy: string | null;
    siteUrl: string;
    apiTokenExpiresAt: string | null;
  } | null;
}

const POLICY_LABELS: Record<string, string> = {
  read: "Read on import — shown on the raw Jira issue, never written",
  set_if_empty: "Set only when empty (never replace a human's value)",
  increment: "Increment by this batch's new votes",
  union: "Add missing values (never remove)",
};

const TYPE_LABELS: Record<string, string> = {
  text: "Text",
  single_select: "Single select",
  number: "Number",
  multi_select: "Multi select",
  labels: "Labels (prefixed)",
};

export function IdeasOutputConfig({
  organizations,
  prompts,
}: {
  organizations: OrgRow[];
  prompts: PromptView[];
}) {
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? "");
  const [configs, setConfigs] = useState<Record<string, IdeasJiraConfig>>(
    Object.fromEntries(organizations.map((o) => [o.id, o.config])),
  );
  // What the server holds, per org — Save is enabled only when the form
  // differs from it; a successful save moves the baseline.
  const [savedConfigs, setSavedConfigs] = useState<Record<string, IdeasJiraConfig>>(
    Object.fromEntries(organizations.map((o) => [o.id, o.config])),
  );
  const [saving, setSaving] = useState(false);
  /** The selected org's Jira data, read through ITS connection (undefined = loading). */
  const [orgJira, setOrgJira] = useState<
    | { projects: { key: string; name: string }[]; issueTypes: string[]; defaultIssueType: string }
    | undefined
  >(undefined);
  const selectedProject = configs[orgId]?.jiraProject ?? "";
  useEffect(() => {
    let stale = false;
    setOrgJira(undefined);
    if (!orgId) return;
    const q = selectedProject ? `?project=${encodeURIComponent(selectedProject)}` : "";
    fetch(`/api/admin/organizations/${orgId}/jira-projects${q}`)
      .then((r): Promise<Partial<{ projects: { key: string; name: string }[]; issueTypes: string[]; defaultIssueType: string }>> =>
        r.ok ? r.json() : Promise.resolve({}),
      )
      .then((data) => {
        if (stale) return;
        setOrgJira({
          projects: data.projects ?? [],
          issueTypes: data.issueTypes ?? [],
          defaultIssueType: data.defaultIssueType ?? "",
        });
      })
      .catch(() => {
        if (!stale) setOrgJira({ projects: [], issueTypes: [], defaultIssueType: "" });
      });
    return () => {
      stale = true;
    };
  }, [orgId, selectedProject]);
  const [remapping, setRemapping] = useState(false);
  /** PM-OS user + API token form (option A). */
  const [tokenEmail, setTokenEmail] = useState("support@pm-os.io");
  const [tokenValue, setTokenValue] = useState("");
  const [tokenExpiry, setTokenExpiry] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function saveToken() {
    setTokenBusy(true);
    setTokenMsg(null);
    try {
      const res = await fetch(`/api/admin/organizations/${orgId}/jira-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: tokenEmail, token: tokenValue, expiresAt: tokenExpiry || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTokenMsg({ ok: false, text: data.error ?? "Save failed" });
        return;
      }
      setTokenValue("");
      setTokenMsg({ ok: true, text: `Connected as ${data.connectedBy} — reload to see it in the status line.` });
    } finally {
      setTokenBusy(false);
    }
  }
  async function removeConnection() {
    if (!window.confirm("Remove this organization's Jira connection? Imports run without Jira until it is connected again.")) return;
    setTokenBusy(true);
    try {
      await fetch(`/api/admin/organizations/${orgId}/jira-token`, { method: "DELETE" });
      setTokenMsg({ ok: true, text: "Connection removed — reload to see it in the status line." });
    } finally {
      setTokenBusy(false);
    }
  }
  const [remapResult, setRemapResult] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const org = organizations.find((o) => o.id === orgId);
  const config = configs[orgId];
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfigs[orgId]);
  if (!org || !config) {
    return (
      <p className="text-sm text-slate-500">
        No organizations with a workspace yet.
      </p>
    );
  }

  const patch = (next: Partial<IdeasJiraConfig>) => {
    setSaved(false);
    setConfigs((prev) => ({ ...prev, [orgId]: { ...prev[orgId], ...next } }));
  };
  const patchField = (
    attr: MappedAttribute,
    next: Partial<IdeasJiraConfig["fields"][MappedAttribute]>,
  ) => {
    setSaved(false);
    setConfigs((prev) => ({
      ...prev,
      [orgId]: {
        ...prev[orgId],
        fields: {
          ...prev[orgId].fields,
          [attr]: { ...prev[orgId].fields[attr], ...next },
        },
      },
    }));
  };

  const patchPull = (next: Partial<JiraPullConfig>) => {
    setSaved(false);
    setConfigs((prev) => ({
      ...prev,
      [orgId]: { ...prev[orgId], pull: { ...prev[orgId].pull, ...next } },
    }));
  };

  const patchCsv = (param: CsvParam, aliasesText: string) => {
    setSaved(false);
    const aliases = aliasesText
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    setConfigs((prev) => ({
      ...prev,
      [orgId]: {
        ...prev[orgId],
        csv: { ...prev[orgId].csv, [param]: aliases },
      },
    }));
  };

  const remap = async () => {
    setRemapping(true);
    setRemapResult("");
    setError("");
    try {
      const res = await fetch(
        `/api/admin/organizations/${orgId}/ideas-config/remap`,
        {
          method: "POST",
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Re-map failed");
        return;
      }
      setRemapResult(
        `${data.updated} ticket${data.updated === 1 ? "" : "s"} re-mapped` +
          (data.customersAdded > 0
            ? `, ${data.customersAdded} customers added`
            : ""),
      );
    } catch {
      setError("Re-map failed");
    } finally {
      setRemapping(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/organizations/${orgId}/ideas-config`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setConfigs((prev) => ({ ...prev, [orgId]: data.config }));
      setSavedConfigs((prev) => ({ ...prev, [orgId]: data.config }));
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
        <select
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className={inputCls}
        >
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.slug})
            </option>
          ))}
        </select>
      </label>

      <section className="space-y-4">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-base font-bold">Stats</h2>
          <p className="mt-0.5 text-xs text-slate-500">Import runs for this organization — health, duration and AI cost of the pipeline, newest first.</p>
        </div>
      {/* Import run history — health and cost of the pipeline for this org */}
      <ImportRuns orgId={orgId} />

      </section>
      <section className="space-y-4">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-base font-bold">Jira</h2>
          <p className="mt-0.5 text-xs text-slate-500">How the connected Jira is read on import and written on sync: the pull ceiling, which Jira fields map to PM-OS attributes, and what a sync writes to the issue.</p>
        </div>
      {/* Jira onboarding — the org's one project and the work type new ideas get */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Jira project &amp; work type</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          The one Jira project this organization manages its ideas in: imports read it,
          Sync to Jira writes to it, and new ideas are created there as the work type
          below. Set once when enabling Jira for the organization; members see it
          read-only in Settings → Integrations.
        </p>
        {org.jiraEnabled && !config.jiraProject && (
          <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Jira integration is ON for this organization but no project is set — imports run
            without Jira and the Ideas page shows a warning until this is saved.
          </div>
        )}
        {!org.jiraConnected && (
          <div className="mb-3 text-xs text-slate-500">
            Jira is not connected for this organization yet — type the project key and work
            type; they apply as soon as the PM-OS user token below is saved.
          </div>
        )}
        <div className="mb-4">
          <div className="mb-1.5 text-xs font-medium text-slate-600">Jira site</div>
          <input
            type="text"
            value={config.jiraSiteUrl}
            onChange={(e) => patch({ jiraSiteUrl: e.target.value.trim() })}
            placeholder="https://your-site.atlassian.net"
            className={`${inputCls} w-80`}
          />
          <div className="mt-1 text-[11px] text-slate-500">
            The site the PM-OS user token below is checked against and every request goes to.
            {org.jiraConnected && !config.jiraSiteUrl ? " Leave empty to keep the site connected today." : ""}
          </div>
        </div>
        {/* Connection: who Jira sees us as */}
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-1 text-xs font-medium text-slate-600">Connection</div>
          <div className="text-sm">
            {org.jiraConnection ? (
              org.jiraConnection.authType === "basic" ? (
                <>
                  PM-OS user <b>{org.jiraConnection.connectedBy ?? "—"}</b> via API token on{" "}
                  <span className="font-mono text-xs">{org.jiraConnection.siteUrl}</span>
                  {org.jiraConnection.apiTokenExpiresAt ? (
                    <>
                      {" "}
                      · token expires {new Date(org.jiraConnection.apiTokenExpiresAt).toLocaleDateString()}
                      {new Date(org.jiraConnection.apiTokenExpiresAt).getTime() - Date.now() < 30 * 86_400_000 && (
                        <span className="ml-1 font-semibold text-amber-700">(renew soon)</span>
                      )}
                    </>
                  ) : (
                    " · token expiry unknown"
                  )}
                  . Every write in Jira shows this user. With Jira enabled for the organization, anything
                  that stops it working (this token, a removed connection, no project) shows members
                  "contact support" and emails support@pm-os.io once per incident.
                </>
              ) : (
                <>
                  <span className="font-semibold text-amber-700">Legacy OAuth connection</span> by{" "}
                  <b>{org.jiraConnection.connectedBy ?? "an unknown account"}</b> on{" "}
                  <span className="font-mono text-xs">{org.jiraConnection.siteUrl}</span> — no longer supported:
                  members see Jira as unavailable until the PM-OS user below is saved.
                </>
              )
            ) : (
              "Not connected. Set the PM-OS user below — members cannot connect Jira themselves."
            )}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_160px]">
            <input
              type="email"
              value={tokenEmail}
              onChange={(e) => setTokenEmail(e.target.value)}
              placeholder="PM-OS user email (support@pm-os.io)"
              className={inputCls}
            />
            <input
              type="password"
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
              placeholder="Atlassian API token"
              autoComplete="off"
              className={inputCls}
            />
            <input
              type="date"
              value={tokenExpiry}
              onChange={(e) => setTokenExpiry(e.target.value)}
              title="The expiry you chose when creating the token (max 1 year)"
              className={inputCls}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void saveToken()}
              disabled={tokenBusy || !tokenEmail.trim() || !tokenValue.trim() || !config.jiraSiteUrl}
              title={!config.jiraSiteUrl ? "Set and save the Jira site first" : "Checks the token against the site, then stores it sealed"}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {tokenBusy && <Loader2 size={14} className="animate-spin" />}
              Save & test token
            </button>
            {org.jiraConnection && (
              <button
                type="button"
                onClick={() => void removeConnection()}
                disabled={tokenBusy}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:border-red-400 hover:text-red-700 disabled:opacity-50"
              >
                Remove connection
              </button>
            )}
            {tokenMsg && <span className={`text-xs ${tokenMsg.ok ? "text-emerald-700" : "text-red-600"}`}>{tokenMsg.text}</span>}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            The PM-OS user must be a user of the site with access to the project (and Administer Jira if
            select-field options are created on sync). Token: id.atlassian.com → Security → API tokens, signed in
            as that user. The token is sealed at rest and never shown again.
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-600">Project</div>
            {org.jiraConnected && orgJira === undefined ? (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : org.jiraConnected && orgJira && orgJira.projects.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {orgJira.projects.map((p) => {
                  const on = config.jiraProject === p.key;
                  return (
                    <label
                      key={p.key}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                        on
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-300 bg-white hover:border-slate-500"
                      }`}
                    >
                      <input
                        type="radio"
                        name="jira-project"
                        checked={on}
                        onChange={() => patch({ jiraProject: p.key, jiraIssueType: "" })}
                        className="sr-only"
                      />
                      <span className="font-mono text-xs">{p.key}</span>
                      <span className={on ? "text-slate-200" : "text-slate-600"}>{p.name}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                type="text"
                value={config.jiraProject}
                onChange={(e) => patch({ jiraProject: e.target.value.toUpperCase() })}
                placeholder="PRDT"
                className={`${inputCls} w-40`}
              />
            )}
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-600">Work type for new ideas</div>
            {org.jiraConnected && orgJira && orgJira.issueTypes.length > 0 ? (
              <select
                value={config.jiraIssueType || orgJira.defaultIssueType}
                onChange={(e) => patch({ jiraIssueType: e.target.value })}
                className={`${inputCls} w-44`}
              >
                {orgJira.issueTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {t === orgJira.defaultIssueType && !config.jiraIssueType ? " (default)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.jiraIssueType}
                onChange={(e) => patch({ jiraIssueType: e.target.value })}
                placeholder="Story"
                className={`${inputCls} w-44`}
              />
            )}
            {org.jiraConnected && orgJira && orgJira.defaultIssueType && !config.jiraIssueType && (
              <div className="mt-1 text-[11px] text-slate-500">
                Default: {orgJira.defaultIssueType} — the type the pulled issues use most.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Jira pull — how the backlog is read at import */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Jira pull</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          The connected projects are read in full on every import, every
          status included. Each issue&apos;s product line is the Jira field
          mapped as Product Line below (Kela: Module), Components when that
          field is empty — matched to the catalog by name or alias; a value
          with no match lands in Other and is listed in the import run.
        </p>
        <label className="flex flex-col gap-1 text-sm sm:w-72">
          <span className="text-xs font-medium text-slate-600">
            Max issues per project (ceiling {JIRA_PULL_MAX_ISSUES.toLocaleString()})
          </span>
          <input
            type="number"
            min={1}
            max={JIRA_PULL_MAX_ISSUES}
            value={config.pull.maxIssues}
            onChange={(e) =>
              patchPull({
                maxIssues: Math.min(
                  JIRA_PULL_MAX_ISSUES,
                  Math.max(1, parseInt(e.target.value, 10) || 1),
                ),
              })
            }
            className={inputCls}
          />
        </label>
      </section>

      {/* Field mapping */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Jira field mapping</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          PM-OS attribute → Jira field (matched by display name). Product Line
          is also read on import: its Jira field is the issue&apos;s product
          line (Kela: Module), mapped to the catalog by name or alias. On
          sync the catalog name or whichever alias is a Jira option is
          written (Settings → Product Lines holds the aliases). Values with no
          matching option are skipped with a warning in the sync preview.
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
                    onChange={(e) =>
                      patchField(attr, { enabled: e.target.checked })
                    }
                    className="rounded"
                  />
                  {ATTRIBUTE_LABELS[attr]}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-xs text-slate-500">Jira field</span>
                  <input
                    type="text"
                    value={f.jiraField}
                    onChange={(e) =>
                      patchField(attr, { jiraField: e.target.value })
                    }
                    disabled={!f.enabled}
                    className={`${inputCls} w-44 disabled:opacity-50`}
                  />
                </label>
                {attr === "customers" ? (
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <select
                      value={f.type === "labels" ? "labels" : "multi_select"}
                      onChange={(e) =>
                        patchField(attr, {
                          type: e.target.value as "labels" | "multi_select",
                          jiraField: e.target.value === "labels" ? "Labels" : f.jiraField === "Labels" ? "Customers" : f.jiraField,
                          ...(e.target.value === "labels" ? { labelPrefix: f.labelPrefix ?? "cs_" } : {}),
                        })
                      }
                      disabled={!f.enabled}
                      className={`${inputCls} w-40 disabled:opacity-50`}
                      title="Labels: any user who can edit the issue may add one (no admin right). Multi select: options must exist or be created, which needs Administer Jira."
                    >
                      <option value="labels">Labels (prefixed)</option>
                      <option value="multi_select">Multi select field</option>
                    </select>
                    {f.type === "labels" && (
                      <input
                        type="text"
                        value={f.labelPrefix ?? "cs_"}
                        onChange={(e) => patchField(attr, { labelPrefix: e.target.value.replace(/\s+/g, "") })}
                        disabled={!f.enabled}
                        placeholder="(no prefix)"
                        title="Prefix on every customer label (cs_kensington-securities). Needed on Jira's own Labels field; leave empty for a dedicated custom Labels-type field such as 'Customers'."
                        className={`${inputCls} w-20 disabled:opacity-50`}
                      />
                    )}
                  </label>
                ) : (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {TYPE_LABELS[f.type]}
                  </span>
                )}
                <span className="text-xs text-slate-500">
                  {POLICY_LABELS[f.policy]}
                </span>
                {(f.type === "single_select" || f.type === "multi_select") && (
                  <label
                    className="flex items-center gap-1.5 text-xs text-slate-600"
                    title="A value Jira doesn't have as an option yet is added to the field during the sync (the PM-OS user needs the Administer Jira permission on the site)."
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(f.createOptions)}
                      onChange={(e) =>
                        patchField(attr, { createOptions: e.target.checked })
                      }
                      disabled={!f.enabled}
                      className="rounded"
                    />
                    Create missing options
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Description format */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Description</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          On every sync the Jira description becomes the PM-OS idea text, a
          gap, and the supported-tickets list. The idea is where the issue&apos;s
          original text and the ticket evidence were merged.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-slate-600">
              Tickets heading
            </span>
            <input
              type="text"
              value={config.supportedTicketsHeading}
              onChange={(e) =>
                patch({ supportedTicketsHeading: e.target.value })
              }
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-slate-600">
              Blank lines before the list
            </span>
            <input
              type="number"
              min={0}
              max={10}
              value={config.descriptionGapLines}
              onChange={(e) =>
                patch({
                  descriptionGapLines: Math.max(
                    0,
                    parseInt(e.target.value, 10) || 0,
                  ),
                })
              }
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-xs font-medium text-slate-600">
              Zendesk ticket link template — {"{id}"} is replaced with the
              ticket id; empty = no links
            </span>
            <input
              type="text"
              value={config.zendeskTicketUrlTemplate}
              onChange={(e) =>
                patch({ zendeskTicketUrlTemplate: e.target.value })
              }
              placeholder="https://customer.zendesk.com/agent/tickets/{id}"
              className={inputCls}
            />
          </label>
        </div>
      </section>

      {/* Update comment */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Update comment</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          Added to the Jira issue after every update, listing the affected
          fields.
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
            <span className="whitespace-nowrap text-xs text-slate-500">
              Prefix
            </span>
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

      </section>
      <section className="space-y-4">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-base font-bold">Zendesk</h2>
          <p className="mt-0.5 text-xs text-slate-500">How this organization&apos;s support data comes in — today a CSV export; a live Zendesk connection is the next step.</p>
        </div>
      {/* CSV import mapping */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">CSV import mapping</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          Which column header(s) of this organization&apos;s Zendesk export feed
          each PM-OS param — decided once when onboarding their file format.
          Comma-separated aliases, first match wins, case-insensitive; empty
          turns the param off. Save, then re-apply to update already-imported
          tickets from their stored raw rows (AI verdicts untouched).
        </p>
        <div className="space-y-2">
          {CSV_PARAMS.map((param) => {
            const meta = CSV_PARAM_META[param];
            return (
              <div
                key={param}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3 py-2"
              >
                <span className="w-36 text-sm font-medium">
                  {meta.label}
                  {meta.required && <span className="text-red-500"> *</span>}
                </span>
                <input
                  type="text"
                  value={config.csv[param].join(", ")}
                  onChange={(e) => patchCsv(param, e.target.value)}
                  className={`${inputCls} w-80 font-mono text-xs`}
                />
                <span className="min-w-48 flex-1 text-xs text-slate-500">
                  {meta.treatment}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={remap}
            disabled={remapping}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:border-slate-500 disabled:opacity-50"
          >
            {remapping && <Loader2 size={14} className="animate-spin" />}
            {remapping
              ? "Re-applying…"
              : "Re-apply mapping to imported tickets"}
          </button>
          {remapResult && (
            <span className="inline-flex items-center gap-1 text-sm text-green-700">
              <Check size={14} strokeWidth={2.5} />
              {remapResult}
            </span>
          )}
        </div>
      </section>

      </section>
      <section className="space-y-4">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-base font-bold">AI</h2>
          <p className="mt-0.5 text-xs text-slate-500">Everything PMOS AI does in the pipeline: field parsing, the idea template it writes to, and the prompts of every stage.</p>
        </div>
      {/* AI field parsing */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Field parsing (AI)</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          Customer fields in support exports are free text — lists, qualifiers
          (&quot;submitted by X&quot;, &quot;and prospect Y&quot;), and
          all-customers markers. With parsing on, one Gemini call per import
          turns the raw values into clean names and an &quot;affects all
          customers&quot; flag. Default is ON for every organization; off falls
          back to naive separator splitting.
        </p>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={config.fieldParsing.customers}
            onChange={(e) =>
              patch({
                fieldParsing: {
                  ...config.fieldParsing,
                  customers: e.target.checked,
                },
              })
            }
            className="rounded"
          />
          Customers
        </label>
      </section>

      {/* Idea template */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">Idea template</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          The sections PMOS AI writes for every idea (markdown, ## headings),
          including each section&apos;s own rules for when to omit it. Sources
          are listed separately and automatically — the template covers only the
          written idea. Applies to the next import.
        </p>
        <textarea
          value={config.ideaTemplate}
          onChange={(e) => patch({ ideaTemplate: e.target.value })}
          rows={12}
          className={`${inputCls} w-full resize-y font-mono text-xs leading-relaxed`}
        />
        <div className="mt-2">
          <button
            onClick={() => patch({ ideaTemplate: DEFAULT_IDEA_TEMPLATE })}
            disabled={config.ideaTemplate === DEFAULT_IDEA_TEMPLATE}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:border-slate-500 disabled:opacity-40"
          >
            Reset to default
          </button>
        </div>
      </section>

      {/* AI prompts (read-only) */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold">AI prompts</h2>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          The system prompts PMOS AI runs with, for review — read-only; changing
          them is a code change (the version names below are recorded on every
          ledger row).
        </p>
        <div className="space-y-2">
          {prompts.map((prompt) => (
            <details
              key={prompt.id}
              className="rounded-lg border border-slate-200"
            >
              <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium hover:bg-slate-50">
                {prompt.title}
              </summary>
              <div className="border-t border-slate-200 px-3 py-3">
                <p className="mb-2 text-xs text-slate-500">{prompt.note}</p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">
                  {prompt.text}
                </pre>
              </div>
            </details>
          ))}
        </div>
      </section>

      </section>
      {error && <div className="text-sm text-red-600">{error}</div>}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !dirty}
          title={dirty ? undefined : "No changes to save"}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-green-700">
            <Check size={14} strokeWidth={2.5} />
            Saved — applies to the next sync
          </span>
        )}
      </div>
    </div>
  );
}
