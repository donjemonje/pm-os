/**
 * PM decisions the scans respect (Capability Analysis PRD, "PM and PMOS AI").
 *
 * A PM's change to the catalog is a recorded decision, and a scan never
 * reopens it. Two of those decisions are about names:
 *   - a rename keeps the replaced name behind the row (`aliases`), so a scan
 *     that meets the old name recognises the row instead of proposing a new one;
 *   - a removed (or dismissed) row keeps its name, so a scan never adds it back.
 *
 * This module is pure (no DB, no AI): it answers "which catalog row is this
 * name?", by what the row is, not only by what it is called today. Today's AI
 * step and any later analysis engine go through it.
 */

export interface NamedRow {
  id: string;
  name: string;
  /** Json column: names a PM replaced by renaming. */
  aliases: unknown;
  /** "active" | "suggested" | "dismissed" | "removed" */
  state: string;
}

export interface Resolved {
  id: string;
  state: string;
  /** The row's current name. */
  name: string;
  /** "name" = the row is called this today; "alias" = a PM renamed it away from this. */
  via: "name" | "alias";
}

/** Names compare without case and without extra spaces. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function aliasList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.trim().replace(/\s+/g, " ");
    if (s && !out.some((o) => nameKey(o) === nameKey(s))) out.push(s);
  }
  return out;
}

/** The aliases of a row after it is renamed: the old name is kept behind it, the new name is no alias of itself. */
export function aliasesAfterRename(aliases: unknown, oldName: string, newName: string): string[] {
  const next = aliasList(aliases).filter((a) => nameKey(a) !== nameKey(newName));
  if (nameKey(oldName) !== nameKey(newName) && !next.some((a) => nameKey(a) === nameKey(oldName))) next.push(oldName.trim().replace(/\s+/g, " "));
  return next;
}

/** The aliases of a row once another row takes `name` as its own: a name a PM gives by hand wins over an alias. */
export function aliasesWithout(aliases: unknown, name: string): string[] {
  return aliasList(aliases).filter((a) => nameKey(a) !== nameKey(name));
}

/**
 * Catalog rows by name and by alias. A current name always wins over an alias
 * of another row; between two aliases the first row added wins.
 */
export class NameIndex {
  private byName = new Map<string, Resolved>();
  private byAlias = new Map<string, Resolved>();

  constructor(rows: NamedRow[] = []) {
    for (const r of rows) this.add(r);
  }

  /** Rows created while a scan is being applied are added, so the same name is not created twice in one pass. */
  add(row: NamedRow): void {
    this.byName.set(nameKey(row.name), { id: row.id, state: row.state, name: row.name, via: "name" });
    for (const a of aliasList(row.aliases)) {
      const k = nameKey(a);
      if (!this.byAlias.has(k)) this.byAlias.set(k, { id: row.id, state: row.state, name: row.name, via: "alias" });
    }
  }

  resolve(name: string): Resolved | null {
    const k = nameKey(name);
    if (!k) return null;
    return this.byName.get(k) ?? this.byAlias.get(k) ?? null;
  }
}

/** What a scan does with a capability it wants to add. */
export type SuggestionVerdict =
  | { action: "create" }
  /** The name is a row the catalog already has (by name or by a replaced name), or one a PM removed or dismissed. */
  | { action: "skip"; reason: "exists" | "renamed" | "removed" | "dismissed"; row: Resolved };

export function judgeCapabilitySuggestion(index: NameIndex, name: string): SuggestionVerdict {
  const row = index.resolve(name);
  if (!row) return { action: "create" };
  if (row.state === "removed") return { action: "skip", reason: "removed", row };
  if (row.state === "dismissed") return { action: "skip", reason: "dismissed", row };
  return { action: "skip", reason: row.via === "alias" ? "renamed" : "exists", row };
}

/** Where a scan puts a capability whose domain name it proposes. */
export type DomainVerdict =
  /** An active or suggested domain, found by its name or by a name a PM replaced. */
  | { action: "use"; row: Resolved }
  /** A PM removed or dismissed this domain: it is never suggested again. */
  | { action: "skip"; reason: "removed" | "dismissed"; row: Resolved }
  | { action: "create" };

export function judgeDomainSuggestion(index: NameIndex, name: string): DomainVerdict {
  const row = index.resolve(name);
  if (!row) return { action: "create" };
  if (row.state === "removed") return { action: "skip", reason: "removed", row };
  if (row.state === "dismissed") return { action: "skip", reason: "dismissed", row };
  return { action: "use", row };
}
