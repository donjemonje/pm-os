/**
 * The "what changed" section of an idea, derived — never narrated.
 *
 * An idea that pre-dates the current batch gets a BASELINE the first time
 * anything touches it (an import match, a PM edit, a source move): its
 * title, text, score, lines, customers and sources at that moment. For a
 * Jira-origin idea that is what Jira holds (title and lines follow live Jira
 * on every import; the text is what was last synced). The section is the
 * diff between the idea now and that baseline, recomputed on every read, so
 * it is true after an import, a PM edit, a rewrite, a move, or an undo.
 * Every line can be undone (that one thing goes back to the baseline);
 * "undo all" restores the baseline — the idea is then Unchanged again.
 * A successful sync to Jira clears the baseline: idea and Jira agree.
 *
 * Pure module: shared by the store (server) and the drawer (client).
 */

export interface IdeaBaseline {
  title: string;
  details: string;
  manual: number | null;
  products: string[];
  platforms: string[];
  addedCustomers: string[];
  /** Customers as shown on the idea (ticket-derived + added, minus dismissed).
   *  Optional: baselines captured before 2026-10-20 lack it. */
  customers?: string[];
  /** Zendesk ticket keys (externalId) and Jira issue keys. */
  zen: string[];
  jira: string[];
}

export type IdeaChangeKind =
  | "sources"
  | "title"
  | "details"
  | "score"
  | "products"
  | "platforms"
  | "customers";

export interface IdeaChange {
  /** Stable id: "sources:zen:+", "title", "products:-", … */
  id: string;
  kind: IdeaChangeKind;
  /** Human line for the section — related items are folded into one line. */
  label: string;
  /** Before → after for title / score; the previous text for "details"
   *  (the drawer's undo opens the editor on it). */
  from?: string;
  to?: string;
}

export interface IdeaLike {
  title: string;
  details: string;
  manual: number | null;
  products: string[];
  platforms: string[];
  addedCustomers: string[];
  customers?: string[];
  zen: string[];
  jira: string[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const minus = (a: string[], b: string[]) => a.filter((x) => !b.some((y) => same(x, y)));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One line per kind of change, related items folded together:
 *   +4 votes: 825, 112, 624, 633 · Jira merges 2: PRDT-331, PRDT-338 ·
 *   Title changed · Description updated · Product lines added: Monitor, Platform ·
 *   +5 customers
 */
export function diffIdea(now: IdeaLike, base: IdeaBaseline): IdeaChange[] {
  const out: IdeaChange[] = [];
  const zenAdded = minus(now.zen, base.zen);
  const zenRemoved = minus(base.zen, now.zen);
  const jiraAdded = minus(now.jira, base.jira);
  const jiraRemoved = minus(base.jira, now.jira);
  if (zenAdded.length)
    out.push({ id: "sources:zen:+", kind: "sources", label: `+${plural(zenAdded.length, "vote")}: ${zenAdded.join(", ")}` });
  if (zenRemoved.length)
    out.push({ id: "sources:zen:-", kind: "sources", label: `−${plural(zenRemoved.length, "vote")}: ${zenRemoved.join(", ")}` });
  if (jiraAdded.length)
    out.push({ id: "sources:jira:+", kind: "sources", label: `Jira merges ${jiraAdded.length}: ${jiraAdded.join(", ")}` });
  if (jiraRemoved.length)
    out.push({ id: "sources:jira:-", kind: "sources", label: `Jira removed ${jiraRemoved.length}: ${jiraRemoved.join(", ")}` });
  if (now.title.trim() !== base.title.trim())
    out.push({ id: "title", kind: "title", label: "Title changed", from: base.title, to: now.title });
  if (now.details.trim() !== base.details.trim())
    out.push({ id: "details", kind: "details", label: "Description updated", from: base.details });
  if ((now.manual ?? null) !== (base.manual ?? null))
    out.push({
      id: "score",
      kind: "score",
      label: now.manual === null ? "Score cleared" : `Score set to ${now.manual}`,
      from: base.manual === null ? "" : String(base.manual),
      to: now.manual === null ? "" : String(now.manual),
    });
  const list = (id: string, kind: IdeaChangeKind, label: string, items: string[]) => {
    if (items.length) out.push({ id, kind, label: `${label}: ${items.join(", ")}` });
  };
  list("products:+", "products", "Product lines added", minus(now.products, base.products));
  list("products:-", "products", "Product lines removed", minus(base.products, now.products));
  list("platforms:+", "platforms", "Platforms added", minus(now.platforms, base.platforms));
  list("platforms:-", "platforms", "Platforms removed", minus(base.platforms, now.platforms));
  // Customers: a count is enough (the chips show who) — only when the
  // baseline knows them.
  if (base.customers && now.customers) {
    const added = minus(now.customers, base.customers).length;
    const removed = minus(base.customers, now.customers).length;
    if (added) out.push({ id: "customers:+", kind: "customers", label: `+${plural(added, "customer")}` });
    if (removed) out.push({ id: "customers:-", kind: "customers", label: `−${plural(removed, "customer")}` });
  }
  return out;
}
