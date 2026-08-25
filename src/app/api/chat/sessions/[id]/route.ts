import { NextRequest, NextResponse } from "next/server";
import { apiAuthContext } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { parseJsonObject } from "@/lib/utils";
import type { ChatMessageMetadata } from "@/lib/types";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await apiAuthContext();
  if (auth instanceof NextResponse) return auth;
  const { workspaceId, userId } = auth;

  const session = await db.chatSession.findFirst({
    where: { id, workspaceId, OR: [{ userId }, { userId: null }] },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: session.id,
    title: session.title,
    context: parseJsonObject(session.context, {}),
    messages: session.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      metadata: parseJsonObject(m.metadata, {}) as ChatMessageMetadata,
      createdAt: m.createdAt,
    })),
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await apiAuthContext();
  if (auth instanceof NextResponse) return auth;
  const { workspaceId, userId } = auth;

  const deleted = await db.chatSession.deleteMany({
    where: { id, workspaceId, userId },
  });

  if (deleted.count === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
