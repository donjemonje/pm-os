import { NextResponse } from "next/server";
import {
  isLoginDisabled,
  isSignupAllowed,
  LOGIN_DISABLED_MESSAGE,
  SIGNUP_DISABLED_MESSAGE,
} from "./feature-flags";

export function loginDisabledResponse(): NextResponse | null {
  if (!isLoginDisabled()) return null;
  return NextResponse.json({ error: LOGIN_DISABLED_MESSAGE }, { status: 403 });
}

export function signupDisabledResponse(): NextResponse | null {
  if (isSignupAllowed()) return null;
  return NextResponse.json({ error: SIGNUP_DISABLED_MESSAGE }, { status: 403 });
}
