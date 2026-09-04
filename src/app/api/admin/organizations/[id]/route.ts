import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { adminOrgDeleteError, ORG_DELETE_CONFIRMATION } from "@/lib/admin-guard";
import { toFeatureOverrides } from "@/lib/auth";
import { db } from "@/lib/db";
import { isOrgFeatureKey } from "@/lib/feature-flags";

/**
 * PATCH { features: { ideas: true | false | null } }
 * true/false sets a per-org override; null removes the override so the env
 * default applies again. Unknown flag keys are rejected.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;

  let body: { features?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch = body.features;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json(
      { error: "Provide a features object" },
      { status: 400 }
    );
  }

  for (const [key, value] of Object.entries(patch)) {
    if (!isOrgFeatureKey(key)) {
      return NextResponse.json(
        { error: `Unknown feature flag: ${key}` },
        { status: 400 }
      );
    }
    if (typeof value !== "boolean" && value !== null) {
      return NextResponse.json(
        { error: `Flag ${key} must be true, false, or null` },
        { status: 400 }
      );
    }
  }

  const org = await db.organization.findUnique({ where: { id } });
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const features = toFeatureOverrides(org.features);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete features[key];
    } else {
      features[key] = value as boolean;
    }
  }

  const updated = await db.organization.update({
    where: { id },
    data: { features },
  });

  return NextResponse.json({
    organization: {
      id: updated.id,
      name: updated.name,
      features: toFeatureOverrides(updated.features),
    },
  });
}

/**
 * DELETE { confirm: "delete" } — permanently delete an organization together
 * with its workspace (and everything under it: ideas, documents, releases,
 * integrations, chat, ledger…) and all of its users. The confirmation word is
 * checked server-side too, so a stray DELETE without it is refused.
 *
 * Guardrails (admin-guard.ts): the acting admin's own org cannot be deleted,
 * and neither can an org that holds the last active pmos-admin.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;

  let body: { confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.confirm !== ORG_DELETE_CONFIRMATION) {
    return NextResponse.json(
      { error: `Type "${ORG_DELETE_CONFIRMATION}" to confirm deleting the organization` },
      { status: 400 }
    );
  }

  // Load, count, guard and delete in one transaction so a concurrent admin
  // deletion cannot leave the system without an active pmos-admin. Users
  // hang off the org without a cascade rule (they would be orphaned with
  // organizationId = null), so they are deleted explicitly; each user delete
  // cascades sessions/OAuth/reset tokens, the org delete cascades the
  // workspace and all of its data.
  const outcome = await db.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, role: true, deactivatedAt: true } },
      },
    });
    if (!org) return { status: 404 as const, error: "Organization not found" };

    const activeAdminCount = await tx.user.count({
      where: { role: "PMOS_ADMIN", deactivatedAt: null },
    });
    const refusal = adminOrgDeleteError({
      actorId: admin.id,
      members: org.users.map((u) => ({
        id: u.id,
        role: u.role,
        deactivated: Boolean(u.deactivatedAt),
      })),
      activeAdminCount,
    });
    if (refusal) return { status: 400 as const, error: refusal };

    await tx.user.deleteMany({ where: { organizationId: id } });
    await tx.organization.delete({ where: { id } });
    return { status: 200 as const };
  });

  if (outcome.status !== 200) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  return NextResponse.json({ ok: true });
}
