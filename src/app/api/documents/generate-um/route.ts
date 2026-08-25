import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { fetchIssuesByKeys } from "@/lib/jira";
import { fetchGoogleDriveFileContents } from "@/lib/google-drive";
import { generateUserManualSection } from "@/lib/ai";
import { buildPrettyUserManual } from "@/lib/um-builder";
import {
  formatApiAiError,
  isAiEnabled,
  shouldUseTemplateOnQuota,
} from "@/lib/ai";
import { stringifyJsonArray } from "@/lib/utils";
import type { DocumentAudience } from "@/lib/types";

const VALID_AUDIENCES: DocumentAudience[] = ["external", "internal", "configuration"];

export async function POST(request: NextRequest) {
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
  const body = await request.json();
  const {
    title,
    issueKeys = [],
    driveFileIds = [],
    audience = "external",
    projectKey,
  } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }

  const keys = Array.isArray(issueKeys) ? issueKeys : [];
  const driveIds = Array.isArray(driveFileIds) ? driveFileIds : [];

  if (keys.length === 0 && driveIds.length === 0) {
    return NextResponse.json(
      { error: "Select at least one Jira ticket or Google Drive PRD file" },
      { status: 400 }
    );
  }

  if (keys.length > 0 && driveIds.length > 0) {
    return NextResponse.json(
      { error: "Choose either Jira tickets or Google Drive PRD files, not both" },
      { status: 400 }
    );
  }

  const docAudience: DocumentAudience = VALID_AUDIENCES.includes(audience)
    ? audience
    : "external";

  try {
    const [issues, driveFiles] = await Promise.all([
      keys.length > 0 ? fetchIssuesByKeys(workspaceId, keys) : Promise.resolve([]),
      driveIds.length > 0
        ? fetchGoogleDriveFileContents(workspaceId, driveIds)
        : Promise.resolve([]),
    ]);

    let bodyMarkdown: string;
    let usedTemplate = false;

    if (!isAiEnabled()) {
      bodyMarkdown = buildPrettyUserManual(title.trim(), issues, docAudience, driveFiles);
      usedTemplate = true;
    } else {
      const result = await generateUserManualSection(
        title.trim(),
        issues,
        docAudience,
        driveFiles,
        { cacheScope: workspaceId }
      );
      bodyMarkdown = result.body;
      usedTemplate = result.usedTemplate;
    }

    const document = await db.document.create({
      data: {
        workspaceId,
        type: "UM",
        title: title.trim(),
        body: bodyMarkdown,
        audience: docAudience,
        jiraKeys: stringifyJsonArray(keys),
        driveFileIds: stringifyJsonArray(driveIds),
        status: "draft",
      },
    });

    return NextResponse.json({
      document: {
        ...document,
        projectKey: projectKey ?? null,
      },
      usedTemplate,
      notice: usedTemplate
        ? "Generated without AI (quota unavailable). Review and edit before publishing."
        : undefined,
    });
  } catch (err) {
    if (shouldUseTemplateOnQuota()) {
      try {
        const [issues, driveFiles] = await Promise.all([
          keys.length > 0 ? fetchIssuesByKeys(workspaceId, keys) : Promise.resolve([]),
          driveIds.length > 0
            ? fetchGoogleDriveFileContents(workspaceId, driveIds)
            : Promise.resolve([]),
        ]);
        const bodyMarkdown = buildPrettyUserManual(title.trim(), issues, docAudience, driveFiles);
        const document = await db.document.create({
          data: {
            workspaceId,
            type: "UM",
            title: title.trim(),
            body: bodyMarkdown,
            audience: docAudience,
            jiraKeys: stringifyJsonArray(keys),
            driveFileIds: stringifyJsonArray(driveIds),
            status: "draft",
          },
        });
        return NextResponse.json({
          document: { ...document, projectKey: projectKey ?? null },
          usedTemplate: true,
          notice: "AI quota exceeded — saved a draft from your sources instead.",
        });
      } catch {
        // fall through
      }
    }

    const { message, status } = formatApiAiError(err);
    return NextResponse.json({ error: message }, { status });
  }
}
