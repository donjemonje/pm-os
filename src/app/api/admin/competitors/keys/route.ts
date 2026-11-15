import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { createScannerKey, listScannerKeys, revokeScannerKey } from "@/lib/competitors/local";

/**
 * Administration → Competitors → Stations. Machine keys of the local lane
 * (PM-OS admin only). POST creates one and returns the secret ONCE; DELETE
 * ?id= revokes. Rotation is the poller's own doing, never a person's.
 */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ keys: await listScannerKeys() });
}

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let label = "Local station";
  try {
    const body = (await req.json()) as { label?: unknown };
    if (typeof body.label === "string" && body.label.trim()) label = body.label.trim();
  } catch {
    // default label
  }
  const created = await createScannerKey(label, admin.id);
  return NextResponse.json({ id: created.id, secret: created.secret, keys: await listScannerKeys() }, { status: 201 });
}

export async function DELETE(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id || !(await revokeScannerKey(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ keys: await listScannerKeys() });
}
