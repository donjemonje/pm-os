import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { apiAuthContext } from "@/lib/api-auth";
import { db } from "@/lib/db";

const MAX_EVENTS = 100;
const MAX_NAME = 60;
const MAX_PATH = 200;

/**
 * Batched client telemetry → UsageEvent rows. Silent on bad input: never a
 * user-facing error. Product analytics describe the product app: events sent
 * from the Admin application (/admin/*) are accepted and dropped, whoever is
 * signed in — an admin acting in the product app is recorded like any user
 * (Daniel, 2026-10-25).
 */
const ADMIN_PATH = /^\/admin(\/|$)/;

export async function POST(request: NextRequest) {
  const auth = await apiAuthContext();
  if (auth instanceof NextResponse) return auth;
  let body: { sessionId?: unknown; events?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 40) : null;
  const events = (Array.isArray(body.events) ? body.events : []).slice(0, MAX_EVENTS);
  const rows: Prisma.UsageEventCreateManyInput[] = [];
  for (const e of events) {
    const row = (e ?? {}) as Record<string, unknown>;
    if (typeof row.event !== "string" || !row.event.trim()) continue;
    if (typeof row.path === "string" && ADMIN_PATH.test(row.path)) continue;
    const ts = typeof row.ts === "string" ? new Date(row.ts) : new Date();
    rows.push({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      sessionId,
      event: row.event.trim().slice(0, MAX_NAME),
      path: typeof row.path === "string" ? row.path.slice(0, MAX_PATH) : null,
      props:
        row.props && typeof row.props === "object" && !Array.isArray(row.props)
          ? (row.props as Prisma.InputJsonValue)
          : undefined,
      createdAt: Number.isNaN(ts.getTime()) ? new Date() : ts,
    });
  }
  if (rows.length > 0) await db.usageEvent.createMany({ data: rows });
  return NextResponse.json({ ok: true, stored: rows.length });
}
