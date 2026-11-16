import { arr, str } from "../ai";
import { checkPii } from "../pii";
import { wordingKey } from "./items";

/** Closed sets up to this size ride in the response schema as an enum; larger ones are enforced by the parser only. */
const MAX_ENUM = 120;

/**
 * BUILD THE DOMAINS — step 4 of the setup run (Capability Analysis, "The setup run"; the database side is
 * analysis/setup.ts).
 *
 * Domains used to be typed in before anything was known. Now they are built from the rows: ONE step over all rows
 * (name, description, which companies have it, some of its features) plus the client's own language — its product
 * lines and the wording of its own items. The client's language weighs heavily but is not the truth. The output is the domains (a name
 * in market terms, a one-sentence definition) and the domain of every row: every row gets exactly one domain.
 * There is no limit on the number of domains and no target. There is no "No Domain" bucket: a row that fits no
 * domain gets a domain of its own.
 *
 * Closed sets only: the model answers with the row codes it was given and with domain codes — those given (a
 * follow-up call) or those it declares in the same answer. Any other code, a row put in two domains, or a new
 * domain without a name makes the answer unusable: nothing of it is used and the run fails.
 *
 * The order of the result is fixed in code: domains by their first row, rows inside a domain in the order of the
 * rows (which is the fixed order of the items: the organization's own first).
 *
 * Pure: no database, no network.
 */

/** Bumping it invalidates nothing: the catalog a setup run made is the PM's to edit. */
export const DOMAINS_VERSION = "domains-2";
/**
 * Rows per domains call. Up to this many rows the step is ONE call over all rows; a longer list goes in
 * consecutive calls, each given the domains made so far. An answer line is two codes: 800 rows are about 10,000
 * visible output tokens.
 */
export const DOMAINS_MAX_ROWS = 800;
export const DOMAINS_MAX_TOKENS = 24_000;
/** Own wordings shown behind a row. */
export const DOMAINS_OWN_WORDINGS = 3;
/** Feature rows named behind a row, as a hint of what it covers. */
export const DOMAINS_ROW_FEATURES = 12;

export const DOMAINS_SYSTEM_PROMPT = `You organize the rows of a comparison table of one market into domains. Each row is one capability; the table compares an organization with its competitors, like an analyst's report on the market.

What domains are for:
1. They make a long table readable: a reader finds a capability by its area.
2. They answer "where are we ahead and where are we behind" per area: a domain is an area a product team can be strong or weak in.
3. They speak the market's language: the names a buyer or an analyst uses for the areas of this market.
A domain organizes and summarizes. It is not evidence, and it is not a product.

You get the organization's own language — its product lines (how it divides what it sells), and what it calls the capabilities it has — and every row with its code, its name, its description, the companies that offer it and some of its features. The organization's language weighs heavily: when the organization and the market divide the field the same way, use that division. It is not the truth: when the market names or divides an area differently, follow the market.

Answer with:
- domains: every domain you create — a code (D1, D2 …), its name and a one-sentence definition saying what belongs in it.
- rows: for every row code, the code of the one domain it belongs in.

Rules:
- Every row gets exactly one domain. Answer once for every row code. Use only the row codes given.
- Use only the domain codes listed under DOMAINS SO FAR (when there are any) and the codes of the domains you create in this answer. A new domain takes a code that is not in use.
- Name a domain in market terms: short, title case, vendor-neutral — never a product, brand or marketing name, and never the name of a company.
- A domain is an area, not a single capability and not everything: do not make one domain for the whole table, and do not make a domain that only repeats the name of one row. A row that truly belongs to no other domain may have a domain of its own.
- There is no limit on the number of domains and no number to aim for: make as many as the market has areas.
- There is no "other" or "miscellaneous" domain: do not make one catch-all domain for what is left.`;

export function domainsTool(rowCodes: string[]): Record<string, unknown> {
  return {
    name: "build_domains",
    description: "Record the domains and the domain of every row.",
    input_schema: {
      type: "object" as const,
      properties: {
        domains: {
          type: "array",
          description: "The domains this answer creates.",
          items: {
            type: "object",
            properties: {
              code: { type: "string", description: "D1, D2 … — a code that is not in use." },
              name: { type: "string", description: "The domain's name in market terms, at most 60 characters." },
              definition: { type: "string", description: "One sentence: what belongs in this domain." },
            },
            required: ["code", "name", "definition"],
          },
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              row: { type: "string", ...(rowCodes.length <= MAX_ENUM ? { enum: rowCodes } : {}) },
              domain: { type: "string", description: "The code of the row's domain: one listed under DOMAINS SO FAR, or one created in this answer." },
            },
            required: ["row", "domain"],
          },
        },
      },
      required: ["domains", "rows"],
    },
  };
}

/** A row of the table as the domains step sees it. */
export interface DomainsRow {
  /** "R1" … in table order. */
  code: string;
  /** What identifies the row: its normalized name. */
  key: string;
  name: string;
  description: string;
  /** The companies that have the row (their own capability on it, or any feature under it), in the fixed order. */
  companies: Array<{ name: string; isOwn: boolean }>;
  /** What the organization itself calls it (its own capabilities on the row). */
  ownNames: string[];
  /** The names of its feature rows. */
  features: string[];
  /** The organization has it: the own cell starts as found. */
  ours: boolean;
}

/** A domain in the making: identified by `key` (its normalized name). */
export interface DomainDraft {
  key: string;
  name: string;
  definition: string;
}

/** A domain made by an earlier call of the step, with the code this call shows it under. */
export interface KnownDomain extends DomainDraft {
  code: string;
}

export function domainKey(name: string): string {
  return wordingKey(name);
}

/** The domains made so far with their codes for the next call: D1 … in the order they were made. */
export function knownDomains(drafts: DomainDraft[]): KnownDomain[] {
  return drafts.map((d, n) => ({ ...d, code: `D${n + 1}` }));
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s).replace(/\s+/g, " ").replace(/\|/g, "/").trim();

export interface DomainsProductLine {
  name: string;
  description: string;
}

/**
 * The user content of a domains call: the organization, its product lines, the domains made so far (a follow-up
 * call only), and the rows — code, name, description, the companies that offer it (the organization marked), and
 * what the organization itself calls it.
 */
export function renderDomains(orgName: string, productLines: DomainsProductLine[], known: KnownDomain[], rows: DomainsRow[]): string {
  const lines = productLines.filter((p) => p.name.trim()).map((p) => `- ${short(p.name, 80)}${p.description.trim() ? ` — ${short(p.description, 400)}` : ""}`);
  const rowLines = rows.map((r) => {
    const companies = [...new Set(r.companies.map((c) => `${short(c.name, 40)}${c.isOwn ? " (the organization itself)" : ""}`))];
    const ours = r.ownNames.length ? ` | the organization calls it: ${[...new Set(r.ownNames)].slice(0, DOMAINS_OWN_WORDINGS).map((n) => `"${short(n, 80)}"`).join(", ")}` : "";
    const features = r.features.length ? ` | features: ${r.features.slice(0, DOMAINS_ROW_FEATURES).map((f) => short(f, 60)).join("; ")}${r.features.length > DOMAINS_ROW_FEATURES ? `; +${r.features.length - DOMAINS_ROW_FEATURES}` : ""}` : "";
    return `${r.code} | ${short(r.name, 80)} | ${short(r.description, 200) || "(no description)"} | offered by: ${companies.join(", ")}${ours}${features}`;
  });
  const soFar = known.length ? `\n\nDOMAINS SO FAR:\n${known.map((d) => `${d.code} | ${short(d.name, 60)} | ${short(d.definition, 300)}`).join("\n")}` : "";
  return `THE ORGANIZATION: ${short(orgName, 80)}\n\nITS PRODUCT LINES:\n${lines.length ? lines.join("\n") : "none given"}${soFar}\n\nROWS:\n${rowLines.join("\n")}`;
}

const clean = (text: string): string => (checkPii(text).hit ? "" : text);

export interface DomainsParsed {
  /** Row key → domain key, for the rows this answer placed. */
  assigned: Map<string, string>;
  /** The domains this answer created and used, in the order of the answer. */
  created: DomainDraft[];
  /** What makes the answer unusable (the step fails the run): codes outside the closed sets, a row in two domains, a new domain with no name. */
  problems: string[];
  /** Rows of the call the answer left out, as row keys (the step asks them again). */
  missing: string[];
}

/**
 * The answer of one domains call.
 *   - A new domain needs a code that is not in use and a name; a new domain whose normalized name is that of a
 *     domain that exists (or of an earlier new one) IS that domain. Anything else → a problem.
 *   - A row code that was not given → a problem. A domain code that is neither given nor created in this answer →
 *     a problem. A row put in two different domains → a problem (every row has exactly one). The same answer
 *     twice for a row is one answer.
 *   - A created domain no row was put in is dropped.
 */
export function parseDomains(value: unknown, rows: Array<Pick<DomainsRow, "code" | "key">>, known: KnownDomain[]): DomainsParsed {
  const o = (value ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const byRowCode = new Map(rows.map((r) => [r.code, r.key]));
  const byCode = new Map<string, DomainDraft>(known.map((d) => [d.code, { key: d.key, name: d.name, definition: d.definition }]));
  const byKey = new Map<string, DomainDraft>(known.map((d) => [d.key, { key: d.key, name: d.name, definition: d.definition }]));
  const fresh: DomainDraft[] = [];
  for (const d of arr(o.domains)) {
    const dobj = (d ?? {}) as Record<string, unknown>;
    const code = typeof dobj.code === "string" ? dobj.code.trim() : "";
    // The prompt asks for D1, D2 …; what the answer must hold is weaker and checkable: a code of its own, not one in use.
    if (!code) {
      problems.push("a new domain has no code");
      continue;
    }
    if (byCode.has(code)) {
      problems.push(`the domain code ${code} is already in use`);
      continue;
    }
    const name = clean(str(dobj.name, 60));
    const key = domainKey(name);
    if (!key) {
      problems.push(`the new domain ${code} has no name`);
      continue;
    }
    let draft = byKey.get(key);
    if (!draft) {
      draft = { key, name, definition: clean(str(dobj.definition, 300)) };
      byKey.set(key, draft);
      fresh.push(draft);
    }
    byCode.set(code, draft);
  }
  const assigned = new Map<string, string>();
  for (const r of arr(o.rows)) {
    const ro = (r ?? {}) as Record<string, unknown>;
    const rowCode = typeof ro.row === "string" ? ro.row.trim() : "";
    const key = byRowCode.get(rowCode);
    if (!key) {
      problems.push(`the row code "${rowCode || "(none)"}" was not given`);
      continue;
    }
    const domainCode = typeof ro.domain === "string" ? ro.domain.trim() : "";
    const domain = byCode.get(domainCode);
    if (!domain) {
      problems.push(`row ${rowCode} was put in the domain "${domainCode || "(none)"}", which is neither a domain that was given nor one created in this answer`);
      continue;
    }
    const before = assigned.get(key);
    if (before !== undefined && before !== domain.key) {
      problems.push(`row ${rowCode} was put in two domains — every row has exactly one`);
      continue;
    }
    assigned.set(key, domain.key);
  }
  const used = new Set(assigned.values());
  return { assigned, created: fresh.filter((d) => used.has(d.key)), problems, missing: rows.filter((r) => !assigned.has(r.key)).map((r) => r.key) };
}

export interface CatalogDomain<T> extends DomainDraft {
  position: number;
  rows: Array<{ row: T; position: number }>;
}

/**
 * The catalog a setup run creates, in its stable order: the domains by their first row, the rows of a domain in
 * the order of the rows; capability positions count through the whole table in that order. Throws when a row has
 * no domain or names a domain that does not exist — the step never creates a catalog with a row left out.
 */
export function planCatalog<T extends { key: string; name: string }>(rows: T[], assigned: Map<string, string>, domains: DomainDraft[]): CatalogDomain<T>[] {
  const byKey = new Map(domains.map((d) => [d.key, d]));
  const out = new Map<string, CatalogDomain<T>>();
  for (const row of rows) {
    const key = assigned.get(row.key);
    const draft = key === undefined ? undefined : byKey.get(key);
    if (!draft) throw new Error(`the row "${row.name}" has no domain`);
    const domain = out.get(draft.key) ?? { ...draft, position: out.size, rows: [] };
    domain.rows.push({ row, position: 0 });
    out.set(draft.key, domain);
  }
  let position = 0;
  const list = [...out.values()];
  for (const d of list) for (const r of d.rows) r.position = position++;
  return list;
}

/** Is every row in exactly one domain? `assigned` holds one domain per row by construction (parseDomains refuses a second); what is left to check is a row with none. */
export function rowsWithoutDomain(rows: Array<{ key: string }>, assigned: ReadonlyMap<string, string>): string[] {
  return rows.filter((r) => !assigned.has(r.key)).map((r) => r.key);
}
