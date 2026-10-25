import type { Prisma } from "@prisma/client";
import { db } from "../db";

/**
 * Server-side usage events for the Competitors area (scans start and finish
 * without a browser). Same table as the client `track()` helper. Events record
 * customer users only: a PMOS_ADMIN actor writes nothing (Daniel, 2026-10-25).
 */
export async function recordCompetitorEvent(
  workspaceId: string,
  userId: string | null,
  event: string,
  props: Record<string, string | number | boolean | null>,
): Promise<void> {
  try {
    if (userId) {
      const u = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (u?.role === "PMOS_ADMIN") return;
    }
    await db.usageEvent.create({
      data: { workspaceId, userId, event, path: "/competitors", props: props as Prisma.InputJsonValue },
    });
  } catch {
    // Telemetry never breaks a scan.
  }
}
