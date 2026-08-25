import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "pmos_session";
const CRM_SESSION_COOKIE = "pmos_crm_session";

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

function isCrmPath(pathname: string): boolean {
  return pathname === "/crm" || pathname.startsWith("/crm/") || pathname.startsWith("/api/crm");
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

  if (isCrmPath(pathname)) {
    const isCrmPublic =
      pathname === "/crm/login" || pathname.startsWith("/api/crm/auth/login");
    const hasCrmSession = Boolean(request.cookies.get(CRM_SESSION_COOKIE)?.value);

    if (!hasCrmSession && !isCrmPublic) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/crm/login", request.url));
    }

    if (hasCrmSession && pathname === "/crm/login") {
      return NextResponse.redirect(new URL("/crm", request.url));
    }

    return NextResponse.next();
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
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
