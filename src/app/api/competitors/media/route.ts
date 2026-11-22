import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { NextResponse } from "next/server";
import { competitorsGuard } from "@/lib/competitors/api";
import { competitorsPartOff } from "@/lib/competitors/parts-server";
import { mediaFilePath } from "@/lib/competitors/media";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm" };

/** GET ?p=<mediaPath>: a file from the competitors media store, for signed-in members of an org with the feature on. */
export async function GET(req: Request) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const off = await competitorsPartOff("profiles");
  if (off) return off;
  const rel = new URL(req.url).searchParams.get("p") ?? "";
  const full = mediaFilePath(rel);
  if (!full) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const type = TYPES[extname(full).toLowerCase()];
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(readFileSync(full)), { headers: { "content-type": type, "cache-control": "private, max-age=600" } });
}
