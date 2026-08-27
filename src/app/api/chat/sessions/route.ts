import { NextResponse } from "next/server";
import { apiAuthContext, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";

export async function GET() {
  const disabled = await orgFeatureDisabledResponse("chat");
  if (disabled) return disabled;
  const auth = await apiAuthContext();
  if (auth instanceof NextResponse) return auth;
  const { workspaceId, userId } = auth;

  const sessions = await db.chatSession.findMany({
    where: { workspaceId, userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s._count.messages,
    })),
  });
}
