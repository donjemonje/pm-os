/**
 * Ideas → Jira output configuration. Everything about HOW review results
 * land in the customer's Jira (field names, write policies, description
 * format, ticket links, the update comment) is data, not code — it changes
 * per customer and often, so PM-OS staff edit it in Admin → Ideas. Stored
 * per workspace in Workspace.ideasConfig, merged over these defaults.
 */

export type FieldPolicy =
  /** Single-select: write only when the field is empty; never replace a
   *  value a human chose. */
  | "set_if_empty"
  /** Number: current value + this batch's delta. */
  | "increment"
  /** Multi-select: union with what's there; add, never remove. */
  | "union";

export interface FieldMapping {
  /** Jira field name as shown in Jira (resolved to the field id at push time). */
  jiraField: string;
  type: "single_select" | "number" | "multi_select";
  policy: FieldPolicy;
  enabled: boolean;
}

export interface IdeasJiraConfig {
  /** "overwrite": replace the Jira description with PM-OS details + ticket
   *  list. This is the customer's chosen semantics (2026-09-01). */
  descriptionMode: "overwrite";
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
  };
}

export const DEFAULT_IDEAS_JIRA_CONFIG: IdeasJiraConfig = {
  descriptionMode: "overwrite",
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
    votes: { jiraField: "P_Votes", type: "number", policy: "increment", enabled: true },
    customers: { jiraField: "Customers", type: "multi_select", policy: "union", enabled: true },
    // Jira's built-in "Components" name was taken, hence P_Components.
    platforms: {
      jiraField: "P_Components",
      type: "multi_select",
      policy: "union",
      enabled: true,
    },
  },
};

export type MappedAttribute = keyof IdeasJiraConfig["fields"];
export const MAPPED_ATTRIBUTES: MappedAttribute[] = [
  "productLine",
  "votes",
  "customers",
  "platforms",
];

/** Stored overrides merged over defaults — unknown keys ignored, partial
 *  field entries completed from the default, so old configs never crash. */
export function mergeIdeasJiraConfig(raw: unknown): IdeasJiraConfig {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<IdeasJiraConfig>;
  const fields = { ...DEFAULT_IDEAS_JIRA_CONFIG.fields };
  const storedFields = (stored.fields ?? {}) as Partial<IdeasJiraConfig["fields"]>;
  for (const attr of MAPPED_ATTRIBUTES) {
    const f = storedFields[attr];
    if (f && typeof f === "object") {
      fields[attr] = { ...DEFAULT_IDEAS_JIRA_CONFIG.fields[attr], ...f };
    }
  }
  return {
    descriptionMode: "overwrite",
    descriptionGapLines:
      typeof stored.descriptionGapLines === "number" && stored.descriptionGapLines >= 0
        ? stored.descriptionGapLines
        : DEFAULT_IDEAS_JIRA_CONFIG.descriptionGapLines,
    supportedTicketsHeading:
      typeof stored.supportedTicketsHeading === "string" && stored.supportedTicketsHeading
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
};
