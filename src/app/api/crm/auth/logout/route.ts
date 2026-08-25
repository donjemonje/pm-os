import { NextResponse } from "next/server";
import {
  CRM_SESSION_COOKIE,
  deleteCrmSession,
  getCrmSessionToken,
} from "@/lib/crm-auth";

export async function POST() {
  const token = await getCrmSessionToken();
  if (token) await deleteCrmSession(token);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(CRM_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
