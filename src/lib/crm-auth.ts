import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { hashPassword, sessionSecret, verifyPassword } from "./auth";
import { db } from "./db";

export const CRM_SESSION_COOKIE = "pmos_crm_session";
const SESSION_DAYS = 14;

export type CrmUserInfo = {
  id: string;
  email: string;
  name: string;
};

function hashToken(token: string): string {
  return scryptSync(token, sessionSecret(), 32).toString("hex");
}

export async function createCrmSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DAYS);

  await db.crmSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  return token;
}

export async function deleteCrmSession(token: string): Promise<void> {
  await db.crmSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function getCrmSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(CRM_SESSION_COOKIE)?.value;
}

export async function getCurrentCrmUser(): Promise<CrmUserInfo | null> {
  const token = await getCrmSessionToken();
  if (!token) return null;

  const session = await db.crmSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) await db.crmSession.delete({ where: { id: session.id } });
    return null;
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

export async function requireCrmUser(): Promise<CrmUserInfo> {
  const user = await getCurrentCrmUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

export async function authenticateCrmUser(email: string, password: string): Promise<CrmUserInfo | null> {
  const user = await db.crmUser.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return { id: user.id, email: user.email, name: user.name };
}

export async function createCrmUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<CrmUserInfo> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.crmUser.findUnique({ where: { email } });
  if (existing) throw new Error("CRM user already exists");

  const user = await db.crmUser.create({
    data: {
      email,
      name: input.name?.trim() || "CRM Admin",
      passwordHash: hashPassword(input.password),
    },
  });

  return { id: user.id, email: user.email, name: user.name };
}

export function crmSessionCookieOptions(token: string) {
  return {
    name: CRM_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}
