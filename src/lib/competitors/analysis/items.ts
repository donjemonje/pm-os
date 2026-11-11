/**
 * The competitor's own list (Capability Analysis, "How the analysis runs", step "merge"): what a competitor
 * offers, in their words, after the same thing on several pages was merged into one item.
 *
 * Pure: no database, no network.
 */

/** Trademark, service mark, registered and copyright signs. */
const MARKS = /[\u2122\u2120\u00AE\u00A9]/g;

/**
 * The key two wordings of the same thing share: the mark signs removed, NFKC, lower-case, "&" → "and", everything
 * that is not a letter or a digit → space, spaces collapsed.
 * "Threat-Intelligence Platform(TM)" → "threat intelligence platform".
 */
export function wordingKey(name: string): string {
  return name
    // Before NFKC: it would turn the trademark sign into the letters "TM".
    .replace(MARKS, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\((?:tm|r|c)\)/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A CompetitorItem's stable key: "c:<wordingKey>" for a capability, "f:<parent item key>><wordingKey>" for a feature. */
export function itemKey(kind: "capability" | "feature", parentKey: string | null, name: string): string {
  return kind === "capability" ? `c:${wordingKey(name)}` : `f:${parentKey ?? ""}>${wordingKey(name)}`;
}

/** The item's display name: the most frequent wording among its findings; tie → the shortest; tie → alphabetical. */
export function canonicalName(wordings: string[]): string {
  const counts = new Map<string, number>();
  for (const w of wordings) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? "";
}

/** What the merge needs to know of an item. */
export interface ItemLite {
  id: string;
  kind: "capability" | "feature";
  key: string;
  name: string;
  /** wordingKeys merged into this item. */
  wordings: string[];
  parentItemId: string | null;
  /** It went through an AI merge call already (KNOWN in the next one). */
  mergeChecked: boolean;
  /** Findings that point at it. */
  findings: number;
  /** It carries a saved match or a placement answer. */
  settled: boolean;
}

/**
 * Which existing item a finding belongs to — by its key or by a wording an earlier merge saved — or null: a new
 * item. A feature is looked for only under its own capability item.
 */
export function findItem(items: ItemLite[], kind: "capability" | "feature", parentItemId: string | null, wording: string): ItemLite | null {
  const k = wordingKey(wording);
  if (!k) return null;
  return items.find((i) => i.kind === kind && (kind === "capability" || i.parentItemId === parentItemId) && i.wordings.includes(k)) ?? null;
}

/** Who stays when items are merged: the one merged by an earlier run, else the one with the most findings, else the smallest key. */
function keeperOf(members: ItemLite[]): ItemLite {
  return [...members].sort((a, b) => Number(b.mergeChecked) - Number(a.mergeChecked) || b.findings - a.findings || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];
}

export interface MergePlan {
  keepId: string;
  absorbIds: string[];
  /** The keeper has no saved match and an absorbed item has one: the keeper takes it (the first such item, by key). */
  matchFromId: string | null;
}

function planOne(members: ItemLite[]): MergePlan | null {
  if (members.length < 2) return null;
  const keeper = keeperOf(members);
  const absorbed = members.filter((m) => m.id !== keeper.id).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { keepId: keeper.id, absorbIds: absorbed.map((a) => a.id), matchFromId: keeper.settled ? null : absorbed.find((a) => a.settled)?.id ?? null };
}

/** Apply validated merge groups (prompts.ts parseMerge): the keeper per group and the items it absorbs. */
export function planMerges(groups: string[][], byCode: Map<string, ItemLite>): MergePlan[] {
  const out: MergePlan[] = [];
  for (const g of groups) {
    const plan = planOne(g.map((code) => byCode.get(code)).filter((i): i is ItemLite => Boolean(i)));
    if (plan) out.push(plan);
  }
  return out;
}

/** The feature's own wording key (its key without the capability part). */
export function ownKey(item: Pick<ItemLite, "key">): string {
  const i = item.key.lastIndexOf(">");
  return i < 0 ? item.key.replace(/^c:/, "") : item.key.slice(i + 1);
}

/** After capabilities were merged, the keeper may hold the same feature twice: features of one capability that share a wording are one. */
export function planChildMerges(children: ItemLite[]): MergePlan[] {
  const groups: ItemLite[][] = [];
  for (const c of children) {
    const hit = groups.find((g) => g.some((m) => m.wordings.some((w) => c.wordings.includes(w))));
    if (hit) hit.push(c);
    else groups.push([c]);
  }
  return groups.map(planOne).filter((p): p is MergePlan => Boolean(p));
}
