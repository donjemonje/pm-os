/**
 * THE TABLE AS TEXT — the result of a setup run, or of any later run, for one organization, so it can be read in a
 * terminal or pasted into a chat (Daniel 2026-11-16: "a short explanation of the domains and capabilities" was
 * missing when a run was reviewed): the domains with their definitions → the capabilities with their descriptions
 * and a mark per company → the features with a mark per company.
 *
 * The scanner CLI prints it (`--table <workspaceId>`); the loader is in the CLI, this is the layout.
 *
 * Pure: no database, no network.
 */

/** A cell as the text shows it. */
export type TableMark = "found" | "low" | "not_found" | "none";

export const MARK_TEXT: Record<TableMark, string> = { found: "yes", low: "low", not_found: "no", none: "?" };
export const MARKS_LEGEND = `Marks: yes = found · low = found on weak pages only (low confidence) · no = not found · ? = no cell yet (not checked)`;

export interface TableRowText {
  name: string;
  description: string;
  /** One mark per company, in the order of `TableText.companies`. */
  marks: TableMark[];
}

export interface TableCapabilityText extends TableRowText {
  features: TableRowText[];
}

export interface TableDomainText {
  name: string;
  definition: string;
  capabilities: TableCapabilityText[];
}

export interface TableText {
  organization: string;
  /** The columns: the organization itself first (when it has an own site or own marks), then the competitors. */
  companies: Array<{ name: string; own: boolean }>;
  domains: TableDomainText[];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** A stored cell value as a mark; anything that is not a value is "none". */
export function markOf(value: string | null | undefined): TableMark {
  return value === "found" || value === "low" || value === "not_found" ? value : "none";
}

function marksLine(companies: TableText["companies"], marks: TableMark[]): string {
  return companies.map((c, i) => `${oneLine(c.name)}: ${MARK_TEXT[marks[i] ?? "none"]}`).join(" | ");
}

/** How many rows each company has (found or low), for the summary line. */
function countOf(table: TableText, at: number): { capabilities: number; features: number } {
  let capabilities = 0;
  let features = 0;
  const has = (m: TableMark | undefined) => m === "found" || m === "low";
  for (const d of table.domains) {
    for (const k of d.capabilities) {
      if (has(k.marks[at])) capabilities++;
      for (const f of k.features) if (has(f.marks[at])) features++;
    }
  }
  return { capabilities, features };
}

/**
 * The table as plain text:
 *
 *   TABLE of <organization> — 7 domains, 42 capabilities, 180 features
 *   Companies: Acme (the organization itself) 30 capabilities / 110 features · Other 21 / 60 · …
 *   Marks: …
 *
 *   ## Domain — its definition
 *
 *   Capability — its description
 *       Acme: yes | Other: no | …
 *       - Feature — its description
 *           Acme: yes | Other: low | …
 */
export function renderTable(table: TableText): string {
  const capabilities = table.domains.reduce((n, d) => n + d.capabilities.length, 0);
  const features = table.domains.reduce((n, d) => n + d.capabilities.reduce((m, k) => m + k.features.length, 0), 0);
  const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const lines: string[] = [
    `TABLE of ${oneLine(table.organization)} — ${s(table.domains.length, "domain")}, ${s(capabilities, "capability", "capabilities")}, ${s(features, "feature")}`,
    `Companies: ${table.companies.map((c, i) => { const n = countOf(table, i); return `${oneLine(c.name)}${c.own ? " (the organization itself)" : ""} ${n.capabilities} capabilities / ${n.features} features`; }).join(" · ") || "none"}`,
    MARKS_LEGEND,
  ];
  if (!table.domains.length) lines.push("", "The table is empty: this organization has no domain and no capability yet.");
  for (const d of table.domains) {
    lines.push("", `## ${oneLine(d.name)} — ${oneLine(d.definition) || "(no definition)"}`);
    for (const k of d.capabilities) {
      lines.push("", `${oneLine(k.name)} — ${oneLine(k.description) || "(no description)"}`, `    ${marksLine(table.companies, k.marks)}`);
      for (const f of k.features) {
        lines.push(`    - ${oneLine(f.name)} — ${oneLine(f.description) || "(no description)"}`, `        ${marksLine(table.companies, f.marks)}`);
      }
    }
  }
  return lines.join("\n");
}
