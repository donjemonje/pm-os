/**
 * Per-organization CSV import mapping — which column header(s) feed each
 * PM-OS ticket param. Same pattern as the Jira field mapping: defaults here,
 * per-workspace overrides stored in Workspace.ideasConfig.csv and merged over
 * them, decided once when onboarding a client's export format.
 *
 * Matching is case-insensitive on trimmed headers; the first alias that hits
 * a column wins. An empty alias list turns the param off for that org.
 */

/** Every CSV-mappable ticket param, in the order the admin card lists them. */
export const CSV_PARAMS = [
  "id",
  "subject",
  "body",
  "requester",
  "requesterEmail",
  "tags",
  "created",
  "product",
  "module",
  "customerName",
  "customers",
  "whyBuild",
  "insights",
  "dealRelated",
  "customerType",
  "url",
] as const;
export type CsvParam = (typeof CSV_PARAMS)[number];

export type CsvMapping = Record<CsvParam, string[]>;

export interface CsvParamMeta {
  label: string;
  /** How the pipeline treats the value — shown in the admin card. */
  treatment: string;
  required?: boolean;
}

export const CSV_PARAM_META: Record<CsvParam, CsvParamMeta> = {
  id: { label: "Ticket id", treatment: "Dedupe key; falls back to subject+created.", required: true },
  subject: { label: "Subject", treatment: "Shown and sent to PMOS AI.", required: true },
  body: { label: "Description", treatment: "The ticket content PMOS AI classifies.", required: true },
  requester: { label: "Requester name", treatment: "Reporter attribution; never an affected customer." },
  requesterEmail: { label: "Requester email", treatment: "Fallback when the name column is empty." },
  tags: { label: "Tags", treatment: "Weak hints to PMOS AI." },
  created: { label: "Created at", treatment: "Recency; part of the fallback dedupe key." },
  product: { label: "Product line", treatment: "Pre-assigns the idea's product line when present." },
  module: {
    label: "Module",
    treatment: "Metadata hint to PMOS AI — humans make mistakes, so it never overrides the content.",
  },
  customerName: {
    label: "Customer name",
    treatment: "Truth: assigned to the idea and auto-added to the Customers catalog.",
  },
  customers: { label: "Affected customers", treatment: "List column; merged with Customer name." },
  whyBuild: {
    label: "Why build this",
    treatment: "Reporter interpretation — read with the same grain of salt as the ticket text.",
  },
  insights: {
    label: "Insights",
    treatment: "Reporter interpretation — same treatment as Why build this.",
  },
  dealRelated: { label: "Deal related", treatment: "Stored on the ticket (scoring input later)." },
  customerType: { label: "Customer type", treatment: "Stored on the ticket (scoring input later)." },
  url: { label: "Ticket URL", treatment: "Link to the source ticket; used for Jira export links." },
};

/** Works for the historic seed corpus AND Kela's anonymized export unchanged. */
export const DEFAULT_CSV_MAPPING: CsvMapping = {
  id: ["external_id", "external id", "id", "ticket_id", "ticket id"],
  subject: ["subject", "title", "summary"],
  body: ["description", "body", "text"],
  requester: ["requester_name", "requester name", "requester", "submitter"],
  requesterEmail: ["requester_email", "requester email", "email"],
  tags: ["tags"],
  created: ["created_at", "created at", "created", "date"],
  product: ["product_line", "product line", "products"],
  module: ["module"],
  customerName: ["customer name", "customer_name"],
  customers: ["affected_customers", "affected customers", "customers", "customer"],
  whyBuild: ["why should we build this?", "why should we build this", "why build this"],
  insights: ["what insights do we have?", "what insights do we have", "insights"],
  dealRelated: ["deal related", "deal_related"],
  customerType: ["customer type", "customer_type"],
  url: ["url", "ticket url", "link"],
};

function toAliasList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** Stored overrides merged over defaults; unknown params ignored, absent ones defaulted. */
export function mergeCsvMapping(raw: unknown): CsvMapping {
  const stored =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const mapping = { ...DEFAULT_CSV_MAPPING };
  for (const param of CSV_PARAMS) {
    const aliases = toAliasList(stored[param]);
    if (aliases !== null) mapping[param] = aliases;
  }
  return mapping;
}

/** Extracted values for one ticket's mapped params (id/subject/body excluded). */
export interface MappedTicketFields {
  requester?: string;
  productLine?: string;
  module?: string;
  customerName?: string;
  customers: string[];
  whyBuild?: string;
  insights?: string;
  dealRelated?: string;
  customerType?: string;
  url?: string;
  tags: string[];
  created?: string;
}

/**
 * Re-derive the mapped params from a persisted raw CSV row (header → value),
 * using the org's current mapping — powers "re-apply mapping" without a
 * re-upload.
 */
export function extractMappedFields(
  raw: Record<string, string>,
  mapping: CsvMapping
): MappedTicketFields {
  const byHeader = new Map(
    Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), (v ?? "").trim()])
  );
  const get = (param: CsvParam): string => {
    for (const alias of mapping[param]) {
      const v = byHeader.get(alias);
      if (v) return v;
    }
    return "";
  };
  const customerName = get("customerName");
  const customers = [...customerName.split(/[,;/]+/), ...get("customers").split(/[,;/]+/)]
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c, i, all) => all.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i);
  return {
    requester: get("requester") || get("requesterEmail") || undefined,
    productLine: get("product") || undefined,
    module: get("module") || undefined,
    customerName: customerName || undefined,
    customers,
    whyBuild: get("whyBuild") || undefined,
    insights: get("insights") || undefined,
    dealRelated: get("dealRelated") || undefined,
    customerType: get("customerType") || undefined,
    url: get("url") || undefined,
    tags: get("tags").split(/[\s,;]+/).filter(Boolean),
    created: get("created") || undefined,
  };
}
