import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { AuthUser, getCurrentUser } from "./auth";
import { UnauthorizedError } from "./workspace";

/**
 * PM-OS Admin access control. Admin rides the main app auth (User/Session);
 * admin-ness comes solely from User.role === PMOS_ADMIN.
 *
 * Deny-by-default: role defaults to USER, so nobody is an admin until
 * promoted via script (seed-admin.mjs / set-user-role.mjs) — role changes
 * are deliberately impossible through the UI or API, in every environment.
 *
 * The middleware path gate on /admin is defense-in-depth only — every admin
 * page and /api/admin route must call requireAdminPage()/apiAdmin()
 * server-side.
 */

export function isPmosAdmin(user: Pick<AuthUser, "role"> | null): boolean {
  return user?.role === "PMOS_ADMIN";
}

/** Current user when they are a pmos-admin, else null. */
export async function getCurrentAdmin(): Promise<AuthUser | null> {
  const user = await getCurrentUser();
  if (!isPmosAdmin(user)) return null;
  return user;
}

/** For server-side code paths outside pages/routes. Throws when not admin. */
export async function requireAdmin(): Promise<AuthUser> {
  const admin = await getCurrentAdmin();
  if (!admin) throw new UnauthorizedError("Admin access required");
  return admin;
}

/**
 * For /admin server components: redirects signed-out visitors to /login and
 * 404s signed-in non-admins (admin existence is not advertised).
 */
export async function requireAdminPage(fromPath: string): Promise<AuthUser> {
  const user = await getCurrentUser();
  // The proxy already bounces cookie-less visitors, so a null user here means
  // a stale/unverified cookie — exit through the ramp that clears it.
  if (!user) {
    redirect(`/api/auth/session-expired?from=${encodeURIComponent(fromPath)}`);
  }
  if (!isPmosAdmin(user)) notFound();
  return user;
}

/**
 * For /api/admin route handlers: returns the admin user, or the error
 * response to send (401 when not signed in, 404 when signed in but not
 * a pmos-admin — admin existence is not advertised).
 */
export async function apiAdmin(): Promise<AuthUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPmosAdmin(user)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return user;
}
