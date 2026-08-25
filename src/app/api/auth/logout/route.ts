import { NextResponse } from "next/server";
import { deleteSession, getSessionToken, SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  const token = await getSessionToken();
  if (token) {
    await deleteSession(token);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
