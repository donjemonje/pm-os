import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { ADMIN_ORG_COOKIE } from "@/lib/admin-org";
import { db } from "@/lib/db";

/** Selects the organization every PM-OS Admin screen works on. */
export async function POST(request: NextRequest) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let body: { orgId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const orgId = typeof body.orgId === "string" ? body.orgId : "";
  const org = orgId ? await db.organization.findUnique({ where: { id: orgId }, select: { id: true } }) : null;
  if (!org) return NextResponse.json({ error: "Unknown organization" }, { status: 404 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_ORG_COOKIE, org.id, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  return res;
}
