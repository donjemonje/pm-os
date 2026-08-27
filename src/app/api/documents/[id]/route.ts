import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { parseJsonArray } from "@/lib/utils";

async function getOwnedDocument(id: string, workspaceId: string) {
  const document = await db.document.findFirst({
    where: { id, workspaceId },
    include: { release: true },
  });
  return document;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const disabled = await orgFeatureDisabledResponse("docs");
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;

  const { id } = await params;
  const document = await getOwnedDocument(id, workspaceId);

  if (!document) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    document: {
      ...document,
      jiraKeys: parseJsonArray(document.jiraKeys),
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const disabled = await orgFeatureDisabledResponse("docs");
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;

  const { id } = await params;
  const body = await request.json();
  const { title, body: docBody, status, jiraKeys } = body;

  const existing = await getOwnedDocument(id, workspaceId);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const document = await db.document.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(docBody !== undefined ? { body: docBody } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(jiraKeys !== undefined ? { jiraKeys: JSON.stringify(jiraKeys) } : {}),
      ...(status === "published" ? { publishedAt: new Date() } : {}),
      version: existing.version + (docBody !== undefined && docBody !== existing.body ? 1 : 0),
    },
  });

  return NextResponse.json({ document });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const disabled = await orgFeatureDisabledResponse("docs");
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  const workspaceId = workspaceResult;

  const { id } = await params;
  const existing = await getOwnedDocument(id, workspaceId);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.document.delete({ where: { id } });
  return NextResponse.json({ ok: true, type: existing.type });
}
