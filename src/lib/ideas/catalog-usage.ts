import { db } from "../db";
import { ALL_CUSTOMERS_NAME } from "./customer-key";

/** How many Zendesk tickets, Jira issues and PM-OS ideas a catalog row touches. */
export interface CatalogUsage {
  zen: number;
  jira: number;
  ideas: number;
}

export interface WorkspaceCatalogUsage {
  /** By lower-cased product-line name. */
  products: Map<string, CatalogUsage>;
  /** By lower-cased customer name. */
  customers: Map<string, CatalogUsage>;
}

const blank = (): CatalogUsage => ({ zen: 0, jira: 0, ideas: 0 });
function bump(map: Map<string, CatalogUsage>, name: string, field: keyof CatalogUsage) {
  const key = name.trim().toLowerCase();
  if (!key) return;
  const row = map.get(key) ?? blank();
  row[field] += 1;
  map.set(key, row);
}

/**
 * Settings → Product Lines / Customers show, per row, what it is attached
 * to today. Product lines live on ideas, so a ticket or issue counts for a
 * line through the idea it sources. Customers live on tickets and issues
 * (extracted names) and on ideas (derived union + manual additions).
 */
export async function catalogUsage(workspaceId: string): Promise<WorkspaceCatalogUsage> {
  const [ideas, tickets, issues] = await Promise.all([
    db.idea.findMany({
      where: { workspaceId, batchStatus: { not: "deleted" } },
      select: {
        products: true,
        addedCustomers: true,
        sources: {
          select: {
            kind: true,
            jiraKey: true,
            ticket: { select: { id: true, affectedCustomers: true, affectsAllCustomers: true } },
          },
        },
      },
    }),
    db.zendeskTicketRaw.findMany({
      where: { workspaceId },
      select: { affectedCustomers: true, affectsAllCustomers: true },
    }),
    db.jiraIdeaSnapshot.findMany({
      where: { workspaceId },
      select: { key: true, affectedCustomers: true },
    }),
  ]);
  const products = new Map<string, CatalogUsage>();
  const customers = new Map<string, CatalogUsage>();
  const issueCustomers = new Map(
    issues.map((i) => [i.key, ((i.affectedCustomers as string[]) ?? []).filter(Boolean)]),
  );

  for (const idea of ideas) {
    const lines = ((idea.products as string[]) ?? []).filter((p) => p && p !== "Other");
    const zen = idea.sources.filter((s) => s.kind === "zendesk" && s.ticket).length;
    const jira = idea.sources.filter((s) => s.kind === "jira" && s.jiraKey).length;
    for (const p of lines) {
      bump(products, p, "ideas");
      const row = products.get(p.toLowerCase())!;
      row.zen += zen;
      row.jira += jira;
    }
    const names = new Set<string>();
    for (const s of idea.sources) {
      if (s.kind === "zendesk" && s.ticket) {
        for (const c of (s.ticket.affectedCustomers as string[]) ?? []) names.add(c.toLowerCase());
        if (s.ticket.affectsAllCustomers) names.add(ALL_CUSTOMERS_NAME.toLowerCase());
      } else if (s.kind === "jira" && s.jiraKey) {
        for (const c of issueCustomers.get(s.jiraKey) ?? []) names.add(c.toLowerCase());
      }
    }
    for (const c of (idea.addedCustomers as string[]) ?? []) names.add(c.toLowerCase());
    for (const n of names) bump(customers, n, "ideas");
  }
  for (const t of tickets) {
    for (const c of (t.affectedCustomers as string[]) ?? []) bump(customers, c, "zen");
    if (t.affectsAllCustomers) bump(customers, ALL_CUSTOMERS_NAME, "zen");
  }
  for (const [, list] of issueCustomers) for (const c of list) bump(customers, c, "jira");
  return { products, customers };
}

export function usageOf(map: Map<string, CatalogUsage>, name: string): CatalogUsage {
  return map.get(name.trim().toLowerCase()) ?? blank();
}
