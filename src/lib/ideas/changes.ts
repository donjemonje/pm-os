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
  /** Zendesk ticket keys (externalId) and Jira issue keys. */
  zen: string[];
  jira: string[];
}

export type IdeaChangeKind =
  | "source_added"
  | "source_removed"
  | "title"
  | "details"
  | "score"
  | "product_added"
  | "product_removed"
  | "platform_added"
  | "platform_removed"
  | "customer_added"
  | "customer_removed";

export interface IdeaChange {
  /** Stable id for undo: "source:zen:+:KEY", "title", "product:-:Fraud", … */
  id: string;
  kind: IdeaChangeKind;
  /** Human line for the section. */
  label: string;
  /** Before → after for title / score; the item for list changes. */
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
  zen: string[];
  jira: string[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const minus = (a: string[], b: string[]) => a.filter((x) => !b.some((y) => same(x, y)));

export function diffIdea(now: IdeaLike, base: IdeaBaseline): IdeaChange[] {
  const out: IdeaChange[] = [];
  for (const k of minus(now.zen, base.zen))
    out.push({ id: `source:zen:+:${k}`, kind: "source_added", label: `+1 vote (ticket ${k})`, to: k });
  for (const k of minus(base.zen, now.zen))
    out.push({ id: `source:zen:-:${k}`, kind: "source_removed", label: `Ticket ${k} removed`, from: k });
  for (const k of minus(now.jira, base.jira))
    out.push({ id: `source:jira:+:${k}`, kind: "source_added", label: `${k} merged in`, to: k });
  for (const k of minus(base.jira, now.jira))
    out.push({ id: `source:jira:-:${k}`, kind: "source_removed", label: `${k} removed`, from: k });
  if (now.title.trim() !== base.title.trim())
    out.push({ id: "title", kind: "title", label: "Title changed", from: base.title, to: now.title });
  if (now.details.trim() !== base.details.trim())
    out.push({ id: "details", kind: "details", label: "Text updated" });
  if ((now.manual ?? null) !== (base.manual ?? null))
    out.push({
      id: "score",
      kind: "score",
      label: now.manual === null ? "Score cleared" : `Score set to ${now.manual}`,
      from: base.manual === null ? "" : String(base.manual),
      to: now.manual === null ? "" : String(now.manual),
    });
  for (const p of minus(now.products, base.products))
    out.push({ id: `product:+:${p}`, kind: "product_added", label: `Product line added: ${p}`, to: p });
  for (const p of minus(base.products, now.products))
    out.push({ id: `product:-:${p}`, kind: "product_removed", label: `Product line removed: ${p}`, from: p });
  for (const p of minus(now.platforms, base.platforms))
    out.push({ id: `platform:+:${p}`, kind: "platform_added", label: `Platform added: ${p}`, to: p });
  for (const p of minus(base.platforms, now.platforms))
    out.push({ id: `platform:-:${p}`, kind: "platform_removed", label: `Platform removed: ${p}`, from: p });
  for (const c of minus(now.addedCustomers, base.addedCustomers))
    out.push({ id: `customer:+:${c}`, kind: "customer_added", label: `Customer added: ${c}`, to: c });
  for (const c of minus(base.addedCustomers, now.addedCustomers))
    out.push({ id: `customer:-:${c}`, kind: "customer_removed", label: `Customer removed: ${c}`, from: c });
  return out;
}

/**
 * The idea after undoing ONE change (by id) against its baseline. Returns the
 * next field values; unknown ids return `now` unchanged. A product-line list
 * never ends up empty — it falls back to the baseline's lines.
 */
export function undoOne(now: IdeaLike, base: IdeaBaseline, changeId: string): IdeaLike {
  const next: IdeaLike = {
    ...now,
    products: [...now.products],
    platforms: [...now.platforms],
    addedCustomers: [...now.addedCustomers],
    zen: [...now.zen],
    jira: [...now.jira],
  };
  const m = changeId.match(/^source:(zen|jira):([+-]):(.+)$/);
  if (m) {
    const [, kind, sign, key] = m;
    const list = kind === "zen" ? next.zen : next.jira;
    if (sign === "+") {
      const filtered = list.filter((k) => !same(k, key));
      if (kind === "zen") next.zen = filtered;
      else next.jira = filtered;
    } else if (!list.some((k) => same(k, key))) list.push(key);
    return next;
  }
  if (changeId === "title") next.title = base.title;
  else if (changeId === "details") next.details = base.details;
  else if (changeId === "score") next.manual = base.manual;
  else {
    const l = changeId.match(/^(product|platform|customer):([+-]):(.+)$/);
    if (!l) return now;
    const [, field, sign, value] = l;
    const key = field === "product" ? "products" : field === "platform" ? "platforms" : "addedCustomers";
    const list = next[key];
    if (sign === "+") next[key] = list.filter((x) => !same(x, value));
    else if (!list.some((x) => same(x, value))) next[key] = [...list, value];
    if (key === "products" && next.products.length === 0) next.products = [...base.products];
  }
  return next;
}

export function undoAll(base: IdeaBaseline): IdeaLike {
  return {
    title: base.title,
    details: base.details,
    manual: base.manual,
    products: [...base.products],
    platforms: [...base.platforms],
    addedCustomers: [...base.addedCustomers],
    zen: [...base.zen],
    jira: [...base.jira],
  };
}
