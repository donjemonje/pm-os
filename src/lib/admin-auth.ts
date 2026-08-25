import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { AuthUser, getCurrentUser } from "./auth";
import { UnauthorizedError } from "./workspace";

/**
 * PM-OS Admin access control. Admin rides the main app auth (User/Session);
 * admin-ness comes solely from the ADMIN_EMAILS env allowlist.
 *
 * Deny-by-default: ADMIN_EMAILS unset or empty means nobody is an admin.
 * Matching is case-insensitive on the trimmed email.
 *
 * The middleware path gate on /admin is defense-in-depth only — every admin
 * page and /api/admin route must call requireAdmin()/apiAdmin() server-side.
 */

export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

/** Current user when they are an allowlisted admin, else null. */
export async function getCurrentAdmin(): Promise<AuthUser | null> {
  const user = await getCurrentUser();
  if (!user || !isAdminEmail(user.email)) return null;
  return user;
}

/** For server components / server-side code paths. Throws when not admin. */
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
  if (!user) redirect(`/login?from=${encodeURIComponent(fromPath)}`);
  if (!isAdminEmail(user.email)) notFound();
  return user;
}

/**
 * For /api/admin route handlers: returns the admin user, or the error
 * response to send (401 when not signed in, 404 when signed in but not
 * allowlisted — admin existence is not advertised).
 */
export async function apiAdmin(): Promise<AuthUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return user;
}
