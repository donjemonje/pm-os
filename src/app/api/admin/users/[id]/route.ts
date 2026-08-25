import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";

/**
 * PATCH { deactivated: boolean } — soft-deactivate / reactivate a user.
 * Deactivation also deletes the user's sessions so access ends immediately.
 * There is intentionally no hard-delete endpoint: a delete here would
 * cascade through sessions, OAuth links, and chat history. If a purge is
 * ever needed, it goes through a migration script with Daniel's sign-off.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;

  let body: { deactivated?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.deactivated !== "boolean") {
    return NextResponse.json(
      { error: "Provide deactivated: true or false" },
      { status: 400 }
    );
  }

  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (body.deactivated && user.email.toLowerCase() === admin.email.toLowerCase()) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 }
    );
  }

  await db.user.update({
    where: { id },
    data: { deactivatedAt: body.deactivated ? new Date() : null },
  });

  if (body.deactivated) {
    await db.session.deleteMany({ where: { userId: id } });
  }

  return NextResponse.json({ ok: true });
}
