import { NextResponse } from "next/server";
import { removeAddress } from "@/lib/competitors/address-search";
import { bad, competitorsGuard, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string; sourceId: string }> };

/**
 * DELETE: a PM removes one of a company's other addresses (never its main website). It is not scanned again, and
 * a later search never adds it back; adding the same address by hand brings it back. Refused while a scan is
 * reading it. `id` is a competitor or the organization's own site.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id, sourceId } = await params;
  const company = await db.competitor.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, workspaceId: true, host: true, isOwn: true } });
  if (!company) return bad("Not found", 404);
  const r = await removeAddress(company, sourceId, ctx.user.id);
  if ("error" in r) return r.error === "scan_running" ? bad(C.settings.addresses.scanRunning, 409) : bad("Not found", 404);
  return stateResponse(ctx);
}
