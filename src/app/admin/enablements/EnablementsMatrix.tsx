"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Search, X } from "lucide-react";
import { FLAG_AREAS, type FlagDef } from "@/lib/flag-catalog";
import { cn } from "@/lib/utils";

export type OrgColumn = {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  /** Only keys with an explicit override are present. */
  features: Record<string, boolean>;
};

type Override = boolean | undefined;

/**
 * Enablements as a matrix: rows = flags grouped by product area, columns =
 * organizations. System-wide flags (no per-org value) render one cell that
 * spans the org columns. Search filters columns, area chips filter row
 * groups, "Overrides only" hides rows where everything is on default.
 *
 * DOM contract for tests: tr[data-flag=<key>][data-scope=system|org],
 * td[data-org=<slug>] (system cells: data-org="system"); each cell has one
 * span.rounded-full badge and On / Off / Default (<env>) buttons.
 */
export function EnablementsMatrix({
  initialOrganizations,
  orgEnvDefaults,
  initialSystemFlags,
  systemEnvDefaults,
}: {
  initialOrganizations: OrgColumn[];
  orgEnvDefaults: Record<string, boolean>;
  /** Only keys with a stored override are present. */
  initialSystemFlags: Record<string, boolean>;
  systemEnvDefaults: Record<string, boolean>;
}) {
  const [organizations, setOrganizations] = useState(initialOrganizations);
  const [systemFlags, setSystemFlags] = useState(initialSystemFlags);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [area, setArea] = useState<string>("all");
  const [overridesOnly, setOverridesOnly] = useState(false);
  /** Explicitly picked organizations (empty = all). Combined with search. */
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<string>>(new Set());

  const visibleOrgs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return organizations.filter((org) => {
      if (selectedOrgIds.size > 0 && !selectedOrgIds.has(org.id)) return false;
      if (!q) return true;
      return (
        org.name.toLowerCase().includes(q) || org.slug.toLowerCase().includes(q)
      );
    });
  }, [organizations, search, selectedOrgIds]);

  const areas = useMemo(() => {
    return FLAG_AREAS.map((a) => ({
      ...a,
      flags: a.flags.filter((flag) => {
        if (area !== "all" && a.key !== area) return false;
        if (!overridesOnly) return true;
        if (flag.scope === "system") {
          return typeof systemFlags[flag.key] === "boolean";
        }
        return visibleOrgs.some(
          (org) => typeof org.features[flag.key] === "boolean"
        );
      }),
    })).filter((a) => a.flags.length > 0);
  }, [area, overridesOnly, systemFlags, visibleOrgs]);

  async function setOrgFlag(orgId: string, key: string, value: boolean | null) {
    setBusy(`${orgId}:${key}`);
    setError("");
    try {
      const res = await fetch(`/api/admin/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: { [key]: value } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to update flag");
        return;
      }
      setOrganizations((orgs) =>
        orgs.map((org) =>
          org.id === orgId ? { ...org, features: data.organization.features } : org
        )
      );
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function setSystemFlag(key: string, value: boolean | null) {
    setBusy(`system:${key}`);
    setError("");
    try {
      const res = await fetch("/api/admin/system-flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flags: { [key]: value } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to update flag");
        return;
      }
      setSystemFlags(data.flags);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const orgColumnCount = Math.max(visibleOrgs.length, 1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("");
            }}
            placeholder="Search organizations…"
            aria-label="Search organizations"
            className="w-64 rounded-lg border border-slate-300 bg-white py-2 pl-8 pr-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
          />
        </label>

        <OrgPicker
          organizations={organizations}
          selected={selectedOrgIds}
          onChange={setSelectedOrgIds}
        />

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by area">
          <AreaChip label="All areas" active={area === "all"} onClick={() => setArea("all")} />
          {FLAG_AREAS.map((a) => (
            <AreaChip
              key={a.key}
              label={a.label}
              active={area === a.key}
              onClick={() => setArea(a.key)}
            />
          ))}
        </div>

        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={overridesOnly}
            onChange={(e) => setOverridesOnly(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Overrides only
        </label>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-max border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <th className="sticky left-0 z-10 w-[16rem] max-w-[16rem] bg-slate-50/95 px-4 py-3 font-medium backdrop-blur">
                Feature
              </th>
              <th className="px-3 py-3 font-medium" title="Environment default — applies wherever no override is set">
                Default
              </th>
              {visibleOrgs.length === 0 ? (
                <th className="px-4 py-3 font-medium normal-case tracking-normal text-slate-400">
                  {organizations.length === 0
                    ? "No organizations yet"
                    : "No organizations match"}
                </th>
              ) : (
                visibleOrgs.map((org) => (
                  <th
                    key={org.id}
                    data-org={org.slug}
                    className="min-w-[13rem] px-4 py-3 font-medium normal-case tracking-normal"
                  >
                    <span className="block text-sm font-semibold text-slate-900">
                      {org.name}
                    </span>
                    <span className="block text-xs font-normal text-slate-500">
                      {org.memberCount} {org.memberCount === 1 ? "member" : "members"} · /
                      {org.slug}
                    </span>
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {areas.length === 0 && (
              <tr>
                <td
                  colSpan={2 + orgColumnCount}
                  className="px-4 py-8 text-center text-sm text-slate-400"
                >
                  Nothing to show with the current filters.
                </td>
              </tr>
            )}
            {areas.map((a) => (
              <FragmentRows
                key={a.key}
                areaKey={a.key}
                areaLabel={a.label}
                flags={a.flags}
                colSpan={2 + orgColumnCount}
                envDefaultOf={(flag) =>
                  flag.scope === "system"
                    ? systemEnvDefaults[flag.key]
                    : orgEnvDefaults[flag.key]
                }
                renderFlag={(flag) => {
                  if (flag.scope === "system") {
                    const override: Override = systemFlags[flag.key];
                    return (
                      <td
                        data-org="system"
                        colSpan={orgColumnCount}
                        className="px-4 py-2.5 align-middle"
                      >
                        <FlagCell
                          override={override}
                          envDefault={systemEnvDefaults[flag.key]}
                          busy={busy === `system:${flag.key}`}
                          onChange={(v) => setSystemFlag(flag.key, v)}
                          scopeLabel="System-wide"
                        />
                      </td>
                    );
                  }
                  if (visibleOrgs.length === 0) {
                    return <td className="px-4 py-2.5 text-slate-300">—</td>;
                  }
                  return visibleOrgs.map((org) => {
                    const override: Override = org.features[flag.key];
                    return (
                      <td
                        key={org.id}
                        data-org={org.slug}
                        className="px-4 py-2.5 align-middle"
                      >
                        <FlagCell
                          override={override}
                          envDefault={orgEnvDefaults[flag.key]}
                          busy={busy === `${org.id}:${flag.key}`}
                          onChange={(v) => setOrgFlag(org.id, flag.key, v)}
                        />
                      </td>
                    );
                  });
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Multi-select organization filter: a dropdown of checkboxes. Empty
 * selection = every organization. Esc closes, click-outside closes.
 */
function OrgPicker({
  organizations,
  selected,
  onChange,
}: {
  organizations: OrgColumn[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  const label =
    selected.size === 0
      ? "All organizations"
      : selected.size === 1
        ? organizations.find((o) => selected.has(o.id))?.name ?? "1 organization"
        : `${selected.size} organizations`;

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm",
          selected.size > 0
            ? "border-slate-900 bg-slate-900 text-white"
            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        )}
      >
        {label}
        <ChevronDown className="h-4 w-4 opacity-70" />
      </button>
      {selected.size > 0 && (
        <button
          type="button"
          onClick={() => onChange(new Set())}
          aria-label="Clear organization filter"
          title="Clear"
          className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {open && (
        <ul
          role="listbox"
          aria-multiselectable="true"
          className="absolute left-0 z-20 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
        >
          {organizations.length === 0 && (
            <li className="px-2 py-1.5 text-sm text-slate-400">No organizations</li>
          )}
          {organizations.map((org) => {
            const on = selected.has(org.id);
            return (
              <li key={org.id} role="option" aria-selected={on}>
                <button
                  type="button"
                  onClick={() => toggle(org.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded border",
                      on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300"
                    )}
                    aria-hidden
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{org.name}</span>
                  <span className="text-xs text-slate-400">/{org.slug}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FragmentRows({
  areaKey,
  areaLabel,
  flags,
  colSpan,
  envDefaultOf,
  renderFlag,
}: {
  areaKey: string;
  areaLabel: string;
  flags: FlagDef[];
  colSpan: number;
  envDefaultOf: (flag: FlagDef) => boolean;
  renderFlag: (flag: FlagDef) => React.ReactNode;
}) {
  return (
    <>
      <tr data-area={areaKey} className="border-t border-slate-200 bg-slate-50/60">
        <td
          colSpan={colSpan}
          className="sticky left-0 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
        >
          {areaLabel}
        </td>
      </tr>
      {flags.map((flag) => (
        <tr
          key={flag.key}
          data-flag={flag.key}
          data-scope={flag.scope}
          className="border-t border-slate-100 hover:bg-slate-50/50"
        >
          <td className="sticky left-0 z-10 w-[16rem] max-w-[16rem] bg-white/95 px-4 py-2.5 align-middle backdrop-blur">
            <p className="truncate text-sm font-medium text-slate-900">{flag.label}</p>
            {/* One line; the full text is the hover tooltip. */}
            <p
              className="truncate text-xs text-slate-500"
              title={flag.description}
            >
              {flag.description}
            </p>
          </td>
          <td className="px-3 py-2.5 align-middle" data-default={String(envDefaultOf(flag))}>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                envDefaultOf(flag)
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-slate-100 text-slate-500"
              )}
            >
              {envDefaultOf(flag) ? "On" : "Off"}
            </span>
          </td>
          {renderFlag(flag)}
        </tr>
      ))}
    </>
  );
}

function AreaChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 text-slate-600 hover:bg-slate-50"
      )}
    >
      {label}
    </button>
  );
}

/**
 * One cell: effective-state badge (updates only from the API response, so it
 * doubles as the "saved" signal) + On / Off / Default trio. The Default
 * button's accessible name carries the env default ("Default (off)").
 */
function FlagCell({
  override,
  envDefault,
  busy,
  onChange,
  scopeLabel,
}: {
  override: Override;
  envDefault: boolean;
  busy: boolean;
  onChange: (value: boolean | null) => void;
  scopeLabel?: string;
}) {
  const hasOverride = typeof override === "boolean";
  const effective = hasOverride ? override : envDefault;
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
          effective ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
        )}
      >
        {effective ? "On" : "Off"}
        {hasOverride ? "" : " (default)"}
      </span>
      <div className="flex items-center gap-1">
        <FlagChoice
          label="On"
          active={hasOverride && override === true}
          disabled={busy}
          onClick={() => onChange(true)}
        />
        <FlagChoice
          label="Off"
          active={hasOverride && override === false}
          disabled={busy}
          onClick={() => onChange(false)}
        />
        <FlagChoice
          label="Def"
          ariaLabel={`Default (${envDefault ? "on" : "off"})`}
          active={!hasOverride}
          disabled={busy}
          onClick={() => onChange(null)}
        />
      </div>
      {busy && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
      {scopeLabel && (
        <span className="ml-1 text-xs text-slate-400">{scopeLabel}</span>
      )}
    </div>
  );
}

function FlagChoice({
  label,
  ariaLabel,
  active,
  disabled,
  onClick,
}: {
  label: string;
  ariaLabel?: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled || active}
      className={cn(
        "rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
        active
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      )}
    >
      {label}
    </button>
  );
}
