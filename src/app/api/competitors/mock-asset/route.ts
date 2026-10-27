import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { NextResponse } from "next/server";
import { competitorsGuard } from "@/lib/competitors/api";
import { mockAssetPath } from "@/lib/competitors/mock";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4" };

/** Dev-only: serves an image from the mock folder (COMPETITORS_MOCK_DIR). 404 in production or when unset. */
export async function GET(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const rel = new URL(req.url).searchParams.get("f") ?? "";
  const full = mockAssetPath(rel);
  if (!full) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const type = TYPES[extname(full).toLowerCase()];
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(readFileSync(full)), { headers: { "content-type": type, "cache-control": "private, max-age=300" } });
}
