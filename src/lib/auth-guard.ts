import { NextResponse } from "next/server";
import { isLoginDisabled, LOGIN_DISABLED_MESSAGE } from "./feature-flags";

export function loginDisabledResponse(): NextResponse | null {
  if (!isLoginDisabled()) return null;
  return NextResponse.json({ error: LOGIN_DISABLED_MESSAGE }, { status: 403 });
}
