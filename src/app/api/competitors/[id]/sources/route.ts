import { NextResponse } from "next/server";
import { addAddress } from "@/lib/competitors/address-search";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

/**
 * POST {address, kind}: a PM adds one of a company's other addresses by hand — its help center, developer docs or
 * release notes (kind: helpcenter | apidocs | changelog). `id` is a competitor or the organization's own site: both
 * have other addresses. Validated like a website; refused when it is the company's main site or already in its
 * list. Its first scan is queued at once. Every member may (USER and CUSTOMER_ADMIN have the same permissions).
 */
export async function POST(req: Request, { params }: Params) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const company = await db.competitor.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, workspaceId: true, host: true, isOwn: true } });
  if (!company) return bad("Not found", 404);
  const r = await addAddress(company, { address: typeof body.address === "string" ? body.address : "", kind: body.kind }, ctx.user.id);
  if ("error" in r) {
    const A = C.settings.addresses;
    switch (r.error) {
      case "kind":
        return bad(A.kindRequired);
      case "private":
        return bad(C.settings.privateHost);
      case "main_site":
        return bad(A.mainSite, 409);
      case "exists":
        return bad(A.exists, 409);
      case "unreachable":
        return bad(A.unreachable, 422);
      default:
        return bad(A.invalid);
    }
  }
  return stateResponse(ctx, 201);
}
