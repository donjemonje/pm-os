/** Issue number for ordering ("PRDT-28" → 28); keys without a number sort last. */
export function issueNumber(key: string): number {
  const n = Number(key.split("-").pop());
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** Oldest issue of a set — the one an idea shows first and a sync writes to. */
export function primaryJiraKey(keys: string[]): string | null {
  if (keys.length === 0) return null;
  return [...keys].sort((a, b) => issueNumber(a) - issueNumber(b) || a.localeCompare(b))[0];
}
