"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Building2, Loader2 } from "lucide-react";

/** The one organization every admin screen works on — always visible, switchable here only. */
export function AdminOrgBanner({
  current,
  all,
}: {
  current: { id: string; name: string; slug: string } | null;
  all: { id: string; name: string; slug: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function pick(orgId: string) {
    setBusy(true);
    try {
      await fetch("/api/admin/current-org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <Building2 className="h-4 w-4 shrink-0" />
      <label className="flex items-center gap-2">
        <span className="shrink-0 font-medium">Organization</span>
        <select
          value={current?.id ?? ""}
          onChange={(e) => void pick(e.target.value)}
          disabled={busy || all.length === 0}
          aria-label="Organization"
          className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-sm font-semibold text-slate-900"
        >
          {all.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.slug})
            </option>
          ))}
        </select>
      </label>
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      <span className="truncate text-xs text-amber-800">Every screen below shows and changes this organization only.</span>
    </div>
  );
}
