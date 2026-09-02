"use client";

import { useState } from "react";
import { Globe, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FlagChoice } from "./OrgEnablements";

const FLAGS: { key: string; label: string; description: string }[] = [
  {
    key: "googleSso",
    label: "Google SSO",
    description:
      "Sign in with Google: the /login button and the whole OAuth flow. System-wide — the org is unknown before sign-in.",
  },
  {
    key: "selfSignup",
    label: "Self-service sign-up",
    description:
      "Lets visitors create their own account and organization via /register (and first-time Google sign-in). Off = only users added in Admin can sign in.",
  },
];

export function SystemFlags({
  initialFlags,
  envDefaults,
}: {
  /** Only keys with a stored override are present. */
  initialFlags: Record<string, boolean>;
  envDefaults: Record<string, boolean>;
}) {
  const [flags, setFlags] = useState(initialFlags);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function setFlag(key: string, value: boolean | null) {
    setBusy(key);
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
      setFlags(data.flags);
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

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
            <Globe className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold">System</p>
            <p className="text-xs text-slate-500">
              Applies before sign-in, across all organizations
            </p>
          </div>
        </div>

        <ul className="divide-y divide-slate-100">
          {FLAGS.map((flag) => {
            const override = flags[flag.key];
            const hasOverride = typeof override === "boolean";
            const effective = hasOverride ? override : envDefaults[flag.key];
            const rowBusy = busy === flag.key;
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
                    onClick={() => setFlag(flag.key, true)}
                  />
                  <FlagChoice
                    label="Off"
                    active={hasOverride && override === false}
                    disabled={rowBusy}
                    onClick={() => setFlag(flag.key, false)}
                  />
                  <FlagChoice
                    label={`Default (${envDefaults[flag.key] ? "on" : "off"})`}
                    active={!hasOverride}
                    disabled={rowBusy}
                    onClick={() => setFlag(flag.key, null)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
