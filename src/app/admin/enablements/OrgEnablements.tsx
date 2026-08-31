"use client";

import { useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  /** Only keys with an explicit override are present. */
  features: Record<string, boolean>;
};

const FLAGS: { key: string; label: string; description: string }[] = [
  {
    key: "ideas",
    label: "Ideas",
    description: "Ideas pipeline: page, settings, and import APIs.",
  },
  {
    key: "docs",
    label: "Docs",
    description: "Documents: pages, editor, generation APIs, dashboard cards.",
  },
  {
    key: "chat",
    label: "Chat",
    description: "PMOS Chat: page, floating panel, and chat APIs.",
  },
  {
    key: "googleSso",
    label: "Google SSO",
    description:
      "Sign in with Google for this org's members. Enforced at sign-in; the login-page button follows the env default.",
  },
];

export function OrgEnablements({
  initialOrganizations,
  envDefaults,
}: {
  initialOrganizations: OrgRow[];
  envDefaults: Record<string, boolean>;
}) {
  const [organizations, setOrganizations] = useState(initialOrganizations);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function setFlag(orgId: string, key: string, value: boolean | null) {
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

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {organizations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
          No organizations yet.
        </div>
      ) : (
        organizations.map((org) => (
          <div
            key={org.id}
            className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                <Building2 className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold">{org.name}</p>
                <p className="text-xs text-slate-500">
                  {org.memberCount} {org.memberCount === 1 ? "member" : "members"} · /
                  {org.slug}
                </p>
              </div>
            </div>

            <ul className="divide-y divide-slate-100">
              {FLAGS.map((flag) => {
                const override = org.features[flag.key];
                const hasOverride = typeof override === "boolean";
                const effective = hasOverride ? override : envDefaults[flag.key];
                const rowBusy = busy === `${org.id}:${flag.key}`;
                return (
                  <li
                    key={flag.key}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {flag.label}{" "}
                        <span
                          className={cn(
                            "ml-2 rounded-full px-2 py-0.5 text-xs font-medium",
                            effective
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-500"
                          )}
                        >
                          {effective ? "On" : "Off"}
                          {hasOverride ? "" : " (default)"}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500">{flag.description}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {rowBusy && (
                        <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                      )}
                      <FlagChoice
                        label="On"
                        active={hasOverride && override === true}
                        disabled={rowBusy}
                        onClick={() => setFlag(org.id, flag.key, true)}
                      />
                      <FlagChoice
                        label="Off"
                        active={hasOverride && override === false}
                        disabled={rowBusy}
                        onClick={() => setFlag(org.id, flag.key, false)}
                      />
                      <FlagChoice
                        label={`Default (${envDefaults[flag.key] ? "on" : "off"})`}
                        active={!hasOverride}
                        disabled={rowBusy}
                        onClick={() => setFlag(org.id, flag.key, null)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

function FlagChoice({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || active}
      className={cn(
        "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      )}
    >
      {label}
    </button>
  );
}
