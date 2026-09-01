"use client";

import { useState } from "react";
import { Check } from "lucide-react";

/**
 * Per-user pick of "my product lines" — the Ideas screen opens filtered to
 * these and the merge scope defaults to them. Purely a personal default:
 * clearing the filter always shows everything.
 */
export function MyProductLinesPanel({
  options,
  initialSelected,
}: {
  options: string[];
  initialSelected: string[];
}) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const toggle = (name: string) => {
    setSaved(false);
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/ideas/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productLines: selected }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: undefined }));
        setError(data.error ?? "Save failed");
        return;
      }
      setSaved(true);
    } catch {
      setError("Save failed — is the dev server running?");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2 className="font-title mb-1 text-[15px] font-semibold">My Product Lines</h2>
      <p className="mb-3 text-[13px] text-muted">
        Your own default for the Ideas screen: it opens filtered to these lines and Merge to
        Jira starts scoped to them. Optional — clear the filter on the Ideas screen to see
        everything.
      </p>
      {options.length === 0 ? (
        <p className="text-[13px] text-muted">Add product lines above first.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((name) => {
            const active = selected.includes(name);
            return (
              <button
                key={name}
                onClick={() => toggle(name)}
                className={
                  active
                    ? "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-primary px-3 py-1 text-[12.5px] font-medium text-white"
                    : "inline-flex items-center whitespace-nowrap rounded-full border border-border bg-white px-3 py-1 text-[12.5px] font-medium text-[#3f506b] hover:border-primary/55"
                }
              >
                {name}
                {active && <Check size={12} strokeWidth={2.5} />}
              </button>
            );
          })}
        </div>
      )}
      {error && <div className="mt-2 text-[13px] text-[#c94266]">{error}</div>}
      <div className="mt-3 flex items-center gap-2.5">
        <button
          onClick={save}
          disabled={saving || options.length === 0}
          className="rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-xs text-[#1f8a53]">
            <Check size={12} strokeWidth={2.5} />
            Saved
          </span>
        )}
      </div>
    </section>
  );
}
