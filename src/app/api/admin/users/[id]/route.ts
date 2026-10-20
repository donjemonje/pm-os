import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { adminMutationError } from "@/lib/admin-guard";
import { db } from "@/lib/db";

/**
 * PATCH { deactivated: boolean } — soft-deactivate / reactivate a user.
 * PATCH { role: "USER" | "CUSTOMER_ADMIN" } — customer-side role, one
 * change per request (never bundled with `deactivated`).
 *
 * PMOS_ADMIN is NOT assignable or removable here — not from the UI, not
 * from an admin session (Daniel's security call, 2026-08-27; customer-admin
 * carved out 2026-10-18 because a customer must be able to run its own
 * settings). The pmos-admin role moves only via scripts/seed-admin.mjs, in
 * every environment including production. A request naming PMOS_ADMIN, or
 * targeting a pmos-admin, is rejected outright rather than silently ignored.
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
    if (body.deactivated !== undefined) {
      return NextResponse.json(
        { error: "Change the role or the deactivation, not both at once" },
        { status: 400 }
      );
    }
    if (body.role !== "USER" && body.role !== "CUSTOMER_ADMIN") {
      return NextResponse.json(
        {
          error:
            "Only USER and CUSTOMER_ADMIN can be set here. The pmos-admin role moves only via scripts/seed-admin.mjs.",
        },
        { status: 400 }
      );
    }
    const target = await db.user.findUnique({ where: { id }, select: { role: true } });
    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (target.role === "PMOS_ADMIN") {
      return NextResponse.json(
        { error: "A pmos-admin's role cannot be changed here" },
        { status: 400 }
      );
    }
    await db.user.update({ where: { id }, data: { role: body.role } });
    return NextResponse.json({ ok: true });
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

  // Count, guard and delete in one transaction so two admins deleting each
  // other concurrently cannot leave the system without an active pmos-admin.
  const outcome = await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) return { status: 404 as const, error: "User not found" };

    const activeAdminCount = await tx.user.count({
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
    if (refusal) return { status: 400 as const, error: refusal };

    await tx.user.delete({ where: { id } });
    return { status: 200 as const };
  });

  if (outcome.status !== 200) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  return NextResponse.json({ ok: true });
}
