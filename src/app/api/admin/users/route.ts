import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { createOrganizationUser } from "@/lib/auth";
import { sendInvitation } from "@/lib/invitations";

/**
 * POST { name, email, organizationId | organizationName, password? } —
 * create a user. Without a password (the Admin UI never sends one) the user
 * is invite-pending and an invite email goes out right away. The user is
 * created even when the email fails: the response reports
 * invite: { sent: false, error } so the admin can fix SMTP and use
 * "Resend invite" instead of re-creating the user.
 */
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

  let user;
  try {
    user = await createOrganizationUser({
      email,
      name,
      password: body.password?.trim() || undefined,
      organizationId: body.organizationId?.trim() || undefined,
      organizationName: body.organizationName?.trim() || undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create user";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (body.password?.trim()) {
    return NextResponse.json({ user, invite: null }, { status: 201 });
  }

  let invite: { sent: boolean; delivered?: boolean; error?: string };
  try {
    const result = await sendInvitation({
      userId: user.id,
      invitedByName: admin.name,
    });
    invite = { sent: true, delivered: result.delivered };
  } catch (e) {
    invite = {
      sent: false,
      error: e instanceof Error ? e.message : "Failed to send invite",
    };
  }
  return NextResponse.json({ user, invite }, { status: 201 });
}
