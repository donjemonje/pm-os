export type IdeaBatchStatus = "new" | "updated" | "unchanged" | "archive" | "deleted";
export type IdeaDecision = "pending" | "reviewed" | "injected";

/** Catalog stage: what a raw Zendesk ticket is. Only FRs become ideas. */
export type CatalogKind = "fr" | "bug" | "needs_details";

export interface CatalogVerdict {
  kind: CatalogKind;
  reason: string;
}

export interface ZendeskTicket {
  /** Stable dedupe key — external_id when present, else subject+created. */
  key: string;
  /** Display id, e.g. "pmos-seed-zd-021" or a numeric Zendesk id. */
  id: string;
  subject: string;
  body: string;
  requester?: string;
  /** Customers the catalog stage matched in the ticket text; names come from the settings catalog. */
  affectedCustomers?: string[];
  tags: string[];
  createdAt?: string;
  /** Optional product_line column, used to pre-assign the idea's product. */
  productLine?: string;
  /** Catalog verdict; Bug / Needs-details tickets are parked with the label. */
  catalog?: CatalogVerdict | null;
  /** The CSV row exactly as received; sent on import, persisted in the raw store. */
  raw?: Record<string, string>;
}

/** A Jira idea pulled at its live state on import. */
export interface JiraSource {
  /** Issue key, e.g. "RL-13" — also the dedupe key. */
  key: string;
  id: string;
  title: string;
  body: string;
  status?: string;
  /** Browse URL on the connected Jira site. */
  url?: string;
  /** Product lines derived from Jira components. */
  products: string[];
}

export interface Idea {
  id: string;
  title: string;
  details: string;
  products: string[];
  /** Platform tags (iOS, Web, …) assigned by the catalog stage; names come from the settings catalog. */
  platforms?: string[];
  /** Who filed the supporting tickets — derived from sources, never stored on the idea. */
  reporters?: string[];
  /** Customers the supporting tickets say are affected — union over sources. */
  customers?: string[];
  batch: IdeaBatchStatus;
  decision: IdeaDecision;
  /** Where this idea came from this batch. */
  origin: "zendesk" | "jira";
  /** Computed score — null until the scoring pipeline exists. */
  pmScore: number | null;
  /** PM-entered override; when set it IS the displayed score. */
  manual: number | null;
  existingVotes: number;
  newVotes: number;
  /** Keys of supporting Zendesk tickets. */
  zen: string[];
  /** Keys of supporting Jira ideas. */
  jira: string[];
}

/** In-flight source reassignment on the Merge page. */
export interface MergeEdit {
  ideaId: string;
  zen: string[];
  jira: string[];
}
