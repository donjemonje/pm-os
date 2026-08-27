import { NextResponse } from "next/server";
import {
  deleteSession,
  getSessionToken,
  SESSION_COOKIE,
  TWO_FACTOR_PENDING_COOKIE,
} from "@/lib/auth";

export async function POST() {
  const token = await getSessionToken();
  if (token) {
    await deleteSession(token);
  }

  const response = NextResponse.json({ ok: true });
  for (const name of [SESSION_COOKIE, TWO_FACTOR_PENDING_COOKIE]) {
    response.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}
