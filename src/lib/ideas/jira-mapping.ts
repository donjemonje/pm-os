import {
  type CsvMapping,
  DEFAULT_CSV_MAPPING,
  mergeCsvMapping,
} from "./csv-mapping";
/**
 * Ideas → Jira output configuration. Everything about HOW review results
 * land in the customer's Jira (field names, write policies, description
 * format, ticket links, the update comment) is data, not code — it changes
 * per customer and often, so PM-OS staff edit it in Admin → Ideas. Stored
 * per workspace in Workspace.ideasConfig, merged over these defaults.
 */

export type FieldPolicy =
  /** Read on import only (shown on the raw Jira issue); never written. */
  | "read"
  /** Single-select: write only when the field is empty; never replace a
   *  value a human chose. */
  | "set_if_empty"
  /** Number: current value + this batch's delta. */
  | "increment"
  /** Multi-select: union with what's there; add, never remove. */
  | "union";

export interface FieldMapping {
  /** Jira field name as shown in Jira (resolved to the field id at push time;
   *  for Product Line also at pull time — the pull reads this field as the
   *  issue's product line, Components when it is empty). */
  jiraField: string;
  type: "single_select" | "number" | "multi_select" | "text";
  policy: FieldPolicy;
  enabled: boolean;
  /** Select fields: when a value is not yet an option of the Jira field, add
   *  the option during the sync instead of skipping the value. Customer names
   *  arrive with every import, so a static option list can't work for them
   *  (Daniel, 2026-10-13). Needs the manage:jira-configuration scope. */
  createOptions?: boolean;
}

/** How the Jira backlog is read at import time. */
export interface JiraPullConfig {
  /** Safety ceiling per project (Jira pages at 100). The pull warns when it
   *  is reached instead of truncating silently. */
  maxIssues: number;
}

export interface IdeasJiraConfig {
  /**
   * The Jira description IS the PM-OS idea text plus the tickets list — one
   * rule, no modes (Daniel, 2026-10-12: the idea is where the merge of the
   * Jira text and the ticket evidence happens; the push just writes it).
   */
  descriptionMode: "overwrite";
  /** How the Jira backlog is pulled at import. */
  pull: JiraPullConfig;
  /** The Jira site the org works on ("https://d3east.atlassian.net"). On
   *  (re)connect the OAuth callback binds to THIS site from the account's
   *  accessible list — never "the first site", which for a PM with several
   *  Atlassian sites could be the wrong one. "" = first site (legacy). */
  jiraSiteUrl: string;
  /** The one Jira project this org manages its ideas in (Admin → Ideas →
   *  Jira; Kela: "PRDT"). Read on import, written on sync. "" = not set
   *  (falls back to the connection's own selection, e.g. QA seeds). */
  jiraProject: string;
  /** Work type new ideas are created as in that project ("" = not set →
   *  the connection's saved type, else the type the pulled issues share). */
  jiraIssueType: string;
  /** Blank lines between the details text and the tickets block. */
  descriptionGapLines: number;
  supportedTicketsHeading: string;
  /** "{id}" is replaced with the Zendesk ticket external id. Empty = plain
   *  text, no links. */
  zendeskTicketUrlTemplate: string;
  /** Add a Jira comment on every update push. */
  updateComment: boolean;
  commentPrefix: string;
  fields: {
    productLine: FieldMapping;
    votes: FieldMapping;
    customers: FieldMapping;
    platforms: FieldMapping;
    /** Read-only: which Jira field holds the reporter's name ("Reporter" =
     *  the system field; Kela's demo: "P_Reporter"). */
    reporter: FieldMapping;
    assignee: FieldMapping;
  };
  /** Per-org CSV import mapping (see csv-mapping.ts). */
  csv: CsvMapping;
  /** Sections PMOS AI writes for every idea (markdown ## headings + rules). */
  ideaTemplate: string;
  /** AI field parsing at import (Gemini). Default ON so production can never
   *  silently fall back to naive separator-splitting. */
  fieldParsing: { customers: boolean };
}

export const DEFAULT_IDEA_TEMPLATE = `## The Problem
The user problem and who it affects — the main stakeholders (customers and internal teams alike). The core of the idea; always present.

## Proposed Solution
Only when the source implies an implementation AND there is high confidence it is the right one — otherwise omit this section entirely. One to three sentences on the what, not the how. No lists, no asks, no cases, no context — those go to The Problem (asks) or Additional Info (cases, references).

## Additional Info
Other important related context. When the source describes a REAL case that actually happened (a specific incident or situation a customer hit), include a short summary — that is evidence for the need. Never carry over illustrative or hypothetical examples the reporter invented to explain the ask ("for example, if a score drops overnight…") — they are not evidence and add nothing. Every link, issue key, document or identifier from the source that fits nowhere else goes here verbatim. Omit this section when there is none.`;

export const DEFAULT_JIRA_PULL_CONFIG: JiraPullConfig = {
  maxIssues: 10_000,
};

/** Hard ceiling on the configurable per-project pull cap. */
export const JIRA_PULL_MAX_ISSUES = 10_000;

export const DEFAULT_IDEAS_JIRA_CONFIG: IdeasJiraConfig = {
  ideaTemplate: DEFAULT_IDEA_TEMPLATE,
  fieldParsing: { customers: true },
  csv: DEFAULT_CSV_MAPPING,
  descriptionMode: "overwrite",
  pull: DEFAULT_JIRA_PULL_CONFIG,
  jiraSiteUrl: "",
  jiraProject: "",
  jiraIssueType: "",
  descriptionGapLines: 2,
  supportedTicketsHeading: "Supported Tickets:",
  zendeskTicketUrlTemplate: "",
  updateComment: true,
  commentPrefix: "#update from @PM-OS, fields affected:",
  fields: {
    productLine: {
      jiraField: "Product Line",
      type: "single_select",
      policy: "set_if_empty",
      enabled: true,
    },
    // Jira's built-in "Votes" name was taken, hence P_Votes (same as P_Components).
    votes: {
      jiraField: "P_Votes",
      type: "number",
      policy: "increment",
      enabled: true,
    },
    customers: {
      jiraField: "Customers",
      type: "multi_select",
      policy: "union",
      enabled: true,
      createOptions: true,
    },
    // Jira's built-in "Components" name was taken, hence P_Components.
    // Off by default (Daniel, 2026-09-03): most Jira projects have no
    // P_Components field; an org turns it on in Admin → Ideas.
    platforms: {
      jiraField: "P_Components",
      type: "multi_select",
      policy: "union",
      enabled: false,
    },
    reporter: { jiraField: "Reporter", type: "text", policy: "read", enabled: true },
    assignee: { jiraField: "Assignee", type: "text", policy: "read", enabled: true },
  },
};

export type MappedAttribute = keyof IdeasJiraConfig["fields"];
export const MAPPED_ATTRIBUTES: MappedAttribute[] = [
  "productLine",
  "votes",
  "customers",
  "platforms",
  "reporter",
  "assignee",
];

/** Attributes a sync may write (read-only mappings excluded). */
export function writableAttributes(config: IdeasJiraConfig): MappedAttribute[] {
  return MAPPED_ATTRIBUTES.filter((a) => config.fields[a].enabled && config.fields[a].policy !== "read");
}

/** Stored overrides merged over defaults — unknown keys ignored, partial
 *  field entries completed from the default, so old configs never crash. */
export function mergeIdeasJiraConfig(raw: unknown): IdeasJiraConfig {
  const stored = (
    raw && typeof raw === "object" ? raw : {}
  ) as Partial<IdeasJiraConfig>;
  const csv = mergeCsvMapping(stored.csv);
  const ideaTemplate =
    typeof stored.ideaTemplate === "string" && stored.ideaTemplate.trim()
      ? stored.ideaTemplate
      : DEFAULT_IDEA_TEMPLATE;
  const storedParsing = (stored.fieldParsing ?? {}) as Partial<{
    customers: boolean;
  }>;
  const fieldParsing = {
    customers:
      typeof storedParsing.customers === "boolean"
        ? storedParsing.customers
        : true,
  };
  const fields = { ...DEFAULT_IDEAS_JIRA_CONFIG.fields };
  const storedFields = (stored.fields ?? {}) as Partial<
    IdeasJiraConfig["fields"]
  >;
  for (const attr of MAPPED_ATTRIBUTES) {
    const f = storedFields[attr];
    if (f && typeof f === "object") {
      fields[attr] = { ...DEFAULT_IDEAS_JIRA_CONFIG.fields[attr], ...f };
    }
  }
  const storedPull = (
    stored.pull && typeof stored.pull === "object" ? stored.pull : {}
  ) as Partial<JiraPullConfig>;
  const pull: JiraPullConfig = {
    maxIssues:
      typeof storedPull.maxIssues === "number" &&
      Number.isFinite(storedPull.maxIssues) &&
      storedPull.maxIssues >= 1
        ? Math.min(Math.floor(storedPull.maxIssues), JIRA_PULL_MAX_ISSUES)
        : DEFAULT_JIRA_PULL_CONFIG.maxIssues,
  };
  const legacy = (stored as { jiraProjects?: unknown }).jiraProjects;
  const rawProject =
    typeof stored.jiraProject === "string"
      ? stored.jiraProject
      : Array.isArray(legacy) && typeof legacy[0] === "string"
        ? legacy[0]
        : "";
  const jiraProject = /^[A-Z][A-Z0-9_]{0,19}$/.test(rawProject.trim().toUpperCase())
    ? rawProject.trim().toUpperCase()
    : "";
  const jiraIssueType =
    typeof stored.jiraIssueType === "string" ? stored.jiraIssueType.trim().slice(0, 60) : "";
  const rawSite = typeof stored.jiraSiteUrl === "string" ? stored.jiraSiteUrl.trim() : "";
  const jiraSiteUrl = /^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(rawSite.replace(/\/+$/, ""))
    ? rawSite.replace(/\/+$/, "").toLowerCase()
    : "";
  return {
    csv,
    ideaTemplate,
    fieldParsing,
    descriptionMode: "overwrite",
    pull,
    jiraSiteUrl,
    jiraProject,
    jiraIssueType,
    descriptionGapLines:
      typeof stored.descriptionGapLines === "number" &&
      stored.descriptionGapLines >= 0
        ? stored.descriptionGapLines
        : DEFAULT_IDEAS_JIRA_CONFIG.descriptionGapLines,
    supportedTicketsHeading:
      typeof stored.supportedTicketsHeading === "string" &&
      stored.supportedTicketsHeading
        ? stored.supportedTicketsHeading
        : DEFAULT_IDEAS_JIRA_CONFIG.supportedTicketsHeading,
    zendeskTicketUrlTemplate:
      typeof stored.zendeskTicketUrlTemplate === "string"
        ? stored.zendeskTicketUrlTemplate
        : DEFAULT_IDEAS_JIRA_CONFIG.zendeskTicketUrlTemplate,
    updateComment:
      typeof stored.updateComment === "boolean"
        ? stored.updateComment
        : DEFAULT_IDEAS_JIRA_CONFIG.updateComment,
    commentPrefix:
      typeof stored.commentPrefix === "string" && stored.commentPrefix
        ? stored.commentPrefix
        : DEFAULT_IDEAS_JIRA_CONFIG.commentPrefix,
    fields,
  };
}

/** Human names for the update comment / preview ("fields affected" bullets). */
export const ATTRIBUTE_LABELS: Record<string, string> = {
  summary: "Summary",
  description: "Description",
  productLine: "Product Line",
  votes: "Votes",
  customers: "Customers",
  platforms: "Components",
  reporter: "Reporter",
  assignee: "Assignee",
};
