import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { createOrganizationUser } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  let body: {
    email?: string;
    name?: string;
    password?: string;
    organizationId?: string;
    organizationName?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim();
  const name = body.name?.trim();
  if (!email || !name) {
    return NextResponse.json(
      { error: "Name and email are required" },
      { status: 400 }
    );
  }
  if (!body.organizationId?.trim() && !body.organizationName?.trim()) {
    return NextResponse.json(
      {
        error:
          "Select an existing organization or provide a new organization name",
      },
      { status: 400 }
    );
  }

  try {
    const user = await createOrganizationUser({
      email,
      name,
      password: body.password?.trim() || undefined,
      organizationId: body.organizationId?.trim() || undefined,
      organizationName: body.organizationName?.trim() || undefined,
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create user";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
