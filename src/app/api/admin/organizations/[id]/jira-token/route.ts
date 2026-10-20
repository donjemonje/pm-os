import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";
import { basicAuthToken, invalidateJiraHealth, sealToken, validateBasicCredentials } from "@/lib/jira";

/**
 * Dedicated PM-OS user + Atlassian API token for an organization (option A,
 * Daniel 2026-10-20): a constant connection that always acts as "PM-OS".
 * POST { email, token, expiresAt? } validates against the org's Jira site
 * (Admin → Ideas → Jira site), then replaces the workspace connection with
 * authType "basic"; the token is sealed at rest. DELETE removes it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  let body: { email?: unknown; token?: unknown; expiresAt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const expiresAt =
    typeof body.expiresAt === "string" && body.expiresAt.trim() ? new Date(body.expiresAt) : null;
  if (!email || !token) return NextResponse.json({ error: "Email and API token are required" }, { status: 400 });
  if (expiresAt && Number.isNaN(expiresAt.getTime()))
    return NextResponse.json({ error: "Expiry date is not a date" }, { status: 400 });

  const workspace = await db.workspace.findUnique({
    where: { organizationId: id },
    select: { id: true, ideasConfig: true, jiraConnection: { select: { id: true } } },
  });
  if (!workspace) return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });
  const cfg = mergeIdeasJiraConfig(workspace.ideasConfig);
  if (!cfg.jiraSiteUrl)
    return NextResponse.json({ error: "Set the Jira site first (Admin → Ideas → Jira site)" }, { status: 400 });

  let me;
  try {
    me = await validateBasicCredentials(cfg.jiraSiteUrl, email, token);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Validation failed" }, { status: 400 });
  }

  const data = {
    authType: "basic",
    cloudId: "",
    siteUrl: cfg.jiraSiteUrl,
    accessToken: sealToken(basicAuthToken(email, token)),
    refreshToken: "",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    apiTokenExpiresAt: expiresAt,
    connectedByName: me.displayName,
    connectedByEmail: me.emailAddress ?? email,
    // A new token starts a clean expiry-warning cycle (the outage flag on
    // the workspace clears itself on the next passing check).
    expiryWarnedAt: null,
    ...(cfg.jiraProject
      ? {
          projectKeys: JSON.stringify([cfg.jiraProject]),
          ideasProjectKey: cfg.jiraProject,
          ...(cfg.jiraIssueType ? { ideasIssueType: cfg.jiraIssueType } : {}),
        }
      : {}),
  };
  await db.jiraConnection.upsert({
    where: { workspaceId: workspace.id },
    create: { workspaceId: workspace.id, ...data },
    update: data,
  });
  invalidateJiraHealth(workspace.id);
  return NextResponse.json({ ok: true, connectedBy: me.displayName, expiresAt: expiresAt?.toISOString() ?? null });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const workspace = await db.workspace.findUnique({ where: { organizationId: id }, select: { id: true } });
  if (!workspace) return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });
  const { count } = await db.jiraConnection.deleteMany({ where: { workspaceId: workspace.id } });
  invalidateJiraHealth(workspace.id);
  return NextResponse.json({ ok: true, removed: count });
}
