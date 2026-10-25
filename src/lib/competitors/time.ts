/** "2 min ago", "3 h ago", "yesterday", "Oct 21" — for header and log lines. Pure; client-safe. */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return shortDate(iso);
}

/** "Oct 21" in the current year, "Oct 21, 2025" otherwise. */
export function shortDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

/** "in 3 days", "in 5 h", "now" — next scheduled scan. */
export function timeUntil(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(diff) || diff <= 60_000) return "on the next run";
  const h = Math.round(diff / 3600_000);
  if (h < 24) return `in ${Math.max(1, h)} h`;
  return `in ${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? "" : "s"}`;
}
