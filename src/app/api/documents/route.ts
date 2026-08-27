import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { stringifyJsonArray } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const disabled = await orgFeatureDisabledResponse("docs");
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
  const type = request.nextUrl.searchParams.get("type");

  const documents = await db.document.findMany({
    where: {
      workspaceId,
      ...(type ? { type } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: { release: true },
  });

  return NextResponse.json({ documents });
}

export async function POST(request: NextRequest) {
  const disabled = await orgFeatureDisabledResponse("docs");
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;
  const body = await request.json();
  const { type, title, releaseId, jiraKeys, audience } = body;

  if (!type || !title) {
    return NextResponse.json({ error: "type and title required" }, { status: 400 });
  }

  const document = await db.document.create({
    data: {
      workspaceId,
      type,
      title,
      releaseId: releaseId ?? null,
      jiraKeys: stringifyJsonArray(jiraKeys ?? []),
      audience: audience ?? "external",
    },
  });

  return NextResponse.json({ document });
}
