import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
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
