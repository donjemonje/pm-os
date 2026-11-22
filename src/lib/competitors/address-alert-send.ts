/**
 * Sends the internal alert of an undecided address search (rules and text: address-alert.ts) the way the app's other
 * internal alerts go out: to PM-OS support (jira-alerts.ts alertRecipient — JIRA_ALERT_EMAIL, default
 * support@pm-os.io, "off" sends nothing), as a branded email through the mailer.
 * Never throws: an alert that cannot be sent is logged and the search goes on. Answers whether the email went out.
 */
import { db } from "../db";
import { renderBrandedEmail } from "../email-templates";
import { alertRecipient } from "../jira-alerts";
import { sendEmail } from "../mailer";
import { recordCompetitorEvent } from "./analytics";
import { undecidedAlertEmail } from "./address-alert";

export async function sendUndecidedAlert(o: { workspaceId: string; competitorId: string; company: string; website: string; candidates: ReadonlyArray<{ url: string; via?: string | null }>; note: string }): Promise<boolean> {
  try {
    const to = alertRecipient();
    if (!to) {
      console.log(`[competitors] address search of ${o.company} ended undecided — alerts are switched off, no email sent`);
      return false;
    }
    const workspace = await db.workspace.findUnique({ where: { id: o.workspaceId }, select: { organization: { select: { name: true } } } });
    const mail = undecidedAlertEmail({ organization: workspace?.organization?.name ?? "unknown organization", company: o.company, website: o.website, candidates: o.candidates, note: o.note });
    const { html, text } = renderBrandedEmail({ preheader: mail.heading, heading: mail.heading, paragraphs: mail.paragraphs, note: mail.note });
    await sendEmail({ to, subject: mail.subject, text, html });
    console.log(`[competitors] address search of ${o.company} ended undecided (${o.candidates.length} candidates) — alert sent to PM-OS`);
    await recordCompetitorEvent(o.workspaceId, null, "cmp_address_search_alerted", { competitorId: o.competitorId, candidates: o.candidates.length });
    return true;
  } catch (e) {
    console.error("[competitors] the alert of an undecided address search could not be sent", o.competitorId, e);
    return false;
  }
}
