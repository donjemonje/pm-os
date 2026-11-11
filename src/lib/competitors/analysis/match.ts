import { aliasList } from "../decisions";
import { MATCH_BATCH, type MatchCatalog } from "./prompts";

/**
 * Match and place (Capability Analysis, "How the analysis runs"): their list against ours.
 *
 * Our list goes to PMOS AI with codes — a closed set: the model answers with our codes, never with free names.
 * A match is saved on the competitor's item and reused on every later run. What invalidates it — the complete list:
 * the row of ours is hard-deleted; the item is absorbed by another in a merge; an admin asks for a rematch.
 * Nothing else: not a rename, a move, a removal or restore of our row, not a new scan, not a prompt change.
 *
 * Pure: no database, no network.
 */

export { parseMatch } from "./prompts";

export interface CatalogDomain { id: string; name: string; description: string; state: string; position: number }
export interface CatalogCapability { id: string; domainId: string; name: string; description: string; aliases: unknown; state: string; position: number }
export interface CatalogFeature { id: string; capabilityId: string; name: string; description: string; aliases: unknown; state: string; position: number }

export interface Catalog extends MatchCatalog {
  /** The shared prefix of every match call of a run: our list, grouped by domain, with codes. */
  shared: string;
  /** Row id → its code. */
  codeOf: Map<string, string>;
}

/** "K-1a2b3c4d": the first 8 hex characters of the row id; one more character at a time while another row has the same. */
export function codeFor(prefix: "K" | "F" | "D", id: string, taken: Set<string>): string {
  const hex = id.replace(/[^0-9a-zA-Z]/g, "");
  for (let n = 8; n <= hex.length; n++) {
    const code = `${prefix}-${hex.slice(0, n)}`;
    if (!taken.has(code)) return code;
  }
  return `${prefix}-${hex}`;
}

const byPosition = <T extends { position: number; name: string }>(a: T, b: T) => a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const line = (code: string, name: string, description: string, aliases: unknown) => {
  const known = aliasList(aliases);
  return `${code} ${name}${description.trim() ? ` — ${description.trim().replace(/\s+/g, " ")}` : ""}${known.length ? ` (also known as: ${known.join(", ")})` : ""}`;
};

/** Capability states that are part of "ours": a removed or declined row is listed like any other, so a thing a PM removed is recognised and not added back under a new name. The model is not told which rows are removed. */
const LISTED_CAPABILITY_STATES = ["active", "suggested", "removed", "dismissed"];
const LISTED_FEATURE_STATES = ["active", "removed"];
const LISTED_DOMAIN_STATES = ["active", "suggested"];

export function buildCatalog(domains: CatalogDomain[], capabilities: CatalogCapability[], features: CatalogFeature[]): Catalog {
  const ours: Catalog["ours"] = new Map();
  const domainCodes: Catalog["domains"] = new Map();
  const codeOf = new Map<string, string>();
  const taken = new Set<string>();
  const assign = (prefix: "K" | "F" | "D", id: string): string => {
    const code = codeFor(prefix, id, taken);
    taken.add(code);
    codeOf.set(id, code);
    return code;
  };
  // Codes are given in id order, so a row's code does not depend on where it sits in the list.
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const listedDomains = domains.filter((d) => LISTED_DOMAIN_STATES.includes(d.state));
  const listedDomainIds = new Set(listedDomains.map((d) => d.id));
  const listedCapabilities = capabilities.filter((k) => LISTED_CAPABILITY_STATES.includes(k.state) && listedDomainIds.has(k.domainId));
  const listedCapabilityIds = new Set(listedCapabilities.map((k) => k.id));
  const listedFeatures = features.filter((f) => LISTED_FEATURE_STATES.includes(f.state) && listedCapabilityIds.has(f.capabilityId));
  for (const d of byId(listedDomains)) domainCodes.set(assign("D", d.id), { id: d.id, state: d.state });
  for (const k of byId(listedCapabilities)) ours.set(assign("K", k.id), { kind: "capability", id: k.id });
  for (const f of byId(listedFeatures)) ours.set(assign("F", f.id), { kind: "feature", id: f.id });

  const blocks = [...listedDomains].sort(byPosition).map((d) => {
    const rows = listedCapabilities.filter((k) => k.domainId === d.id).sort(byPosition).flatMap((k) => [
      `  ${line(codeOf.get(k.id)!, k.name, k.description, k.aliases)}`,
      ...listedFeatures.filter((f) => f.capabilityId === k.id).sort(byPosition).map((f) => `    ${line(codeOf.get(f.id)!, f.name, f.description, f.aliases)}`),
    ]);
    return [`DOMAIN ${codeOf.get(d.id)}: ${d.name}`, d.description.trim() || null, ...rows].filter((x): x is string => x !== null).join("\n");
  });
  const removed = domains.filter((d) => d.state === "removed" || d.state === "dismissed").map((d) => d.name);
  const shared = `OUR LIST\n\n${blocks.join("\n\n")}\n\nREMOVED DOMAINS: ${removed.length ? removed.join(", ") : "none"}`;
  return { ours, domains: domainCodes, shared, codeOf };
}

/** What the match needs to know of a competitor's item. */
export interface MatchItem {
  id: string;
  kind: "capability" | "feature";
  key: string;
  parentItemId: string | null;
  capabilityId: string | null;
  featureId: string | null;
  /** The match call's answer for an item that is none of ours. */
  placement: unknown;
  matchedBy: string | null;
  matchedAt: Date | null;
}

/** A saved match: our capability, our feature, or the placement answer the apply step turns into a row. */
export function isSettled(item: Pick<MatchItem, "capabilityId" | "featureId" | "placement">): boolean {
  return Boolean(item.capabilityId || item.featureId || item.placement);
}

/** A match was saved but nothing is left of it: the row of ours was hard-deleted. The item goes back on the to-do. */
export function needsRepair(item: MatchItem): boolean {
  return item.matchedAt != null && !isSettled(item);
}

/** The items a run still has to match: never matched, or matched to a row that no longer exists. A saved match is never asked again. */
export function matchTodo<T extends MatchItem>(items: T[]): T[] {
  return items.filter((i) => i.matchedAt == null || needsRepair(i));
}

/** `--rematch`: only what PMOS AI matched — not what was resolved by name, created from the item, or silenced by a PM's decision. */
export function rematchSelection<T extends MatchItem>(items: T[]): T[] {
  return items.filter((i) => i.matchedBy === "ai");
}

const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Their list in the order of a match call: capability items by key, each followed by its feature items by key; features whose capability is not on the list come last. */
export function orderItems<T extends Pick<MatchItem, "id" | "kind" | "key" | "parentItemId">>(items: T[]): T[][] {
  const capabilities = items.filter((i) => i.kind === "capability").sort(byKey);
  const ids = new Set(capabilities.map((c) => c.id));
  const features = items.filter((i) => i.kind === "feature").sort(byKey);
  const groups = capabilities.map((c) => [c, ...features.filter((f) => f.parentItemId === c.id)]);
  const orphans = features.filter((f) => !f.parentItemId || !ids.has(f.parentItemId));
  return [...groups, ...orphans.map((f) => [f])];
}

/** Batches of at most `size` entries; a capability and its features stay in one batch unless that alone is more than `size`. */
export function batchItems<T extends Pick<MatchItem, "id" | "kind" | "key" | "parentItemId">>(items: T[], size: number = MATCH_BATCH): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  for (const group of orderItems(items)) {
    if (cur.length && cur.length + group.length > size) {
      batches.push(cur);
      cur = [];
    }
    if (group.length > size) {
      for (let i = 0; i < group.length; i += size) batches.push(group.slice(i, i + size));
      continue;
    }
    cur.push(...group);
  }
  if (cur.length) batches.push(cur);
  return batches;
}
