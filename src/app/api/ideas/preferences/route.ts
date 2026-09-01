import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { apiAuthContext, ideasDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";

/**
 * Per-user Ideas preferences. `productLines` is the PM's own lines — applied
 * as the default filter on the Ideas screen and the default merge scope.
 * Names are validated against the workspace catalog so a rename there can't
 * leave ghosts here.
 */
export async function POST(request: NextRequest) {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const auth = await apiAuthContext();
  if (auth instanceof NextResponse) return auth;

  let body: { productLines?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.productLines)) {
    return NextResponse.json({ error: "productLines must be an array" }, { status: 400 });
  }
  const requested = body.productLines.filter((p): p is string => typeof p === "string");

  const catalog = await db.productLine.findMany({
    where: { workspaceId: auth.workspaceId },
    select: { name: true },
  });
  const catalogNames = new Map(catalog.map((c) => [c.name.toLowerCase(), c.name]));
  const productLines = requested
    .map((p) => catalogNames.get(p.toLowerCase()))
    .filter((p): p is string => Boolean(p));

  await db.user.update({
    where: { id: auth.userId },
    data: { defaultProductLines: productLines as Prisma.InputJsonValue },
  });

  return NextResponse.json({ ok: true, productLines });
}
