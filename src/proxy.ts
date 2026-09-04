import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "pmos_session";
// UX hint set at login when the TOTP challenge is still owed; the real gate is
// server-side in getCurrentUser, which rejects unverified sessions.
const TWO_FACTOR_PENDING_COOKIE = "pmos_2fa_pending";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/invite",
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname.startsWith("/api/auth/login")) {
    return true;
  }
  if (
    pathname.startsWith("/api/auth/forgot-password") ||
    pathname.startsWith("/api/auth/reset-password")
  ) {
    return true;
  }
  if (pathname.startsWith("/api/auth/oauth")) {
    return true;
  }
  return false;
}

function isAdminPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/")
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.match(/\.(ico|png|jpg|jpeg|svg|webp)$/)
  ) {
    return NextResponse.next();
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const isApi = pathname.startsWith("/api/");

  // Pending TOTP challenge routes every page — /admin included — to
  // /login/2fa. APIs skip the redirect; getCurrentUser rejects them anyway.
  const twoFactorPending = Boolean(
    request.cookies.get(TWO_FACTOR_PENDING_COOKIE)?.value
  );
  if (hasSession && twoFactorPending && !isApi && pathname !== "/login/2fa") {
    const challenge = new URL("/login/2fa", request.url);
    if (!isPublicPath(pathname)) {
      challenge.searchParams.set("from", pathname);
    }
    return NextResponse.redirect(challenge);
  }

  // PM-OS Admin rides the main app session. This is defense-in-depth only —
  // it can't validate the token or the PMOS_ADMIN role (no DB on the edge),
  // so every admin page and /api/admin route re-checks server-side via
  // requireAdminPage()/apiAdmin().
  if (isAdminPath(pathname)) {
    if (!hasSession) {
      if (isApi) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const login = new URL("/login", request.url);
      login.searchParams.set("from", pathname);
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  }

  if (!hasSession && !isPublicPath(pathname) && !isApi) {
    const login = new URL("/login", request.url);
    login.searchParams.set("from", pathname);
    return NextResponse.redirect(login);
  }

  // No blind cookie-holder redirect off /login: the cookie may be stale
  // (revoked session). The login page validates the session server-side and
  // redirects genuinely signed-in users to /dashboard itself.

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
