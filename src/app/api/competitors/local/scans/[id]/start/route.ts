import { NextResponse } from "next/server";
import { startLocalScan, verifyScannerKey, verifyScanToken } from "@/lib/competitors/local";

type Params = { params: Promise<{ id: string }> };

/**
 * POST — the station starts reading this scan (scan token as bearer): the row goes "in progress" before the first
 * page lands. The optional `x-pmos-station` header carries the machine key so the request records which station
 * took it (Administration).
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const tok = await verifyScanToken(req.headers.get("authorization"), id);
  if (!tok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const station = req.headers.get("x-pmos-station");
  const key = station ? await verifyScannerKey(station) : null;
  const ok = await startLocalScan(id, key?.id ?? null);
  if (!ok) return NextResponse.json({ error: "The scan is not waiting" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
