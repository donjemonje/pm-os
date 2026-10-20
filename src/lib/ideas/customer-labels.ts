import { customerKey } from "./customer-key";

/**
 * Customers as Jira labels (Daniel, 2026-10-20): a select field's options
 * need Administer Jira to grow, labels don't — any user who can edit the
 * issue may add one. Jira labels can't hold spaces, so a name becomes a
 * prefixed slug: "Kensington Securities" → "cs_kensington-securities". The
 * prefix keeps PM-OS labels apart from the team's own.
 */
export const DEFAULT_CUSTOMER_LABEL_PREFIX = "cs_";

export function customerLabel(name: string, prefix = DEFAULT_CUSTOMER_LABEL_PREFIX): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9֐-׿]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}${slug}`;
}

export function isCustomerLabel(label: string, prefix = DEFAULT_CUSTOMER_LABEL_PREFIX): boolean {
  return label.startsWith(prefix) && label.length > prefix.length;
}

/**
 * Label → customer name: the catalog spelling when the slug matches a catalog
 * name or alias (by customer key), else the slug with dashes as spaces.
 */
export function labelToCustomerName(
  label: string,
  catalog: { name: string; aliases?: string[] | null }[],
  prefix = DEFAULT_CUSTOMER_LABEL_PREFIX,
): string {
  const slug = label.slice(prefix.length);
  const wanted = customerKey(slug.replace(/-/g, " "));
  for (const c of catalog) {
    if (customerKey(c.name) === wanted) return c.name;
    for (const a of c.aliases ?? []) if (customerKey(a) === wanted) return c.name;
  }
  return slug.replace(/-/g, " ");
}
