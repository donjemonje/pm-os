import { NextResponse } from "next/server";
import { apiWorkspaceId, orgFeatureDisabledResponse } from "@/lib/api-auth";
import { startGoogleDriveOAuth } from "@/lib/google-drive-oauth-flow";
import { getGoogleDriveOAuthSetupStatus } from "@/lib/google-drive-oauth-config";

export async function GET() {
  // Drive follows the Docs flag: off = the OAuth start does not exist.
  const gated = await orgFeatureDisabledResponse("docs");
  if (gated) return gated;
  const setup = getGoogleDriveOAuthSetupStatus();
  if (!setup.ready) {
    return NextResponse.redirect(
      new URL(
        "/settings/jira?drive_error=oauth_not_configured",
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
      )
    );
  }

  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) {
    return NextResponse.redirect(
      new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
    );
  }

  return startGoogleDriveOAuth(workspaceResult);
}
