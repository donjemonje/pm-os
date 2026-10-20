import { db } from "./db";
import { sendEmail } from "./mailer";
import { renderBrandedEmail } from "./email-templates";

/**
 * Health alerts to PM-OS support — the customer cannot fix a dead Jira
 * connection (only PM-OS holds the PM-OS user's token), so the person who
 * can gets an email instead. Two signals, each sent once per incident and
 * deduped through JiraConnection columns (healthAlertedAt / expiryWarnedAt):
 *   - the health probe failed → "Jira unavailable for <org>";
 *   - the API token expires within EXPIRY_WARN_DAYS → "token expires soon".
 * Never throws: an alert failure must not break the page or import that
 * ran the health check. Recipient: JIRA_ALERT_EMAIL (default
 * support@pm-os.io; "off" disables sends entirely).
 */

const EXPIRY_WARN_DAYS = 14;
const DEFAULT_RECIPIENT = "support@pm-os.io";

type AlertRow = {
  id: string;
  workspaceId: string;
  siteUrl: string;
  connectedByEmail: string | null;
  apiTokenExpiresAt: Date | null;
  healthAlertedAt: Date | null;
  expiryWarnedAt: Date | null;
};

type HealthForAlerts = { status: "ok" | "unavailable" | "not_connected"; cause?: string };

function recipient(): string | null {
  const raw = process.env.JIRA_ALERT_EMAIL?.trim();
  if (raw?.toLowerCase() === "off") return null;
  return raw || DEFAULT_RECIPIENT;
}

function adminUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  return `${base || "https://app.pm-os.io"}/admin/ideas`;
}

async function orgName(workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organization: { select: { name: true } } },
  });
  return ws?.organization?.name ?? "an organization";
}

async function sendOutageAlert(row: AlertRow, cause: string) {
  const to = recipient();
  if (!to) return;
  const org = await orgName(row.workspaceId);
  const { html, text } = renderBrandedEmail({
    preheader: `Jira unavailable for ${org}`,
    heading: `Jira unavailable for ${org}`,
    paragraphs: [
      `PM-OS can no longer reach Jira for ${org} (${row.siteUrl}) with the PM-OS user${row.connectedByEmail ? ` ${row.connectedByEmail}` : ""}.`,
      `Cause: ${cause}`,
      `Members see "Jira is temporarily unavailable"; imports run without Jira matching and Sync to Jira is paused until a working token is saved in Admin → Ideas → Connection.`,
    ],
    cta: { label: "Open Admin → Ideas", url: adminUrl() },
    note: "Sent once per incident. A passing health check resets it.",
  });
  await sendEmail({ to, subject: `[PM-OS] Jira unavailable for ${org}`, text, html });
}

async function sendExpiryWarning(row: AlertRow, expiresAt: Date) {
  const to = recipient();
  if (!to) return;
  const org = await orgName(row.workspaceId);
  const day = expiresAt.toISOString().slice(0, 10);
  const { html, text } = renderBrandedEmail({
    preheader: `Jira token for ${org} expires ${day}`,
    heading: `Jira token for ${org} expires ${day}`,
    paragraphs: [
      `The PM-OS user's API token for ${org} (${row.siteUrl}) expires on ${day}.`,
      `Create a new token as that user (id.atlassian.com → Security → API tokens) and paste it in Admin → Ideas → Connection before then — otherwise Jira goes unavailable for the organization on that day.`,
    ],
    cta: { label: "Open Admin → Ideas", url: adminUrl() },
  });
  await sendEmail({ to, subject: `[PM-OS] Jira token for ${org} expires ${day}`, text, html });
}

/**
 * Called by getJiraHealth with the row it loaded and the result. Flags are
 * written before the send so two concurrent checks cannot double-email.
 */
export async function recordJiraHealth(row: AlertRow, health: HealthForAlerts): Promise<void> {
  try {
    if (health.status === "unavailable") {
      if (row.healthAlertedAt) return;
      await db.jiraConnection.update({ where: { id: row.id }, data: { healthAlertedAt: new Date() } });
      await sendOutageAlert(row, health.cause ?? "unknown");
      return;
    }
    if (health.status !== "ok") return;
    if (row.healthAlertedAt) {
      await db.jiraConnection.update({ where: { id: row.id }, data: { healthAlertedAt: null } });
    }
    const expiresAt = row.apiTokenExpiresAt;
    if (
      expiresAt &&
      !row.expiryWarnedAt &&
      expiresAt.getTime() - Date.now() <= EXPIRY_WARN_DAYS * 86_400_000
    ) {
      await db.jiraConnection.update({ where: { id: row.id }, data: { expiryWarnedAt: new Date() } });
      await sendExpiryWarning(row, expiresAt);
    }
  } catch (err) {
    console.error("[jira-alerts] failed:", err instanceof Error ? err.message : err);
  }
}
