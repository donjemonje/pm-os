import { arr, str } from "../ai";
import { checkPii } from "../pii";
import { wordingKey } from "./items";

/**
 * UNIFY — step 3 of the setup run (Capability Analysis, "The setup run"; the database side is analysis/setup.ts).
 *
 * Every company's list — its capabilities, and the features under each — goes in; the ROWS of the table come out.
 * The same capability under different names at different companies is ONE row, named with the market's term and
 * one plain sentence. Then the feature rows under each row. Every company's own wording stays behind the evidence,
 * on its item.
 *
 * One request cannot hold it (six companies, tens of capabilities and a hundred features each: the hand test of
 * 2026-11-16 took 202 seconds for two companies), so the step works in three kinds of call:
 *
 *   A. CAPABILITIES → ROWS. The capabilities in a fixed order (the organization first, then the competitors by
 *      position; inside a company in its list's order), UNIFY_CAPABILITY_BATCH per call. A call gets the rows made
 *      so far and puts each capability on one of them or on a new row. Companies whose capabilities fit one call
 *      are unified in ONE call.
 *   B. REVIEW — only when A took more than one call: all rows together, once, to merge rows that are the same
 *      capability and were made in different calls.
 *   C. FEATURES → FEATURE ROWS. Per batch of rows (whole rows, UNIFY_FEATURE_BATCH features per call): the
 *      features the companies have under those rows become feature rows. A feature that clearly belongs to another
 *      row is put there when that row is in the same call, or handed over ("moved") when it is not; moved features
 *      are placed in a second round, against the feature rows their new row already has, and are not moved again.
 *
 * Closed sets, exactly once: an answer names capabilities, features and rows by the short codes it was given. A
 * code that was not given makes the answer unusable (nothing of it is saved; the run fails). A code used twice
 * keeps its first place. A code an answer leaves out is asked again. So every capability and every feature ends on
 * exactly one row.
 *
 * Nothing depends on chance: the order is fixed, the batches are cut over ALL items (placed or not) so a run that
 * stopped continues with the very same calls, and a row is identified by its normalized name (items.ts wordingKey).
 *
 * Pure: no database, no network.
 */

/** Bumping it invalidates nothing: an item's row is a saved decision. unify-2 (2026-11-16): rows AND feature rows, by codes used exactly once. */
export const UNIFY_VERSION = "unify-2";
/** Capabilities per call of kind A. An answer line is a few codes; a new row is a name and one sentence. */
export const UNIFY_CAPABILITY_BATCH = 80;
/** Features per call of kind C. A feature row is a name, one sentence and its codes (~40 output tokens). */
export const UNIFY_FEATURE_BATCH = 120;
/** Feature names shown under a capability in a call of kind A, as a hint of what it covers. */
export const UNIFY_HINT_FEATURES = 10;
export const UNIFY_MAX_TOKENS = 24_000;
export const UNIFY_REVIEW_MAX_TOKENS = 8_000;
/** Closed sets up to this size ride in the response schema as an enum; larger ones are enforced by the parser only. */
const MAX_ENUM = 120;
/** A row code that asks for a new row. */
export const NEW_ROW = "new";

const ROW_SIZE = `A row is ONE capability of the market: one thing a product can do — one line a buyer would write in a list of requirements. Take a car: "Car entertainment" is an area (a domain: never a row), "Bluetooth connection" is a capability (a row), "iPhone support" is a feature (a detail of one row).`;

export const UNIFY_CAPABILITIES_PROMPT = `A product team compares the companies of one market in a table. The material of each company was read, and for each company there is a list of the capabilities it offers, in its own words — each with a code, what it does and some of the features under it. Build the rows of the table.

${ROW_SIZE}

Rules:
- When two companies offer the same capability under different names, it is ONE row. Put the code of each company's capability on the row. A capability only one company has is a row of its own.
- A company's capability may be wider or narrower than another's. Group by what the buyer gets, not by the words. When one company's capability covers two rows, put its code on the row it fits best. Never build a wide row to hold capabilities that are different things.
- Name a row with the term the market uses for it — the words an analyst's report would use — never one company's product or brand name. Short, title case. Give one plain sentence saying what it is.
- ROWS SO FAR, when given, are the rows already made from other capabilities, each with a code (R…). Put a capability on a row that exists (its code) when it is the same capability. Make a new row (row = "new", with its name and description) only when no row is the same capability. Never make a new row that says the same as an existing one in other words.
- Use every capability code exactly once. Use only the codes given.`;

export const UNIFY_REVIEW_PROMPT = `Below are the rows of a comparison table of one market: each row is one capability, with a code, its name, what it is and what each company calls it. The rows were made in several passes, so two rows may be the same capability under different words. Find them.

${ROW_SIZE}

Answer with "merge": the groups of rows that are the same capability — a buyer would write them as one line of a list of requirements. A broader capability and a narrower one are not the same: do not merge them. For each group give the name the merged row keeps: the term the market uses for it.

Use only the row codes given. A row is in at most one group. Most rows are right as they are: an empty list is a correct answer.`;

const FEATURE_RULES = `- The same feature at two companies is ONE feature row, with both codes. A feature only one company has is a feature row of its own.
- Name a feature row with the term the market uses for it, never one company's brand name, and say what it is about (custom fields ON WHAT, reports ABOUT WHAT). Give one plain sentence saying what it does.
- Put a feature on a feature row that exists (its code) when it is the same feature. Make a new feature row (feature_row = "new", with its name and description) only when none is.`;

export const UNIFY_FEATURES_PROMPT = `A product team compares the companies of one market in a table. The rows of the table are made: each row is one capability of the market. Now the features: under each row, a feature row is one feature — a detail of how that capability works.

You get ALL ROWS of the table (code, name, what it is). Then, for some of them (ROWS TO FILL), the features the companies have under the row — each with a code, the company, the company's own name for it and what it does — and the feature rows the row already has, when it has any.

Rules:
${FEATURE_RULES}
- A feature belongs under the row it is listed with, unless it clearly belongs to another row (a company's MCP server, listed with its integrations, belongs to the row about MCP servers). Then: when that other row is one of the ROWS TO FILL, put the feature in a feature row under it; when it is another row of ALL ROWS, list the feature under "moved" with that row's code.
- Use every feature code exactly once — in a feature row or under "moved". Use only the codes given.`;

/** The second round: features another call moved to these rows. They stay. */
export const UNIFY_MOVED_FEATURES_PROMPT = `A product team compares the companies of one market in a table. The rows of the table are made: each row is one capability of the market, and under each row a feature row is one feature — a detail of how that capability works.

The features below were listed by their company under another capability and belong to the row they are shown with here. For each row you get the feature rows it already has and the features to add — each with a code, the company, the company's own name for it and what it does.

Rules:
${FEATURE_RULES}
- Every feature stays under the row it is shown with.
- Use every feature code exactly once. Use only the codes given.`;

// ————— Items, codes, rows —————

/** A row as an item carries it until the catalog is made: its name identifies it. */
export interface RowRef {
  name: string;
  description: string;
}

/** A capability of one company's list, as the unify step sees it. */
export interface UnifyCapability {
  id: string;
  competitorId: string;
  company: string;
  isOwn: boolean;
  /** "A3": the company's letter and the capability's place in its list. */
  code: string;
  name: string;
  description: string;
  /** The names of the features under it (a hint of what it covers). */
  features: string[];
  /** The row it was put on; null = not placed yet. */
  row: RowRef | null;
}

/** A feature of one company's list. */
export interface UnifyFeature {
  id: string;
  competitorId: string;
  company: string;
  isOwn: boolean;
  /** "A3.2": its capability's code and its place under it. */
  code: string;
  name: string;
  description: string;
  /** The company's capability it is listed under. */
  capabilityItemId: string;
  /** The feature row it was put on: the row (by name) and the feature row (by name). Null = not placed yet. */
  placed: { row: string; name: string; description: string } | null;
  /** A call moved it to this row (by name): it is placed there in the second round. Null = it is with its own capability's row. */
  movedTo: string | null;
}

/** "A" … "Z", "AA" … — the letter of the n-th company (0 = the first). */
export function companyLetter(n: number): string {
  let out = "";
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) out = String.fromCharCode(65 + (i % 26)) + out;
  return out;
}

export function capabilityCode(company: number, capability: number): string {
  return `${companyLetter(company)}${capability + 1}`;
}
export function featureCode(capabilityCode: string, feature: number): string {
  return `${capabilityCode}.${feature + 1}`;
}

/** A row of the table in the making: identified by `key` (its normalized name). */
export interface UnifyRow {
  /** "R1" … in the order of the first capability on it. */
  code: string;
  key: string;
  name: string;
  description: string;
  /** The capabilities on the row, in the fixed order. */
  members: UnifyCapability[];
}

export function rowKey(name: string): string {
  return wordingKey(name);
}

/** The rows made so far, from the capabilities that are placed — `capabilities` in the fixed order. A row's name and description are those of the first capability on it. */
export function rowsOf(capabilities: UnifyCapability[]): UnifyRow[] {
  const byKey = new Map<string, UnifyRow>();
  for (const c of capabilities) {
    if (!c.row) continue;
    const key = rowKey(c.row.name);
    if (!key) continue;
    let row = byKey.get(key);
    if (!row) {
      row = { code: `R${byKey.size + 1}`, key, name: c.row.name, description: c.row.description, members: [] };
      byKey.set(key, row);
    }
    row.members.push(c);
  }
  return [...byKey.values()];
}

/** The calls of kind A: slices of ALL capabilities in the fixed order — placed or not — so the cuts never move. */
export function capabilityBatches<T>(all: T[], size: number = UNIFY_CAPABILITY_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += Math.max(1, size)) out.push(all.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * The calls of kind C: the rows in table order, whole rows packed up to `size` features per call — counted over
 * ALL features of a row, placed or not, so the cuts never move. A row with more features than `size` is a call of
 * its own (the step asks it in consecutive parts). A row with no feature is in no call.
 */
export function featureBatches(rows: Array<{ key: string; features: number }>, size: number = UNIFY_FEATURE_BATCH): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  for (const r of rows) {
    if (r.features <= 0) continue;
    if (cur.length && n + r.features > size) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(r.key);
    n += r.features;
  }
  if (cur.length) out.push(cur);
  return out;
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s).replace(/\s+/g, " ").replace(/\|/g, "/").trim();
const clean = (text: string): string => (checkPii(text).hit ? "" : text);
const who = (c: { company: string; isOwn: boolean }) => `${short(c.company, 60)}${c.isOwn ? " (the organization itself)" : ""}`;

// ————— A. Capabilities → rows —————

/** The user content of a call of kind A: the rows so far, then the capabilities to place, company by company. */
export function renderUnifyCapabilities(orgName: string, rows: UnifyRow[], entries: UnifyCapability[]): string {
  const rowLines = rows.map((r) => `${r.code} | ${short(r.name, 80)} — ${short(r.description, 240) || "(no description)"} | on it: ${[...new Set(r.members.map((m) => short(m.company, 40)))].join(", ")}`);
  const lines: string[] = [];
  let company = "";
  for (const e of entries) {
    if (e.competitorId !== company) {
      if (lines.length) lines.push("");
      lines.push(`COMPANY ${who(e)}`);
      company = e.competitorId;
    }
    const hint = e.features.slice(0, UNIFY_HINT_FEATURES).map((f) => short(f, 60)).join(" · ");
    lines.push(`${e.code} | ${short(e.name, 80)} — ${short(e.description, 300) || "(its pages do not say what it does)"}${hint ? ` | features: ${hint}${e.features.length > UNIFY_HINT_FEATURES ? ` · +${e.features.length - UNIFY_HINT_FEATURES}` : ""}` : ""}`);
  }
  return `THE ORGANIZATION: ${short(orgName, 80)}\n\n${rowLines.length ? `ROWS SO FAR:\n${rowLines.join("\n")}\n\n` : ""}CAPABILITIES TO PLACE:\n${lines.join("\n")}`;
}

export function unifyCapabilitiesTool(codes: string[], rowCodes: string[]): Record<string, unknown> {
  return {
    name: "build_rows",
    description: "The rows of the table: each with the capabilities of the companies that are on it.",
    input_schema: {
      type: "object" as const,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              row: { type: "string", description: `${rowCodes.length ? "The code of a row of ROWS SO FAR (R…), or " : ""}"${NEW_ROW}" for a row this answer makes.` },
              name: { type: "string", description: "For a new row: the term the market uses for the capability, at most 80 characters. Empty for a row that exists." },
              description: { type: "string", description: "For a new row: one plain sentence saying what it is. Empty for a row that exists." },
              capabilities: { type: "array", items: { type: "string", ...(codes.length <= MAX_ENUM ? { enum: codes } : {}) } },
            },
            required: ["row", "name", "description", "capabilities"],
          },
        },
      },
      required: ["rows"],
    },
  };
}

export interface UnifyCapabilitiesParsed {
  /** The capabilities this answer placed, each with its row. */
  assignments: Array<{ itemId: string; row: RowRef }>;
  /** What makes the answer unusable (the step fails the run and saves nothing): a code outside the closed sets, a new row with no name. */
  problems: string[];
  /** Capability codes the answer used more than once: the first place stays. */
  twice: string[];
  /** Capability codes of the call the answer left out: asked again. */
  missing: string[];
}

/**
 * The answer of a call of kind A.
 *   - `row` is a code of ROWS SO FAR, or "new" (or empty) with a name. Any other row code → a problem. A new row
 *     with no name → a problem. A new row whose normalized name is that of a row that exists — or of an earlier new
 *     row of this answer — IS that row: decided in code.
 *   - A capability code that was not given → a problem. A code used twice keeps its first row.
 */
export function parseUnifyCapabilities(value: unknown, entries: UnifyCapability[], rows: UnifyRow[]): UnifyCapabilitiesParsed {
  const byCode = new Map(entries.map((e) => [e.code, e]));
  const given = new Map(rows.map((r) => [r.code, { name: r.name, description: r.description }]));
  const byKey = new Map<string, RowRef>(rows.map((r) => [r.key, { name: r.name, description: r.description }]));
  const problems: string[] = [];
  const twice: string[] = [];
  const assignments: UnifyCapabilitiesParsed["assignments"] = [];
  const used = new Set<string>();
  for (const r of arr((value as Record<string, unknown> | null)?.rows)) {
    const o = (r ?? {}) as Record<string, unknown>;
    const rowCode = typeof o.row === "string" ? o.row.trim() : "";
    let row: RowRef | undefined = given.get(rowCode);
    if (!row) {
      if (rowCode && rowCode.toLowerCase() !== NEW_ROW) {
        problems.push(`the row "${rowCode}" is neither a row that was given nor "${NEW_ROW}"`);
        continue;
      }
      const name = clean(str(o.name, 80));
      const key = rowKey(name);
      if (!key) {
        problems.push("a new row has no name");
        continue;
      }
      row = byKey.get(key);
      if (!row) {
        row = { name, description: clean(str(o.description, 300)) };
        byKey.set(key, row);
      }
    }
    for (const c of arr(o.capabilities)) {
      const code = typeof c === "string" ? c.trim() : "";
      const item = byCode.get(code);
      if (!item) {
        problems.push(`the capability code "${code || "(none)"}" was not given`);
        continue;
      }
      if (used.has(code)) {
        if (!twice.includes(code)) twice.push(code);
        continue;
      }
      used.add(code);
      assignments.push({ itemId: item.id, row });
    }
  }
  return { assignments, problems, twice, missing: entries.filter((e) => !used.has(e.code)).map((e) => e.code) };
}

// ————— B. Review: rows made in different calls that are one capability —————

export function unifyReviewTool(rowCodes: string[]): Record<string, unknown> {
  return {
    name: "review_rows",
    description: "Record the groups of rows that are the same capability.",
    input_schema: {
      type: "object" as const,
      properties: {
        merge: {
          type: "array",
          items: {
            type: "object",
            properties: { rows: { type: "array", items: { type: "string", description: "A row code, e.g. R7.", ...(rowCodes.length <= MAX_ENUM ? { enum: rowCodes } : {}) } }, name: { type: "string", description: "The name the merged row keeps: the term the market uses." } },
            required: ["rows", "name"],
          },
        },
      },
      required: ["merge"],
    },
  };
}

/** One line per row: code, name, description, then what each company calls it. */
export function renderUnifyReview(orgName: string, rows: UnifyRow[]): string {
  const lines = rows.map((r) => {
    const byCompany = new Map<string, { label: string; names: string[] }>();
    for (const m of r.members) {
      const c = byCompany.get(m.competitorId) ?? { label: who(m), names: [] };
      if (!c.names.includes(m.name)) c.names.push(m.name);
      byCompany.set(m.competitorId, c);
    }
    const behind = [...byCompany.values()].map((c) => `${c.label}: ${c.names.map((n) => `"${short(n, 80)}"`).join(", ")}`).join("; ");
    return `${r.code} | ${short(r.name, 80)} — ${short(r.description, 240) || "(no description)"} | ${behind}`;
  });
  return `THE ORGANIZATION: ${short(orgName, 80)}\n\nROWS:\n${lines.join("\n")}`;
}

/**
 * The answer of the review, as row keys. A code that was not given → a problem (the answer is unusable). A row in
 * two groups stays in the first. A group left with fewer than two rows is no merge.
 */
export function parseUnifyReview(value: unknown, rows: UnifyRow[]): { merges: Array<{ keys: string[]; name: string }>; problems: string[] } {
  const byCode = new Map(rows.map((r, n) => [r.code, { key: r.key, n }]));
  const problems: string[] = [];
  const merged = new Set<string>();
  const merges: Array<{ keys: string[]; name: string }> = [];
  for (const g of arr((value as Record<string, unknown> | null)?.merge)) {
    const go = (g ?? {}) as Record<string, unknown>;
    const members: Array<{ key: string; n: number }> = [];
    for (const m of arr(go.rows)) {
      const code = typeof m === "string" ? m.trim() : "";
      const row = byCode.get(code);
      if (!row) {
        problems.push(`the row code "${code || "(none)"}" was not given`);
        continue;
      }
      if (merged.has(row.key) || members.some((x) => x.key === row.key)) continue;
      members.push(row);
    }
    if (members.length < 2) continue;
    members.sort((a, b) => a.n - b.n);
    for (const m of members) merged.add(m.key);
    merges.push({ keys: members.map((m) => m.key), name: clean(str(go.name, 80)) });
  }
  return { merges, problems };
}

/**
 * What the merged rows become — by the row's key before the review; rows the review does not touch are not in the
 * result. A group keeps its first row (table order): that row's description, and the group's name when one was
 * given. When the name a group takes is the normalized name of another row, the two are one row too: the earlier
 * of them in the table stays. So the result never holds two rows with one name.
 */
export function planUnifyReview(merges: Array<{ keys: string[]; name: string }>, rows: UnifyRow[]): Map<string, RowRef> {
  const index = new Map(rows.map((r, n) => [r.key, n]));
  const parent = rows.map((_, n) => n);
  const find = (n: number): number => (parent[n] === n ? n : (parent[n] = find(parent[n])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const wanted = new Map<number, string>();
  for (const g of merges) {
    const members = g.keys.filter((k) => index.has(k)).map((k) => index.get(k)!);
    if (members.length < 2) continue;
    for (const m of members.slice(1)) union(members[0], m);
    if (rowKey(g.name)) wanted.set(Math.min(...members), g.name);
  }
  const nameOf = (root: number): string => wanted.get(root) ?? rows[root].name;
  for (let changed = true; changed; ) {
    changed = false;
    const byName = new Map<string, number>();
    for (let n = 0; n < rows.length; n++) {
      if (find(n) !== n) continue;
      const key = rowKey(nameOf(n));
      const other = byName.get(key);
      if (other === undefined) byName.set(key, n);
      else {
        union(other, n);
        changed = true;
      }
    }
  }
  const out = new Map<string, RowRef>();
  for (let n = 0; n < rows.length; n++) {
    const root = find(n);
    const name = nameOf(root);
    if (root !== n || name !== rows[n].name) out.set(rows[n].key, { name, description: rows[root].description });
  }
  return out;
}

// ————— C. Features → feature rows —————

/** A feature row a row already has, as a call shows it. */
export interface FeatureRowRef {
  /** "R3.F2" — its row's code and its place among the row's feature rows. */
  code: string;
  key: string;
  name: string;
  description: string;
}

/** One row of a call of kind C: the feature rows it has so far and the features to place under it. */
export interface UnifyFeatureGroup {
  row: UnifyRow;
  featureRows: FeatureRowRef[];
  entries: UnifyFeature[];
}

/** The feature rows a row has so far, from the features placed on it — in the fixed order of the features; a feature row is identified by its normalized name. */
export function featureRowsOf(row: UnifyRow, placed: UnifyFeature[]): FeatureRowRef[] {
  const out = new Map<string, FeatureRowRef>();
  for (const f of placed) {
    if (!f.placed || rowKey(f.placed.row) !== row.key) continue;
    const key = wordingKey(f.placed.name);
    if (!key || out.has(key)) continue;
    out.set(key, { code: `${row.code}.F${out.size + 1}`, key, name: f.placed.name, description: f.placed.description });
  }
  return [...out.values()];
}

export function renderUnifyFeatures(orgName: string, allRows: UnifyRow[], groups: UnifyFeatureGroup[], opts: { allRowsShown: boolean }): string {
  const all = allRows.map((r) => `${r.code} | ${short(r.name, 80)} — ${short(r.description, 200) || "(no description)"}`);
  const blocks = groups.map((g) => {
    const so = g.featureRows.map((f) => `  ${f.code} | ${short(f.name, 80)} — ${short(f.description, 200) || "(no description)"}`);
    const entries = g.entries.map((e) => `  ${e.code} | ${who(e)} | ${short(e.name, 80)} — ${short(e.description, 300) || "(its pages do not say what it does)"}`);
    return [`ROW ${g.row.code} | ${short(g.row.name, 80)} — ${short(g.row.description, 240) || "(no description)"}`, ...(so.length ? [" FEATURE ROWS IT HAS:", ...so] : []), " FEATURES TO PLACE:", ...entries].join("\n");
  });
  return `THE ORGANIZATION: ${short(orgName, 80)}\n\n${opts.allRowsShown ? `ALL ROWS:\n${all.join("\n")}\n\n` : ""}ROWS TO FILL:\n\n${blocks.join("\n\n")}`;
}

export function unifyFeaturesTool(featureCodes: string[], batchRowCodes: string[], otherRowCodes: string[], allowMove: boolean): Record<string, unknown> {
  const closed = (values: string[]) => (values.length && values.length <= MAX_ENUM ? { enum: values } : {});
  const feature = { type: "string", ...closed(featureCodes) };
  return {
    name: "build_feature_rows",
    description: allowMove ? "The feature rows under each row, and the features that belong to a row that is not filled here." : "The feature rows under each row.",
    input_schema: {
      type: "object" as const,
      properties: {
        feature_rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              row: { type: "string", description: "The code of the row it is under: one of the ROWS TO FILL.", ...closed(batchRowCodes) },
              feature_row: { type: "string", description: `The code of a feature row the row already has (e.g. R3.F2), or "${NEW_ROW}" for one this answer makes.` },
              name: { type: "string", description: "For a new feature row: the term the market uses for the feature, at most 80 characters. Empty for one that exists." },
              description: { type: "string", description: "For a new feature row: one plain sentence saying what it does. Empty for one that exists." },
              features: { type: "array", items: feature },
            },
            required: ["row", "feature_row", "name", "description", "features"],
          },
        },
        ...(allowMove
          ? { moved: { type: "array", description: "Features that clearly belong to a row that is not one of the ROWS TO FILL.", items: { type: "object", properties: { feature, row: { type: "string", description: "The code of the row it belongs to (one of ALL ROWS, not one of the ROWS TO FILL).", ...closed(otherRowCodes) } }, required: ["feature", "row"] } } }
          : {}),
      },
      required: allowMove ? ["feature_rows", "moved"] : ["feature_rows"],
    },
  };
}

export interface UnifyFeaturesParsed {
  /** The features this answer placed: the row (by key) and the feature row. */
  placements: Array<{ itemId: string; rowKey: string; row: RowRef; feature: RowRef }>;
  /** The features this answer handed to a row that is not in the call. */
  moves: Array<{ itemId: string; row: RowRef }>;
  problems: string[];
  twice: string[];
  missing: string[];
}

/**
 * The answer of a call of kind C.
 *   - `row` must be one of the rows of the call → else a problem.
 *   - `feature_row` is the code of a feature row that row has, or "new" (or empty) with a name. A code that is not
 *     one of that row's feature rows → a problem; a new feature row with no name → a problem. A new feature row
 *     whose normalized name is that of one the row has — or of an earlier new one under the same row — IS that one.
 *   - A feature code that was not given → a problem. A code used twice (in feature rows, in "moved", or both) keeps
 *     its first place.
 *   - "moved" counts only when moving is allowed, and only to a row of the table that is NOT in the call: a move to
 *     a row of the call, or when moving is not allowed, places nothing (the feature is asked again); a row code
 *     that is no row of the table → a problem.
 */
export function parseUnifyFeatures(value: unknown, groups: UnifyFeatureGroup[], allRows: UnifyRow[], allowMove: boolean): UnifyFeaturesParsed {
  const o = (value ?? {}) as Record<string, unknown>;
  const entries = groups.flatMap((g) => g.entries);
  const byCode = new Map(entries.map((e) => [e.code, e]));
  const groupOf = new Map(groups.map((g) => [g.row.code, g]));
  const tableRow = new Map(allRows.map((r) => [r.code, r]));
  /** Feature rows per row of the call, by normalized name — the ones it has and the ones this answer makes. */
  const featureRows = new Map<string, Map<string, RowRef>>(groups.map((g) => [g.row.code, new Map(g.featureRows.map((f) => [f.key, { name: f.name, description: f.description }]))]));
  const problems: string[] = [];
  const twice: string[] = [];
  const used = new Set<string>();
  const placements: UnifyFeaturesParsed["placements"] = [];
  const moves: UnifyFeaturesParsed["moves"] = [];
  const take = (code: string): UnifyFeature | null => {
    const item = byCode.get(code);
    if (!item) {
      problems.push(`the feature code "${code || "(none)"}" was not given`);
      return null;
    }
    if (used.has(code)) {
      if (!twice.includes(code)) twice.push(code);
      return null;
    }
    used.add(code);
    return item;
  };
  for (const r of arr(o.feature_rows)) {
    const ro = (r ?? {}) as Record<string, unknown>;
    const rowCode = typeof ro.row === "string" ? ro.row.trim() : "";
    const group = groupOf.get(rowCode);
    if (!group) {
      problems.push(`the row "${rowCode || "(none)"}" is not one of the rows to fill`);
      continue;
    }
    const known = featureRows.get(rowCode)!;
    const frCode = typeof ro.feature_row === "string" ? ro.feature_row.trim() : "";
    let featureRow: RowRef | undefined;
    const existing = group.featureRows.find((f) => f.code === frCode);
    if (existing) {
      featureRow = known.get(existing.key);
    } else {
      if (frCode && frCode.toLowerCase() !== NEW_ROW) {
        problems.push(`the feature row "${frCode}" is neither a feature row of ${rowCode} nor "${NEW_ROW}"`);
        continue;
      }
      const name = clean(str(ro.name, 80));
      const key = wordingKey(name);
      if (!key) {
        problems.push(`a new feature row under ${rowCode} has no name`);
        continue;
      }
      featureRow = known.get(key);
      if (!featureRow) {
        featureRow = { name, description: clean(str(ro.description, 300)) };
        known.set(key, featureRow);
      }
    }
    if (!featureRow) continue;
    for (const c of arr(ro.features)) {
      const item = take(typeof c === "string" ? c.trim() : "");
      if (item) placements.push({ itemId: item.id, rowKey: group.row.key, row: { name: group.row.name, description: group.row.description }, feature: featureRow });
    }
  }
  for (const m of arr(o.moved)) {
    const mo = (m ?? {}) as Record<string, unknown>;
    const code = typeof mo.feature === "string" ? mo.feature.trim() : "";
    const rowCode = typeof mo.row === "string" ? mo.row.trim() : "";
    const target = tableRow.get(rowCode);
    if (!target) {
      problems.push(`feature ${code || "(none)"} was moved to "${rowCode || "(none)"}", which is no row of the table`);
      continue;
    }
    // Not allowed, or to a row of this very call (it should have been placed there): nothing is placed — the feature is asked again.
    if (!allowMove || groupOf.has(rowCode)) {
      if (!byCode.has(code)) problems.push(`the feature code "${code || "(none)"}" was not given`);
      continue;
    }
    const item = take(code);
    if (item) moves.push({ itemId: item.id, row: { name: target.name, description: target.description } });
  }
  return { placements, moves, problems, twice, missing: entries.filter((e) => !used.has(e.code)).map((e) => e.code) };
}

// ————— The exactly-once check —————

export interface UnifyCheck {
  /** Capabilities with no row. */
  capabilitiesUnplaced: string[];
  /** Features with no feature row. */
  featuresUnplaced: string[];
  /** Features on a feature row whose row does not exist. */
  featuresOnNoRow: string[];
}

/**
 * Is every capability on exactly one row and every feature on exactly one feature row of a row that exists? An
 * item carries one place, so "twice" cannot be stored; what can go wrong is an item with none, or a feature whose
 * row is gone. All three lists empty = the table can be built.
 */
export function checkUnified(capabilities: UnifyCapability[], features: UnifyFeature[]): UnifyCheck {
  const rows = new Set(rowsOf(capabilities).map((r) => r.key));
  return {
    capabilitiesUnplaced: capabilities.filter((c) => !c.row || !rowKey(c.row.name)).map((c) => c.code),
    featuresUnplaced: features.filter((f) => !f.placed).map((f) => f.code),
    featuresOnNoRow: features.filter((f) => f.placed && !rows.has(rowKey(f.placed.row))).map((f) => f.code),
  };
}
