import { arr, str } from "../ai";
import { checkPii } from "../pii";
import { wordingKey } from "./items";
import { MAX_ENUM, NO_VALUE } from "./prompts";

/**
 * UNIFY — step 4 of the setup run (Capability Analysis, "The setup run"; the database side is analysis/setup.ts).
 *
 * Every company's clean list of capability items goes in together; ROWS come out. The same capability under
 * different names at different companies becomes ONE row, named with the market's most common term. Every company's
 * own wording stays behind the evidence, on its item.
 *
 * Two prompts:
 *   - unify: a batch of items against the rows made so far. Per item: the row it belongs to — one given (R-code),
 *     one this answer creates (N-code), or "none": it is not a capability (a commercial term, a marketing headline).
 *   - review: once, over ALL rows with every company's wording behind each — rows that are the same capability are
 *     merged, rows that are no capability are dropped, a row gets its market name. The guard against the two
 *     failures of the first real run (2026-11-12): near-duplicate rows and umbrella rows.
 *
 * Closed sets only: the model answers with the item codes and row codes it was given, or row codes it declared in
 * the same answer. A code outside them makes the whole answer unusable — nothing of it is saved, the run fails.
 *
 * Nothing depends on chance: the items are taken in a fixed order (the own source first, then the competitors by
 * position; inside a company by name), a row is identified by its normalized name (items.ts wordingKey), and its
 * code and its place in the table follow from the first item that belongs to it.
 *
 * Pure: no database, no network.
 */

/** Bumping it invalidates nothing: an item's row is a saved decision. */
export const UNIFY_VERSION = "unify-1";
/**
 * Capability items per unify call. An answer line is short (two codes), a new row is a name and one sentence: at
 * most ~5,000 visible output tokens for 60 items — a call that ends in a minute or two (the first real analysis,
 * 2026-11-12: a match call of ~7,000 output tokens took over 3 minutes).
 */
export const UNIFY_BATCH = 60;
export const UNIFY_MAX_TOKENS = 12_000;
/** Rows per review call; more are reviewed in consecutive calls (duplicates across the calls can be missed — logged). */
export const UNIFY_REVIEW_MAX_ROWS = 600;
export const UNIFY_REVIEW_MAX_TOKENS = 16_000;
/** Wordings shown per company behind a row in the review. */
export const UNIFY_REVIEW_WORDINGS = 3;

const WHAT_A_CAPABILITY_IS = `A capability is something a buyer would list as a requirement when choosing a product in this market. These are NOT capabilities and get no row:
- a commercial term: a pricing model, a plan or edition, "unlimited seats", a free trial, a discount, a service level, support hours;
- a marketing headline or an umbrella for the whole product ("End-to-End AI Product Management Assistant", "The all-in-one platform"): it names no single requirement.`;

export const UNIFY_SYSTEM_PROMPT = `Several companies in one market were studied. For each company there is a list of the capabilities its website says it offers, in the company's own words. You build ONE list of rows for a comparison table of the market: each row is one capability, and every company's entry is put on the row it belongs to.

${WHAT_A_CAPABILITY_IS}

ROWS SO FAR are the rows already made, each with a code (R…). ENTRIES are the next capabilities to place, each with a code (I…), the company, the company's own name for it and, when the page said it, what it does.

For every entry answer with its row:
- the code of the row in ROWS SO FAR that is the same capability; or
- the code of a new row you create in this answer (N1, N2 …), listed under "rows" with its name and a one-sentence description; or
- "none" when the entry is not a capability.

Rules:
- Same capability, one row. Two entries are the same capability when a buyer would treat them as one line of a requirements list — whatever each company calls it. Decide by what it does, not by its name.
- Before you create a row, look for it in ROWS SO FAR and among the rows you create in this answer. Never create a row that says the same as an existing one in other words ("Enterprise security and compliance" and "Operational security and compliance controls" are one row). Do not make one row per variant of the same requirement ("GDPR compliance", "CCPA compliance" and "GDPR and CCPA compliance" are one row: "Privacy regulation compliance").
- A broader thing and a narrower thing are not the same capability. Do not put a narrow entry on a broad row only because the row exists.
- Name a new row with the market's most common term for the capability: the words an analyst's report would use. Vendor-neutral: never a product, brand or marketing name, and not necessarily the wording of any one company. Short, title case.
- The description is one plain sentence saying what the capability does.
- Answer once for every entry code. Use only the entry codes given, the row codes given and the codes of the rows you create in this answer.`;

/** The tool of one unify call: the item codes are a closed set in the schema; the row codes are checked by the parser (R-codes given, N-codes declared in the answer). */
export function unifyTool(itemCodes: string[], rowCodes: string[]): Record<string, unknown> {
  return {
    name: "place_entries",
    description: "Record the row of every entry, and the rows this answer creates.",
    input_schema: {
      type: "object" as const,
      properties: {
        rows: {
          type: "array",
          description: "The NEW rows this answer creates. Empty when every entry belongs to a row that exists.",
          items: {
            type: "object",
            properties: {
              code: { type: "string", description: "N1, N2 … — a code of your own for the new row." },
              name: { type: "string", description: "The market's most common term for the capability, at most 80 characters." },
              description: { type: "string", description: "One plain sentence: what the capability does." },
            },
            required: ["code", "name", "description"],
          },
        },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entry: { type: "string", ...(itemCodes.length <= MAX_ENUM ? { enum: itemCodes } : {}) },
              row: { type: "string", description: `A row code (${rowCodes.length ? "R… from ROWS SO FAR, or " : ""}N… of a row created in this answer), or "${NO_VALUE}" when the entry is not a capability.` },
            },
            required: ["entry", "row"],
          },
        },
      },
      required: ["rows", "entries"],
    },
  };
}

// ————— Items and rows —————

/** A capability item of one company, as the unify step sees it. */
export interface UnifyItem {
  id: string;
  competitorId: string;
  /** The company's name; `isOwn` = the organization itself. */
  company: string;
  isOwn: boolean;
  /** Its own name for it. */
  name: string;
  /** One sentence of what it does, from its pages; null when no page said. */
  description: string | null;
  /** The row it was put on (a setup placement); null = not placed yet, or excluded. */
  row: { name: string; description: string } | null;
}

/** A row of the table in the making: identified by `key` (the normalized name). */
export interface UnifyRow {
  /** "R1" … in the order of the first item that belongs to it. */
  code: string;
  key: string;
  name: string;
  description: string;
  /** The items on the row, in the fixed order. */
  members: Array<Pick<UnifyItem, "id" | "competitorId" | "company" | "isOwn" | "name">>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The fixed order of the items: by company in `companyOrder` (setup-rules.ts orderCompanies: the own source first,
 * then the competitors by position), inside a company by name, then by id.
 */
export function orderUnifyItems<T extends Pick<UnifyItem, "id" | "competitorId" | "name">>(items: T[], companyOrder: string[]): T[] {
  const rank = new Map(companyOrder.map((id, n) => [id, n]));
  const of = (i: T) => rank.get(i.competitorId) ?? companyOrder.length;
  return [...items].sort((a, b) => of(a) - of(b) || cmp(wordingKey(a.name), wordingKey(b.name)) || cmp(a.name, b.name) || cmp(a.id, b.id));
}

/** The key that identifies a row: its normalized name. */
export function rowKey(name: string): string {
  return wordingKey(name);
}

/** The rows made so far, from the items that are placed — `items` in the fixed order. A row's name and description are those of its first item. */
export function rowsOf(items: UnifyItem[]): UnifyRow[] {
  const byKey = new Map<string, UnifyRow>();
  for (const i of items) {
    if (!i.row) continue;
    const key = rowKey(i.row.name);
    if (!key) continue;
    let row = byKey.get(key);
    if (!row) {
      row = { code: `R${byKey.size + 1}`, key, name: i.row.name, description: i.row.description, members: [] };
      byKey.set(key, row);
    }
    row.members.push({ id: i.id, competitorId: i.competitorId, company: i.company, isOwn: i.isOwn, name: i.name });
  }
  return [...byKey.values()];
}

/** The next batch: the first `size` items that are not placed, in the fixed order. */
export function nextUnifyBatch<T>(todo: T[], size: number = UNIFY_BATCH): T[] {
  return todo.slice(0, Math.max(1, size));
}

/** How many calls the unify step needs for this many items, when every call places its whole batch. */
export function unifyCalls(items: number, size: number = UNIFY_BATCH): number {
  return Math.ceil(items / Math.max(1, size));
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s).replace(/\s+/g, " ").replace(/\|/g, "/").trim();

export interface UnifyEntry {
  /** "I1" … in the order of the batch. */
  code: string;
  item: UnifyItem;
}

export function unifyEntries(batch: UnifyItem[]): UnifyEntry[] {
  return batch.map((item, n) => ({ code: `I${n + 1}`, item }));
}

/**
 * The user content of one unify call: the rows so far (code, name, description, how many companies are on it) and
 * the entries (code, company, the company's own name, what it does). The organization's own entries say so: its
 * wording is one company's wording, like any other.
 */
export function renderUnify(orgName: string, rows: UnifyRow[], entries: UnifyEntry[]): string {
  const rowLines = rows.map((r) => {
    const companies = new Set(r.members.map((m) => m.competitorId)).size;
    return `${r.code} | ${short(r.name, 80)} | ${short(r.description, 200) || "(no description)"} | ${companies} compan${companies === 1 ? "y" : "ies"}`;
  });
  const entryLines = entries.map((e) => `${e.code} | ${short(e.item.company, 60)}${e.item.isOwn ? " (the organization itself)" : ""} | ${short(e.item.name, 80)} | ${e.item.description ? short(e.item.description, 240) : "(the page does not say what it does)"}`);
  return `THE ORGANIZATION: ${short(orgName, 80)}\n\nROWS SO FAR:\n${rowLines.length ? rowLines.join("\n") : "none yet"}\n\nENTRIES:\n${entryLines.join("\n")}`;
}

const clean = (text: string): string => (checkPii(text).hit ? "" : text);

export interface UnifyAssignment {
  /** The item's id. */
  itemId: string;
  /** The row it belongs to; null = not a capability: it gets no row. */
  row: { name: string; description: string } | null;
}

export interface UnifyParsed {
  assignments: UnifyAssignment[];
  /** What makes the answer unusable (the step fails the run and saves nothing): codes outside the closed sets, a new row with no name. */
  problems: string[];
  /** New rows the answer created that no entry was put on: dropped. */
  unusedRows: number;
}

/**
 * The answer of one unify call.
 *   - An entry code that was not asked → a problem. An entry answered twice keeps its first answer. An entry the
 *     answer leaves out is simply not in the result (the step asks it again in the next call).
 *   - A row code must be an R-code that was given or an N-code declared under "rows" in this answer → else a problem.
 *   - A new row needs a name (after cleaning, at most 80 characters) → else a problem. A new row whose normalized
 *     name is that of a row that exists (or of an earlier new row of this answer) IS that row: decided in code.
 *   - "none" (or an empty row) = not a capability.
 */
export function parseUnify(value: unknown, entries: UnifyEntry[], rows: UnifyRow[]): UnifyParsed {
  const o = (value ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const byEntry = new Map(entries.map((e) => [e.code, e.item]));
  const given = new Map(rows.map((r) => [r.code, { name: r.name, description: r.description }]));
  const existingByKey = new Map(rows.map((r) => [r.key, { name: r.name, description: r.description }]));
  const created = new Map<string, { name: string; description: string }>();
  const createdByKey = new Map<string, { name: string; description: string }>();
  for (const r of arr(o.rows)) {
    const ro = (r ?? {}) as Record<string, unknown>;
    const code = typeof ro.code === "string" ? ro.code.trim() : "";
    if (!/^N\d+$/.test(code)) {
      problems.push(`a new row has the code "${code || "(none)"}" — new rows are N1, N2 …`);
      continue;
    }
    if (created.has(code)) {
      problems.push(`the new row code ${code} is used twice`);
      continue;
    }
    const name = clean(str(ro.name, 80));
    const key = rowKey(name);
    if (!key) {
      problems.push(`the new row ${code} has no name`);
      continue;
    }
    // The same normalized name is the same row: one that exists wins, then the first new row with the name.
    const row = existingByKey.get(key) ?? createdByKey.get(key) ?? { name, description: clean(str(ro.description, 300)) };
    if (!existingByKey.has(key) && !createdByKey.has(key)) createdByKey.set(key, row);
    created.set(code, row);
  }
  const assignments: UnifyAssignment[] = [];
  const seen = new Set<string>();
  const used = new Set<{ name: string; description: string }>();
  for (const e of arr(o.entries)) {
    const eo = (e ?? {}) as Record<string, unknown>;
    const code = typeof eo.entry === "string" ? eo.entry.trim() : "";
    const item = byEntry.get(code);
    if (!item) {
      problems.push(`the entry code "${code || "(none)"}" was not asked`);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    const rowCode = typeof eo.row === "string" ? eo.row.trim() : "";
    if (!rowCode || rowCode.toLowerCase() === NO_VALUE) {
      assignments.push({ itemId: item.id, row: null });
      continue;
    }
    const row = given.get(rowCode) ?? created.get(rowCode);
    if (!row) {
      problems.push(`entry ${code} was put on the row "${rowCode}", which is neither a row that was given nor one created in this answer`);
      continue;
    }
    used.add(row);
    assignments.push({ itemId: item.id, row });
  }
  const unusedRows = [...createdByKey.values()].filter((r) => !used.has(r)).length;
  return { assignments, problems, unusedRows };
}

// ————— Review: all rows together —————

export const UNIFY_REVIEW_SYSTEM_PROMPT = `Below are the rows of a comparison table of one market: each row is one capability, with a code (R…), its name, its description and, behind it, what each company calls it on its own website. The rows were made in several passes, so some are wrong. Review them all together.

${WHAT_A_CAPABILITY_IS}

Answer with three lists:
- merge: groups of rows that are the same capability under different words. A buyer would write them as one line of a requirements list. Rows that only split one requirement by variant are one row too ("GDPR compliance", "CCPA compliance", "GDPR and CCPA compliance"). A broader capability and a narrower one are not the same: do not merge them. For each group give the name the merged row keeps: the market's most common term.
- drop: rows that are not a capability — a commercial term, or a marketing headline or umbrella for a whole product.
- rename: rows whose name is not the market's most common term — a product, brand or marketing name, one company's wording, or a clumsy phrase. Give the name an analyst's report would use: vendor-neutral, short, title case. A row that is in a merge group is renamed there, not here.

Rules:
- Use only the row codes given. A row appears in at most one list, and in at most one merge group.
- Most rows are right as they are: leave them out of every list. Empty lists are a correct answer.`;

export function unifyReviewTool(rowCodes: string[]): Record<string, unknown> {
  const code = { type: "string", description: "A row code, e.g. R7.", ...(rowCodes.length <= MAX_ENUM ? { enum: rowCodes } : {}) };
  return {
    name: "review_rows",
    description: "Record the rows to merge, the rows to drop and the rows to rename.",
    input_schema: {
      type: "object" as const,
      properties: {
        merge: {
          type: "array",
          items: { type: "object", properties: { rows: { type: "array", items: code }, name: { type: "string", description: "The name the merged row keeps: the market's most common term." } }, required: ["rows", "name"] },
        },
        drop: { type: "array", items: code },
        rename: { type: "array", items: { type: "object", properties: { row: code, name: { type: "string" } }, required: ["row", "name"] } },
      },
      required: ["merge", "drop", "rename"],
    },
  };
}

/** One line per row: code, name, description, then every company's wordings (at most UNIFY_REVIEW_WORDINGS each). */
export function renderUnifyReview(orgName: string, rows: UnifyRow[]): string {
  const lines = rows.map((r) => {
    const byCompany = new Map<string, { company: string; isOwn: boolean; names: string[] }>();
    for (const m of r.members) {
      const c = byCompany.get(m.competitorId) ?? { company: m.company, isOwn: m.isOwn, names: [] };
      if (!c.names.includes(m.name)) c.names.push(m.name);
      byCompany.set(m.competitorId, c);
    }
    const behind = [...byCompany.values()]
      .map((c) => `${short(c.company, 40)}${c.isOwn ? " (the organization itself)" : ""}: ${c.names.slice(0, UNIFY_REVIEW_WORDINGS).map((n) => `"${short(n, 80)}"`).join(", ")}${c.names.length > UNIFY_REVIEW_WORDINGS ? ` +${c.names.length - UNIFY_REVIEW_WORDINGS}` : ""}`)
      .join("; ");
    return `${r.code} | ${short(r.name, 80)} | ${short(r.description, 200) || "(no description)"} | ${behind}`;
  });
  return `THE ORGANIZATION: ${short(orgName, 80)}\n\nROWS:\n${lines.join("\n")}`;
}

export interface UnifyReviewParsed {
  /** Each group as row keys, in table order (the first is the row that stays), with the name the merged row keeps ("" = the first row's). */
  merges: Array<{ keys: string[]; name: string }>;
  drops: string[];
  renames: Array<{ key: string; name: string }>;
  problems: string[];
}

/**
 * The answer of the review call, as row keys. A code that was not given → a problem (the answer is unusable). A row
 * named in "drop" is dropped and leaves every other list. A row in two merge groups stays in the first. A group
 * left with fewer than two rows is no merge. A rename of a row that is in a merge group is ignored (the group has
 * its name). A name that does not survive cleaning is ignored: the row keeps its name.
 */
export function parseUnifyReview(value: unknown, rows: UnifyRow[]): UnifyReviewParsed {
  const o = (value ?? {}) as Record<string, unknown>;
  const byCode = new Map(rows.map((r, n) => [r.code, { key: r.key, n }]));
  const problems: string[] = [];
  const known = (v: unknown): { key: string; n: number } | null => {
    const code = typeof v === "string" ? v.trim() : "";
    const row = byCode.get(code);
    if (!row) problems.push(`the row code "${code || "(none)"}" was not given`);
    return row ?? null;
  };
  const dropped = new Set<string>();
  for (const d of arr(o.drop)) {
    const row = known(d);
    if (row) dropped.add(row.key);
  }
  const merged = new Set<string>();
  const merges: UnifyReviewParsed["merges"] = [];
  for (const g of arr(o.merge)) {
    const go = (g ?? {}) as Record<string, unknown>;
    const members: Array<{ key: string; n: number }> = [];
    for (const m of arr(go.rows)) {
      const row = known(m);
      if (!row || dropped.has(row.key) || merged.has(row.key) || members.some((x) => x.key === row.key)) continue;
      members.push(row);
    }
    if (members.length < 2) continue;
    members.sort((a, b) => a.n - b.n);
    for (const m of members) merged.add(m.key);
    merges.push({ keys: members.map((m) => m.key), name: clean(str(go.name, 80)) });
  }
  const renames: UnifyReviewParsed["renames"] = [];
  for (const r of arr(o.rename)) {
    const ro = (r ?? {}) as Record<string, unknown>;
    const row = known(ro.row);
    const name = clean(str(ro.name, 80));
    if (!row || dropped.has(row.key) || merged.has(row.key) || !rowKey(name) || renames.some((x) => x.key === row.key)) continue;
    renames.push({ key: row.key, name });
  }
  return { merges, drops: [...dropped], renames, problems };
}

/**
 * What every row becomes after a review — by the row's key before it: null = dropped (its items get no row), else
 * the name and description it carries from now on. Rows the review does not name are not in the result.
 *
 * A merged group keeps its first row (table order): that row's description, and the group's name when one was
 * given. When a new name — of a group or of a rename — is the normalized name of another row, the two are one row:
 * the earlier of them in the table stays and gives the name and the description. So the result never holds two
 * rows with one name.
 */
export function planUnifyReview(parsed: Pick<UnifyReviewParsed, "merges" | "drops" | "renames">, rows: UnifyRow[]): Map<string, { name: string; description: string } | null> {
  const index = new Map(rows.map((r, n) => [r.key, n]));
  const parent = rows.map((_, n) => n);
  const find = (n: number): number => (parent[n] === n ? n : (parent[n] = find(parent[n])));
  // The earlier row stays.
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const dropped = new Set(parsed.drops.filter((k) => index.has(k)));
  /** A new name asked for the row at this index (the group's first row, or a renamed row). */
  const wanted = new Map<number, string>();
  for (const g of parsed.merges) {
    const members = g.keys.filter((k) => index.has(k) && !dropped.has(k)).map((k) => index.get(k)!);
    if (members.length < 2) continue;
    for (const m of members.slice(1)) union(members[0], m);
    if (rowKey(g.name)) wanted.set(Math.min(...members), g.name);
  }
  for (const r of parsed.renames) {
    const n = index.get(r.key);
    if (n !== undefined && !dropped.has(r.key) && rowKey(r.name) && !wanted.has(n)) wanted.set(n, r.name);
  }
  // A name that is another row's name joins the two rows. Repeated until nothing joins: a join can free or take a name.
  // Only the row that stays (the root) names the row: a new name asked for a row that was joined into an earlier one is gone with it.
  const nameOf = (root: number): string => wanted.get(root) ?? rows[root].name;
  for (let changed = true; changed; ) {
    changed = false;
    const byName = new Map<string, number>();
    for (let n = 0; n < rows.length; n++) {
      if (dropped.has(rows[n].key) || find(n) !== n) continue;
      const key = rowKey(nameOf(n));
      const other = byName.get(key);
      if (other === undefined) byName.set(key, n);
      else {
        union(other, n);
        changed = true;
      }
    }
  }
  const out = new Map<string, { name: string; description: string } | null>();
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n];
    if (dropped.has(row.key)) {
      out.set(row.key, null);
      continue;
    }
    const root = find(n);
    const name = nameOf(root);
    if (root !== n || rowKey(name) !== row.key || name !== row.name) out.set(row.key, { name, description: rows[root].description });
  }
  return out;
}
