/**
 * The order of the companies (the columns of the table and the list in Settings) — Daniel 2026-11-22: a column is
 * dragged to its new place in the table and that changes the organization's order. Pure: no database, no network.
 */

/**
 * The order after `moved` was dropped next to `target`: just before it, or just after it.
 * Dropping a company on itself, or an id that is not in the list, changes nothing (the same order comes back).
 */
export function moveNextTo(ids: readonly string[], moved: string, target: string, side: "before" | "after"): string[] {
  if (moved === target || !ids.includes(moved) || !ids.includes(target)) return [...ids];
  const rest = ids.filter((id) => id !== moved);
  const at = rest.indexOf(target) + (side === "after" ? 1 : 0);
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/** True when `next` holds exactly the ids of `current`, each once — the only kind of list the order can be saved from. */
export function isSameSet(current: readonly string[], next: unknown): next is string[] {
  if (!Array.isArray(next) || next.length !== current.length || next.some((id) => typeof id !== "string")) return false;
  const have = new Set(current);
  return new Set(next).size === next.length && next.every((id) => have.has(id));
}
