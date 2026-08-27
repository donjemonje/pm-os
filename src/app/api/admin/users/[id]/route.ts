import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { adminMutationError } from "@/lib/admin-guard";
import { db } from "@/lib/db";

/**
 * PATCH { deactivated: boolean } — soft-deactivate / reactivate a user.
 *
 * Role changes are NOT accepted here — not from the UI, not from an admin
 * session (Daniel's security call, 2026-08-27). Roles change only via
 * scripts/seed-admin.mjs (promote + password) and scripts/set-user-role.mjs
 * (either direction), in every environment including production. A request
 * carrying `role` is rejected outright rather than silently ignored.
 *
 * Guardrails (see admin-guard.ts): no self-deactivation, and the last
 * active pmos-admin cannot be deactivated. Deactivation deletes the user's
 * sessions so access ends immediately.
 *
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

  let body: { role?: unknown; deactivated?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.role !== undefined) {
    return NextResponse.json(
      {
        error:
          "Role changes are not available through the API. Use scripts/set-user-role.mjs.",
      },
      { status: 400 }
    );
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

  const activeAdminCount = await db.user.count({
    where: { role: "PMOS_ADMIN", deactivatedAt: null },
  });

  const refusal = adminMutationError({
    actorId: admin.id,
    target: {
      id: user.id,
      role: user.role,
      deactivated: Boolean(user.deactivatedAt),
    },
    change: { deactivated: body.deactivated },
    activeAdminCount,
  });
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
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
