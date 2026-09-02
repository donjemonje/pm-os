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
 * DELETE — hard-delete a user (added 2026-09-02 at Daniel's request; until
 * then Admin only soft-deactivated). Same guardrails as deactivation: no
 * self-delete, and the last active pmos-admin cannot be deleted. Sessions,
 * OAuth links, and password-reset tokens cascade; the user's chat sessions
 * are kept with userId set to null (schema onDelete rules).
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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;

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
    change: { deleted: true },
    activeAdminCount,
  });
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  await db.user.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
