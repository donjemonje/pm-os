import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiWorkspaceId, orgFeatureDisabledResponse } from "@/lib/api-auth";
import {
  fetchIssuesByKeys,
  fetchIssuesForVersion,
  fetchRecentDoneIssues,
} from "@/lib/jira";
import { generateReleaseNotes, generateUserManualSection, isAiEnabled } from "@/lib/ai";
import { parseJsonArray, stringifyJsonArray } from "@/lib/utils";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const disabled = await orgFeatureDisabledResponse("docs");
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;

  const { id } = await params;

  // Scope to the caller's organization workspace so a user can never trigger
  // generation against another organization's document or integration data.
  const document = await db.document.findFirst({
    where: { id, workspaceId },
    include: { release: true },
  });

  if (!document) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!isAiEnabled()) {
    return NextResponse.json({ error: "AI not configured" }, { status: 503 });
  }

  try {
    let issues: Awaited<ReturnType<typeof fetchIssuesByKeys>> = [];
    const linkedKeys = parseJsonArray(document.jiraKeys);

    if (linkedKeys.length > 0) {
      issues = await fetchIssuesByKeys(document.workspaceId, linkedKeys);
    } else if (document.release?.jiraVersionName && document.release.jiraProjectKey) {
      issues = await fetchIssuesForVersion(
        document.workspaceId,
        document.release.jiraProjectKey,
        document.release.jiraVersionName
      );
    } else if (document.release?.jiraProjectKey) {
      issues = await fetchRecentDoneIssues(document.workspaceId, document.release.jiraProjectKey);
    }

    const audience =
      (document.audience as "external" | "internal" | "configuration") ?? "external";

    const generated =
      document.type === "RN"
        ? await generateReleaseNotes(document.title, issues, { cacheScope: workspaceId })
        : (
            await generateUserManualSection(document.title, issues, audience, [], {
              cacheScope: workspaceId,
            })
          ).body;

    const jiraKeys = issues.map((i) => i.key);

    const updated = await db.document.update({
      where: { id },
      data: {
        body: generated,
        jiraKeys: stringifyJsonArray(Array.from(new Set([...linkedKeys, ...jiraKeys]))),
        version: document.version + 1,
      },
    });

    return NextResponse.json({ body: updated.body, title: updated.title });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Generation failed" },
      { status: 500 }
    );
  }
}
