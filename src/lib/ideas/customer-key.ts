/**
 * Normalized identity of a customer name — what "the same company" means
 * across the Customer Name column, PMOS AI's parsed names and the catalog:
 * case, punctuation, spacing, a leading "The" and a trailing legal suffix
 * are not identity. "The Whitfield Group" and "Whitfield Group" share a
 * key; "Nortek" and "Nortek Industries" do not — that is a PM's call, made
 * with the merge action in Settings → Customers.
 */
const LEGAL_SUFFIXES = [
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "llc",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "srl",
  "bv",
  "co",
  "corp",
  "corporation",
  "company",
];

export function customerKey(name: string): string {
  let k = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9֐-׿\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (k.startsWith("the ")) k = k.slice(4);
  const parts = k.split(" ");
  while (parts.length > 1 && LEGAL_SUFFIXES.includes(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

/** Catalog lookup by normalized key, aliases included; returns the catalog spelling. */
export function buildCustomerResolver(
  catalog: { name: string; aliases?: string[] | null }[],
): (name: string) => string {
  const byKey = new Map<string, string>();
  for (const c of catalog) {
    byKey.set(customerKey(c.name), c.name);
    for (const a of c.aliases ?? []) {
      const k = customerKey(a);
      if (!byKey.has(k)) byKey.set(k, c.name);
    }
  }
  return (name: string) => byKey.get(customerKey(name)) ?? name;
}
