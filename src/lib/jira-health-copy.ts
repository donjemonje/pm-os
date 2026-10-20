/**
 * Customer-facing Jira connection copy. Plain constants with no server
 * imports so client components can use them too.
 *
 * Since 2026-10-20 customers never connect, reconnect or disconnect Jira
 * themselves: the connection is a PM-OS user + API token that only PM-OS
 * support (Admin → Ideas) can set or replace. So every message here says
 * what is affected and whom to contact — never "reconnect", never a scope
 * name or an HTTP status.
 */

export const SUPPORT_EMAIL = "support@pm-os.io";

export type JiraHealthStatus = "not_connected" | "ok" | "unavailable" | "not_configured";

export const JIRA_UNAVAILABLE_MESSAGE =
  `Jira is temporarily unavailable — imports will not match tickets against your Jira backlog and Sync to Jira is paused. ` +
  `PM-OS support has been notified; contact ${SUPPORT_EMAIL} if this persists.`;

export const JIRA_NOT_CONNECTED_MESSAGE =
  `Jira is not connected for your organization — Contact ${SUPPORT_EMAIL}.`;

export const JIRA_NOT_CONFIGURED_MESSAGE =
  `The Jira project for ideas is not set for your organization — contact ${SUPPORT_EMAIL}.`;

/** Short form for sync blockers (shown inside the merge dialog). */
export const JIRA_SYNC_UNAVAILABLE_BLOCKER =
  `Jira is temporarily unavailable — Sync to Jira is paused. Contact ${SUPPORT_EMAIL}.`;
export const JIRA_SYNC_NOT_CONNECTED_BLOCKER =
  `Jira is not connected for your organization — contact ${SUPPORT_EMAIL}.`;

/** The banner / dialog text for a non-ok status; null when everything is fine. */
export function jiraHealthMessage(status: JiraHealthStatus): string | null {
  switch (status) {
    case "not_connected":
      return JIRA_NOT_CONNECTED_MESSAGE;
    case "unavailable":
      return JIRA_UNAVAILABLE_MESSAGE;
    case "not_configured":
      return JIRA_NOT_CONFIGURED_MESSAGE;
    default:
      return null;
  }
}

export function jiraHealthTitle(status: JiraHealthStatus): string {
  switch (status) {
    case "not_connected":
      return "Jira is not connected";
    case "not_configured":
      return "Jira project is not set";
    default:
      return "Jira is unavailable";
  }
}
