import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "pmos_session";

const PUBLIC_PATHS = ["/", "/login", "/register"];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname.startsWith("/api/auth/login") || pathname.startsWith("/api/auth/register")) {
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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.match(/\.(ico|png|jpg|jpeg|svg|webp)$/)
  ) {
    return NextResponse.next();
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // PM-OS Admin rides the main app session. This is defense-in-depth only —
  // it can't validate the token or the ADMIN_EMAILS allowlist (no DB on the
  // edge), so every admin page and /api/admin route re-checks server-side
  // via requireAdmin()/apiAdmin().
  if (isAdminPath(pathname)) {
    if (!hasSession) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const login = new URL("/login", request.url);
      login.searchParams.set("from", pathname);
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  }

  const isApi = pathname.startsWith("/api/");

  if (!hasSession && !isPublicPath(pathname) && !isApi) {
    const login = new URL("/login", request.url);
    login.searchParams.set("from", pathname);
    return NextResponse.redirect(login);
  }

  if (hasSession && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
