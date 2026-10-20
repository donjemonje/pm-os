import { db } from "./db";
import { sendEmail } from "./mailer";
import { renderBrandedEmail } from "./email-templates";
import { envFeatureDefault, resolveFeature } from "./feature-flags";
import { mergeIdeasJiraConfig } from "./ideas/jira-mapping";

/**
 * Health alerts to PM-OS support. Rule (Daniel, 2026-10-20): Jira enabled
 * for an organization means it must work — any non-ok health (no
 * connection row, project not set, dead or legacy token, Jira unreachable)
 * emails support once per incident. The customer cannot fix any of it, so
 * the person who can gets the mail. Deduped through Workspace.jiraAlertedAt
 * (cleared when a check passes again). A second signal, the API token
 * expiring within EXPIRY_WARN_DAYS, is deduped on
 * JiraConnection.expiryWarnedAt (cleared when a new token is saved).
 * Never throws: an alert failure must not break the page or import that
 * ran the health check. Recipient: JIRA_ALERT_EMAIL (default
 * support@pm-os.io; "off" disables sends entirely).
 */

const EXPIRY_WARN_DAYS = 14;
const DEFAULT_RECIPIENT = "support@pm-os.io";

type AlertRow = {
  id: string;
  siteUrl: string;
  connectedByEmail: string | null;
  apiTokenExpiresAt: Date | null;
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

async function sendOutageAlert(org: string, site: string | null, cause: string) {
  const to = recipient();
  if (!to) return;
  const { html, text } = renderBrandedEmail({
    preheader: `Jira not working for ${org}`,
    heading: `Jira not working for ${org}`,
    paragraphs: [
      `Jira is enabled for ${org}${site ? ` (${site})` : ""} but PM-OS cannot use it.`,
      `Cause: ${cause}`,
      `Members see "contact support"; imports run without Jira matching and Sync to Jira is paused until this is fixed in Admin → Ideas.`,
    ],
    cta: { label: "Open Admin → Ideas", url: adminUrl() },
    note: "Sent once per incident. A passing health check resets it.",
  });
  await sendEmail({ to, subject: `[PM-OS] Jira not working for ${org}`, text, html });
}

async function sendExpiryWarning(org: string, row: AlertRow, expiresAt: Date) {
  const to = recipient();
  if (!to) return;
  const day = expiresAt.toISOString().slice(0, 10);
  const { html, text } = renderBrandedEmail({
    preheader: `Jira token for ${org} expires ${day}`,
    heading: `Jira token for ${org} expires ${day}`,
    paragraphs: [
      `The PM-OS user's API token for ${org} (${row.siteUrl}${row.connectedByEmail ? `, ${row.connectedByEmail}` : ""}) expires on ${day}.`,
      `Create a new token as that user (id.atlassian.com → Security → API tokens) and paste it in Admin → Ideas → Connection before then — otherwise Jira stops working for the organization on that day.`,
    ],
    cta: { label: "Open Admin → Ideas", url: adminUrl() },
  });
  await sendEmail({ to, subject: `[PM-OS] Jira token for ${org} expires ${day}`, text, html });
}

/**
 * Called by getJiraHealth after every uncached check. Flags are written
 * before the send so two concurrent checks cannot double-email.
 */
export async function recordJiraHealth(
  workspaceId: string,
  health: HealthForAlerts,
  row: AlertRow | null
): Promise<void> {
  try {
    const ws = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        jiraAlertedAt: true,
        ideasConfig: true,
        organization: { select: { name: true, features: true } },
      },
    });
    if (!ws) return;
    const org = ws.organization?.name ?? "an organization";
    // Jira off for the org = nothing is expected to work; nothing to alert.
    if (!resolveFeature(ws.organization?.features, "jira", envFeatureDefault("jira"))) return;

    const cause =
      health.status === "not_connected"
        ? "No Jira connection is set for the organization (Admin → Ideas → Connection)."
        : health.status === "unavailable"
          ? (health.cause ?? "The health check failed.")
          : !mergeIdeasJiraConfig(ws.ideasConfig).jiraProject
            ? "The Jira project for ideas is not set (Admin → Ideas → Jira project)."
            : null;

    if (cause) {
      if (ws.jiraAlertedAt) return;
      await db.workspace.update({ where: { id: workspaceId }, data: { jiraAlertedAt: new Date() } });
      await sendOutageAlert(org, row?.siteUrl ?? null, cause);
      return;
    }

    if (ws.jiraAlertedAt) {
      await db.workspace.update({ where: { id: workspaceId }, data: { jiraAlertedAt: null } });
    }
    const expiresAt = row?.apiTokenExpiresAt;
    if (
      row &&
      expiresAt &&
      !row.expiryWarnedAt &&
      expiresAt.getTime() - Date.now() <= EXPIRY_WARN_DAYS * 86_400_000
    ) {
      await db.jiraConnection.update({ where: { id: row.id }, data: { expiryWarnedAt: new Date() } });
      await sendExpiryWarning(org, row, expiresAt);
    }
  } catch (err) {
    console.error("[jira-alerts] failed:", err instanceof Error ? err.message : err);
  }
}
