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

const COLUMN_ALIASES: Record<string, string[]> = {
  id: ["external_id", "external id", "id", "ticket_id", "ticket id"],
  subject: ["subject", "title", "summary"],
  body: ["description", "body", "text"],
  requester: ["requester_name", "requester name", "requester", "submitter"],
  requesterEmail: ["requester_email", "requester email", "email"],
  tags: ["tags"],
  created: ["created_at", "created at", "created", "date"],
  product: ["product_line", "product line", "product", "products"],
};

export interface CsvImportResult {
  tickets: ZendeskTicket[];
  /** Rows dropped for having neither subject nor description. */
  skipped: number;
  errors: string[];
}

export function ticketsFromCsv(text: string): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { tickets: [], skipped: 0, errors: ["CSV has no data rows."] };
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: keyof typeof COLUMN_ALIASES): number =>
    header.findIndex((h) => COLUMN_ALIASES[name].includes(h));

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
  const iCreated = col("created");
  const iProduct = col("product");

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
    tickets.push(ticket);
  }
  return { tickets, skipped, errors: [] };
}
