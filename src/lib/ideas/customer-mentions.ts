import { createHash } from "crypto";
import { isAllCustomers } from "./customer-key";

/**
 * Customers named inside a Jira issue's text. PMs often write the customer
 * into the description instead of the Customers field (Daniel, 2026-10-19),
 * so every pull reads the summary + description the way the catalog stage
 * reads a Zendesk ticket — in two tiers of confidence:
 *
 * 1. Catalog names (deterministic, high confidence): a catalog customer's
 *    name or alias found whole in the text. Multi-word names match
 *    case-insensitively; a single-word name must match its exact casing so
 *    "Vital" never fires on "vital" in prose. Hits are confirmed customers.
 * 2. Other names (AI, lower confidence, jira-customers.ts): what the model
 *    reads that is not in the catalog, returned as written. These render as
 *    suggestions with approve / dismiss, never as confirmed chips. Runs only
 *    for issues whose text changed since the last pull (customersTextHash),
 *    and never blocks an import — a failed call leaves tier 1 in place.
 *
 * This module is dependency-free on purpose (testable without Vertex).
 */

export interface CatalogCustomer {
  name: string;
  aliases?: string[] | null;
}

const MIN_NAME_LENGTH = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tier 1: catalog customers named whole in the text, catalog spelling returned. */
export function findCatalogCustomers(text: string, catalog: CatalogCustomer[]): string[] {
  if (!text.trim()) return [];
  const hits: string[] = [];
  for (const c of catalog) {
    if (isAllCustomers(c.name)) continue;
    const spellings = [c.name, ...(c.aliases ?? [])].map((s) => s.trim()).filter(Boolean);
    const found = spellings.some((s) => {
      if (s.length < MIN_NAME_LENGTH) return false;
      const multiWord = /\s/.test(s);
      // Word boundary on both sides; \b fails next to punctuation-only names,
      // so a lookaround on "not a word char" is used instead.
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(s)}(?![\\p{L}\\p{N}])`, multiWord ? "iu" : "u");
      return re.test(text);
    });
    if (found && !hits.includes(c.name)) hits.push(c.name);
  }
  return hits;
}

/** The text the extraction reads for an issue — one place, so the hash is stable. */
export function issueCustomerText(title: string, body: string): string {
  return `${title}\n\n${body}`.trim();
}

export const JIRA_CUSTOMERS_PROMPT_VERSION = "jira-customers-v1";

export function customersTextHash(text: string): string {
  return createHash("sha1").update(`${JIRA_CUSTOMERS_PROMPT_VERSION}\n${text}`).digest("hex");
}
