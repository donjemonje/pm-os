import type { Prisma } from "@prisma/client";
import { db } from "../db";

/**
 * Server-side usage events for the Competitors area (scans start and finish
 * without a browser). Same table as the client `track()` helper; the actor is
 * whoever started the scan (null when scheduled).
 */
export async function recordCompetitorEvent(
  workspaceId: string,
  userId: string | null,
  event: string,
  props: Record<string, string | number | boolean | null>,
): Promise<void> {
  try {
    await db.usageEvent.create({
      data: { workspaceId, userId, event, path: "/competitors", props: props as Prisma.InputJsonValue },
    });
  } catch {
    // Telemetry never breaks a scan.
  }
}
