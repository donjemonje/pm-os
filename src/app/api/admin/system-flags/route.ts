import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { isSystemFlagKey } from "@/lib/feature-flags";
import { listSystemFlagOverrides } from "@/lib/system-flags";

/**
 * PATCH { flags: { googleSso: true | false | null } }
 * true/false sets a system-wide override; null removes the override so the
 * env default applies again. Unknown flag keys are rejected.
 */
export async function PATCH(request: NextRequest) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  let body: { flags?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch = body.flags;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "Provide a flags object" }, { status: 400 });
  }

  for (const [key, value] of Object.entries(patch)) {
    if (!isSystemFlagKey(key)) {
      return NextResponse.json(
        { error: `Unknown system flag: ${key}` },
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

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      await db.systemFlag.deleteMany({ where: { key } });
    } else {
      await db.systemFlag.upsert({
        where: { key },
        create: { key, value: value as boolean },
        update: { value: value as boolean },
      });
    }
  }

  return NextResponse.json({ flags: await listSystemFlagOverrides() });
}
