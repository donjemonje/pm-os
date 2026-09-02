import { NextResponse } from "next/server";
import {
  isLoginDisabled,
  LOGIN_DISABLED_MESSAGE,
  SIGNUP_DISABLED_MESSAGE,
} from "./feature-flags";
import { isSelfSignupEnabled } from "./system-flags";

export function loginDisabledResponse(): NextResponse | null {
  if (!isLoginDisabled()) return null;
  return NextResponse.json({ error: LOGIN_DISABLED_MESSAGE }, { status: 403 });
}

export async function signupDisabledResponse(): Promise<NextResponse | null> {
  if (await isSelfSignupEnabled()) return null;
  return NextResponse.json({ error: SIGNUP_DISABLED_MESSAGE }, { status: 403 });
}
