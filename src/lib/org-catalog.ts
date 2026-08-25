import { db } from "./db";
import { fetchEpicsForProjects, listJiraProjects } from "./jira";
import { listGoogleDriveFiles } from "./google-drive";
import { parseJsonArray } from "./utils";

export interface OrgCatalog {
  jiraConnected: boolean;
  driveConnected: boolean;
  /** Compact plain-text map of the org's projects, epics and docs for prompts. */
  text: string;
}

const CATALOG_TTL_MS = Number(process.env.ORG_CATALOG_TTL_MS ?? 10 * 60 * 1000);
const MAX_PROJECTS = 10;
const MAX_EPICS = 60;
const MAX_DRIVE_DOCS = 50;

const catalogCache = new Map<string, { expiresAt: number; value: OrgCatalog }>();

async function buildJiraLines(
  workspaceId: string
): Promise<{ connected: boolean; lines: string[] }> {
  const connection = await db.jiraConnection.findUnique({ where: { workspaceId } });
  if (!connection) return { connected: false, lines: [] };

  const projects = await listJiraProjects(workspaceId);
  const selectedKeys = parseJsonArray(connection.projectKeys);
  const scoped = (
    selectedKeys.length > 0
      ? projects.filter((p) => selectedKeys.includes(p.key))
      : projects
  ).slice(0, MAX_PROJECTS);
  if (scoped.length === 0) return { connected: true, lines: ["Jira: no projects visible."] };

  const epicsByProject = new Map<string, string[]>();
  try {
    const epics = await fetchEpicsForProjects(
      workspaceId,
      scoped.map((p) => p.key),
      MAX_EPICS
    );
    for (const epic of epics) {
      const projectKey = epic.key.split("-")[0];
      const list = epicsByProject.get(projectKey) ?? [];
      list.push(`[${epic.key}] ${epic.summary.slice(0, 80)}`);
      epicsByProject.set(projectKey, list);
    }
  } catch {
    // Epics enrich the catalog but the project list alone is still useful.
  }

  const lines = ["Jira projects (project key: name, then epics):"];
  for (const project of scoped) {
    lines.push(`- ${project.key}: ${project.name}`);
    for (const epicLine of epicsByProject.get(project.key) ?? []) {
      lines.push(`  - ${epicLine}`);
    }
  }
  return { connected: true, lines };
}

async function buildDriveLines(
  workspaceId: string
): Promise<{ connected: boolean; lines: string[] }> {
  const connection = await db.googleDriveConnection.findUnique({ where: { workspaceId } });
  if (!connection) return { connected: false, lines: [] };

  const files = await listGoogleDriveFiles(workspaceId);
  if (files.length === 0) {
    return { connected: true, lines: ["Google Drive: connected, no docs found in scoped folders."] };
  }

  const lines = ["Google Drive docs (most recently modified first):"];
  for (const file of files.slice(0, MAX_DRIVE_DOCS)) {
    lines.push(`- "${file.name.slice(0, 100)}" (id: ${file.id})`);
  }
  return { connected: true, lines };
}

/**
 * A small, cached map of what exists in the org's connected sources. It is the
 * vocabulary the router uses to resolve informal names ("the coffee epic") to
 * exact keys and ids — a couple of KB, never full content.
 */
export async function getOrgCatalog(workspaceId: string): Promise<OrgCatalog> {
  const cached = catalogCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const [jira, drive] = await Promise.all([
    buildJiraLines(workspaceId).catch(
      () => ({ connected: true, lines: ["Jira: temporarily unavailable."] })
    ),
    buildDriveLines(workspaceId).catch(
      () => ({ connected: true, lines: ["Google Drive: temporarily unavailable."] })
    ),
  ]);

  const sections = [jira.lines.join("\n"), drive.lines.join("\n")].filter(Boolean);
  const catalog: OrgCatalog = {
    jiraConnected: jira.connected,
    driveConnected: drive.connected,
    text: sections.length > 0 ? sections.join("\n\n") : "No data sources connected.",
  };

  catalogCache.set(workspaceId, {
    expiresAt: Date.now() + CATALOG_TTL_MS,
    value: catalog,
  });
  return catalog;
}

export function invalidateOrgCatalog(workspaceId: string) {
  catalogCache.delete(workspaceId);
}
