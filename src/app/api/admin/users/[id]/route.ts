import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { adminMutationError, RoleName } from "@/lib/admin-guard";
import { db } from "@/lib/db";

/**
 * PATCH { role?: "USER" | "PMOS_ADMIN", deactivated?: boolean }
 *
 * Minimized IAM + soft-deactivate. Guardrails (see admin-guard.ts): no
 * changing your own role, no deactivating yourself, and the last active
 * pmos-admin can be neither demoted nor deactivated. Deactivation deletes
 * the user's sessions so access ends immediately.
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

  const hasRole = body.role !== undefined;
  const hasDeactivated = body.deactivated !== undefined;
  if (!hasRole && !hasDeactivated) {
    return NextResponse.json(
      { error: "Provide role and/or deactivated" },
      { status: 400 }
    );
  }
  if (hasRole && body.role !== "USER" && body.role !== "PMOS_ADMIN") {
    return NextResponse.json(
      { error: "role must be USER or PMOS_ADMIN" },
      { status: 400 }
    );
  }
  if (hasDeactivated && typeof body.deactivated !== "boolean") {
    return NextResponse.json(
      { error: "deactivated must be true or false" },
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
      role: user.role as RoleName,
      deactivated: Boolean(user.deactivatedAt),
    },
    change: {
      role: hasRole ? (body.role as RoleName) : undefined,
      deactivated: hasDeactivated ? (body.deactivated as boolean) : undefined,
    },
    activeAdminCount,
  });
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  const data: { role?: RoleName; deactivatedAt?: Date | null } = {};
  if (hasRole) data.role = body.role as RoleName;
  if (hasDeactivated) {
    data.deactivatedAt = body.deactivated ? new Date() : null;
  }

  await db.user.update({ where: { id }, data });

  if (hasDeactivated && body.deactivated) {
    await db.session.deleteMany({ where: { userId: id } });
  }

  return NextResponse.json({ ok: true });
}
