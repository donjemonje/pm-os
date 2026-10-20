export type IdeaBatchStatus = "new" | "updated" | "unchanged" | "archive" | "deleted";
export type IdeaDecision = "pending" | "reviewed" | "injected";

/** Catalog stage: what a raw Zendesk ticket is. Only FRs become ideas. */
export type CatalogKind = "fr" | "bug" | "needs_details" | "ops_task" | "question";

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
  /** Names a PM dismissed from the idea view — kept so the dismissal is reversible. */
  dismissedCustomers?: string[];
  tags: string[];
  createdAt?: string;
  /** Optional product_line column, used to pre-assign the idea's product. */
  productLine?: string;
  /** Reporter-chosen module — a hint to PMOS AI, never an override. */
  module?: string;
  /** Customer named in a dedicated column — truth; auto-added to the catalog. */
  customerName?: string;
  /** The reporter marked the ticket as affecting all customers. */
  affectsAllCustomers?: boolean;
  /** Reporter's "why should we build this" — interpretation. */
  whyBuild?: string;
  /** Reporter's "what insights do we have" — interpretation. */
  insights?: string;
  /** Deal linkage as reported (Yes / No / Helpful …). */
  dealRelated?: string;
  /** Customer / POC. */
  customerType?: string;
  /** Direct link to the source ticket. */
  url?: string;
  /** Catalog verdict; Bug / Needs-details tickets are parked with the label. */
  catalog?: CatalogVerdict | null;
  /** The CSV row exactly as received; sent on import, persisted in the raw store. */
  raw?: Record<string, string>;
  /** What the match stage decided per FR unit of this ticket. */
  matchNotes?: MatchNote[];
}

/** One FR unit's outcome in the match stage, kept on the ticket for the PM. */
export interface MatchNote {
  /** "<ticket>" or "<ticket>#n" for a split sub-idea. */
  unit: string;
  /** The idea this unit ended up in (created or merged into). */
  ideaId: string;
  merged: boolean;
  reason: string;
}

/** A Jira idea pulled at its live state on import. */
export interface JiraSource {
  /** Issue key, e.g. "RL-13" — also the dedupe key. */
  key: string;
  id: string;
  title: string;
  body: string;
  status?: string;
  issueType?: string;
  priority?: string;
  reporter?: string;
  assignee?: string;
  /** ISO timestamp of the issue's creation in Jira. */
  createdAt?: string;
  /** Browse URL on the connected Jira site. */
  url?: string;
  /** Product lines: the mapped field (Kela: Module) or Components. */
  products: string[];
  /** Customers read from the issue text (customer-mentions.ts); catalog names + as-written suggestions. */
  customers?: string[];
  /** Jira labels (customer labels among them when the org maps customers to labels). */
  labels?: string[];
  /** Raw customer label values: the custom labels field's values, or the
   *  prefixed system labels — whichever the org maps. */
  customerLabels?: string[];
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
  /** Customers the supporting tickets say are affected — union over sources, minus dismissed. */
  customers?: string[];
  /** Any supporting ticket was marked as affecting all customers. */
  affectsAllCustomers?: boolean;
  /** Dismissed suggestions, restorable from the drawer. */
  dismissedCustomers?: string[];
  /** Customers a PM added by hand (subset of `customers`); removing one deletes it, not a dismissal. */
  addedCustomers?: string[];
  batch: IdeaBatchStatus;
  /** The description before this batch / the PM's changes (the idea's
   *  baseline), when it differs from the current one — the drawer's undo
   *  opens the editor on it. */
  previousDetails?: string;
  decision: IdeaDecision;
  /** Set while this idea's write from the LAST merge is still undoable. */
  undoable?: { action: "create" | "update"; jiraKey: string };
  /** A PM changed the sources after PMOS AI wrote the text: approval waits
   *  for a rewrite or an explicit "keep the text". */
  sourcesChanged?: boolean;
  /** Where this idea came from: a Zendesk import, Jira, or a PM who wrote it from scratch. */
  origin: "zendesk" | "jira" | "manual";
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
