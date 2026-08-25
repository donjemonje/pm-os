import { NextResponse } from "next/server";
import { getCurrentUser, getOrganizationSummary, userInitials } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const organization = user.organizationId
    ? await getOrganizationSummary(user.organizationId)
    : null;

  return NextResponse.json({
    user: {
      ...user,
      initials: userInitials(user.name, user.email),
    },
    organization,
  });
}
