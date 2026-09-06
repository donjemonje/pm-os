import { type CsvMapping, DEFAULT_CSV_MAPPING } from "./csv-mapping";
import type { ZendeskTicket } from "./types";

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();

  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export interface CsvImportResult {
  tickets: ZendeskTicket[];
  /** Rows dropped for having neither subject nor description. */
  skipped: number;
  errors: string[];
}

export function ticketsFromCsv(
  text: string,
  mapping: CsvMapping = DEFAULT_CSV_MAPPING
): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { tickets: [], skipped: 0, errors: ["CSV has no data rows."] };
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: keyof CsvMapping): number =>
    header.findIndex((h) => mapping[name].includes(h));

  const iId = col("id");
  const iSubject = col("subject");
  const iBody = col("body");
  if (iSubject === -1 && iBody === -1) {
    return {
      tickets: [],
      skipped: 0,
      errors: [
        "Couldn't find a subject or description column. Expected Zendesk export headers like: external_id, subject, description.",
      ],
    };
  }
  // Cataloging needs ticket bodies — a subject-only file (e.g. a Zendesk
  // ticket-VIEW export, which omits descriptions) must fail loudly, not be
  // classified on subjects alone.
  if (iBody === -1) {
    return {
      tickets: [],
      skipped: 0,
      errors: [
        "No description column found — this looks like a Zendesk view export, which omits ticket bodies. Export tickets with their descriptions (or use the seed corpus CSV).",
      ],
    };
  }
  const iRequester = col("requester");
  const iEmail = col("requesterEmail");
  const iTags = col("tags");
  const iCustomers = col("customers");
  const iCreated = col("created");
  const iProduct = col("product");
  const iModule = col("module");
  const iCustomerName = col("customerName");
  const iWhyBuild = col("whyBuild");
  const iInsights = col("insights");
  const iDealRelated = col("dealRelated");
  const iCustomerType = col("customerType");
  const iUrl = col("url");

  const cell = (r: string[], i: number) => (i >= 0 && r[i] != null ? r[i].trim() : "");
  const originalHeader = rows[0].map((h) => h.trim());

  const tickets: ZendeskTicket[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const subject = cell(r, iSubject);
    const body = cell(r, iBody);
    if (!subject && !body) {
      skipped++;
      continue;
    }
    // The row exactly as received — persisted verbatim into the raw store.
    const raw: Record<string, string> = {};
    originalHeader.forEach((h, i) => {
      raw[h || `col${i}`] = r[i] ?? "";
    });
    const id = cell(r, iId);
    const created = cell(r, iCreated);
    const ticket: ZendeskTicket = {
      key: id || `${subject}|${created}`,
      id: id || "—",
      subject: subject || body.slice(0, 80),
      body,
      requester: cell(r, iRequester) || cell(r, iEmail) || undefined,
      tags: cell(r, iTags).split(/[\s,;]+/).filter(Boolean),
      createdAt: created || undefined,
      raw,
    };
    const product = cell(r, iProduct);
    if (product) ticket.productLine = product;
    const module_ = cell(r, iModule);
    if (module_) ticket.module = module_;
    const customerName = cell(r, iCustomerName);
    if (customerName) ticket.customerName = customerName;
    const whyBuild = cell(r, iWhyBuild);
    if (whyBuild) ticket.whyBuild = whyBuild;
    const insights = cell(r, iInsights);
    if (insights) ticket.insights = insights;
    const dealRelated = cell(r, iDealRelated);
    if (dealRelated) ticket.dealRelated = dealRelated;
    const customerType = cell(r, iCustomerType);
    if (customerType) ticket.customerType = customerType;
    const url = cell(r, iUrl);
    if (url) ticket.url = url;
    // The dedicated Zendesk field is one signal among several — it's not
    // always filled in, so text extraction runs regardless. Names contain
    // spaces, so split only on list separators.
    // Customer Name is truth and lists like "A, B / C" appear in the wild —
    // split both columns on list separators, then merge deduped.
    const customers = [...customerName.split(/[,;/]+/), ...cell(r, iCustomers).split(/[,;/]+/)]
      .map((c) => c.trim())
      .filter(Boolean)
      .filter((c, i, all) => all.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i);
    if (customers.length > 0) ticket.affectedCustomers = customers;
    tickets.push(ticket);
  }
  return { tickets, skipped, errors: [] };
}
