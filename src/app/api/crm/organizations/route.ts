import { NextRequest, NextResponse } from "next/server";
import {
  createOrganizationWithWorkspace,
  listOrganizationsWithMembers,
} from "@/lib/auth";
import { requireCrmUser } from "@/lib/crm-auth";

export async function GET() {
  try {
    await requireCrmUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const organizations = await listOrganizationsWithMembers();
  return NextResponse.json({ organizations });
}

export async function POST(request: NextRequest) {
  try {
    await requireCrmUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
          inviteCode: org.inviteCode,
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
