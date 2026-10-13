/**
 * Zendesk ticket references inside Jira text. A PM who pastes a ticket link
 * into an issue has already matched them — PM-OS treats that as a near-
 * certain link (Daniel, 2026-10-13): the ticket's request is forced onto that
 * issue's idea instead of being judged by the match model, and a ticket that
 * is not a feature request (needs details, bug, question) is still attached
 * as evidence.
 *
 * Recognized: any Zendesk agent/ticket URL (".../agent/tickets/3436",
 * ".../tickets/3436", ".../requests/3436"). Plain numbers are not — too
 * many issue numbers, versions and counts look like ticket ids.
 */
const ZENDESK_TICKET_URL = /zendesk\.com\/(?:agent\/)?(?:tickets|requests)\/(\d+)/gi;

export function extractZendeskTicketIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of (text ?? "").matchAll(ZENDESK_TICKET_URL)) ids.add(m[1]);
  return Array.from(ids);
}

/** ticket id → issue keys whose text cites it (in input order). */
export function citationsByTicket(
  issues: { key: string; body: string }[]
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const issue of issues) {
    for (const id of extractZendeskTicketIds(issue.body)) {
      const list = out.get(id) ?? [];
      if (!list.includes(issue.key)) list.push(issue.key);
      out.set(id, list);
    }
  }
  return out;
}
