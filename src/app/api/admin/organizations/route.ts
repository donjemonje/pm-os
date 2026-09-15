import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import {
  createOrganizationWithWorkspace,
  listOrganizationsWithMembers,
} from "@/lib/auth";

export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const organizations = await listOrganizationsWithMembers();
  return NextResponse.json({ organizations });
}

export async function POST(request: NextRequest) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json(
      { error: "Organization name is required" },
      { status: 400 }
    );
  }

  try {
    const org = await createOrganizationWithWorkspace(name);
    return NextResponse.json(
      {
        organization: {
          id: org.id,
          name: org.name,
          slug: org.slug,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to create organization";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
