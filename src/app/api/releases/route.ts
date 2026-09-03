import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { fetchIssuesForVersion } from "@/lib/jira";
import { generateReleaseNotes, isAiEnabled } from "@/lib/ai";
import { stringifyJsonArray } from "@/lib/utils";

export async function GET() {
  const gated = await orgFeatureDisabledResponse("docs");
  if (gated) return gated;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
  const releases = await db.release.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    include: {
      documents: { where: { type: "RN" }, take: 1 },
      _count: { select: { documents: true } },
    },
  });

  return NextResponse.json({ releases });
}

export async function POST(request: NextRequest) {
  const gated = await orgFeatureDisabledResponse("docs");
  if (gated) return gated;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
  const body = await request.json();
  const { name, jiraProjectKey, jiraVersionId, jiraVersionName, generateNotes } = body;

  if (!name || !jiraProjectKey) {
    return NextResponse.json(
      { error: "name and jiraProjectKey required" },
      { status: 400 }
    );
  }

  const release = await db.release.create({
    data: {
      workspaceId,
      name,
      jiraProjectKey,
      jiraVersionId: jiraVersionId ?? null,
      jiraVersionName: jiraVersionName ?? null,
    },
  });

  let rnDocument = null;

  if (generateNotes && isAiEnabled()) {
    try {
      const issues =
        jiraVersionName
          ? await fetchIssuesForVersion(workspaceId, jiraProjectKey, jiraVersionName)
          : [];

      const notesBody = await generateReleaseNotes(name, issues, {
        cacheScope: workspaceId,
      });

      rnDocument = await db.document.create({
        data: {
          workspaceId,
          releaseId: release.id,
          type: "RN",
          title: `${name} — Release Notes`,
          body: notesBody,
          jiraKeys: stringifyJsonArray(issues.map((i) => i.key)),
        },
      });
    } catch {
      // Release created even if AI generation fails
    }
  } else {
    rnDocument = await db.document.create({
      data: {
        workspaceId,
        releaseId: release.id,
        type: "RN",
        title: `${name} — Release Notes`,
        body: "",
      },
    });
  }

  return NextResponse.json({ release, document: rnDocument });
}
