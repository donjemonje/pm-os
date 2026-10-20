import { cookies } from "next/headers";
import { db } from "./db";

export const ADMIN_ORG_COOKIE = "pmos_admin_org";

export interface AdminOrgRef {
  id: string;
  name: string;
  slug: string;
}

/**
 * PM-OS Admin works on ONE organization at a time (Daniel, 2026-10-20: no
 * multi-org views, a banner says which org is selected). The choice lives
 * in a cookie; an unknown or missing choice falls back to the first org.
 */
export async function getAdminOrg(
  /** The admin's own organization — the fallback before any choice is made. */
  fallbackId?: string | null,
): Promise<{ current: AdminOrgRef | null; all: AdminOrgRef[] }> {
  const all = await db.organization.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true },
  });
  const wanted = (await cookies()).get(ADMIN_ORG_COOKIE)?.value;
  const current =
    all.find((o) => o.id === wanted) ?? all.find((o) => o.id === fallbackId) ?? all[0] ?? null;
  return { current, all };
}
