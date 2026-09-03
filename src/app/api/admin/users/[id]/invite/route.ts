import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { sendInvitation } from "@/lib/invitations";

/**
 * POST — resend the invite email (fresh 7-day set-password link; older
 * unused links stop working). Only for invite-pending users: no password
 * yet and not deactivated. 400 with the reason otherwise; 502 when SMTP
 * refuses the send.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;

  try {
    const result = await sendInvitation({
      userId: id,
      invitedByName: admin.name,
    });
    return NextResponse.json({ ok: true, delivered: result.delivered });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to send invite";
    const notSendable =
      message === "User not found" ||
      message === "User is deactivated" ||
      message.startsWith("User already has a password");
    return NextResponse.json(
      { error: message },
      { status: notSendable ? 400 : 502 }
    );
  }
}
