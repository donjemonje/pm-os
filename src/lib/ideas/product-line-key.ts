/**
 * Product-line identity across systems (Daniel, 2026-10-13: Jira's Module and
 * PM-OS product lines are ONE taxonomy).
 *
 * A catalog row has a canonical name ("Platform") and aliases — the spelling
 * the customer's Jira option uses ("Platform General") and the variants
 * reporters type ("Platform- General"). Matching is by normalized key, so
 * punctuation, spacing and case never split one product line into two.
 *
 * Used on the Jira pull (Module value → catalog name), on the Zendesk import
 * (the ticket's Module column → catalog name, deterministic) and on the push
 * (catalog name → the alias that is a Jira option).
 */

/** Lower-case alphanumerics only: "Platform- General" → "platformgeneral". */
export function productLineKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9֐-׿]/g, "");
}

export interface ProductLineCatalogRow {
  name: string;
  aliases?: unknown;
}

export function aliasesOf(row: ProductLineCatalogRow): string[] {
  return Array.isArray(row.aliases)
    ? row.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
}

export interface ProductLineResolver {
  /** Catalog name for a value (name or alias, any spelling); undefined = unknown. */
  resolve(value: string): string | undefined;
  /** Name + aliases of a catalog row, canonical first — the candidates a Jira
   *  select field is offered on push. Unknown name → [name]. */
  spellings(name: string): string[];
}

/**
 * Catalog entry for the AI prompts: aliases folded into the description so
 * the model maps any spelling in a ticket to the canonical name.
 */
export function catalogEntryWithAliases<T extends { name: string; description: string; aliases?: unknown }>(
  row: T
): { name: string; description: string } {
  const aliases = aliasesOf(row);
  if (aliases.length === 0) return { name: row.name, description: row.description };
  const note = `also called: ${aliases.join(", ")}`;
  return {
    name: row.name,
    description: row.description ? `(${note}) ${row.description}` : `(${note})`,
  };
}

export function buildProductLineResolver(catalog: ProductLineCatalogRow[]): ProductLineResolver {
  const byKey = new Map<string, string>();
  const rows = new Map<string, string[]>();
  for (const row of catalog) {
    const spellings = [row.name, ...aliasesOf(row)];
    rows.set(productLineKey(row.name), spellings);
    for (const s of spellings) {
      const k = productLineKey(s);
      if (k && !byKey.has(k)) byKey.set(k, row.name);
    }
  }
  return {
    resolve: (value) => {
      const k = productLineKey(value ?? "");
      return k ? byKey.get(k) : undefined;
    },
    spellings: (name) => rows.get(productLineKey(name)) ?? [name],
  };
}
