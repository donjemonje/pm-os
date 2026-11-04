import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { tick } from "@/lib/competitors/run";
import { clockOffsetMs, setClockOffsetMs, testKnobsEnabled } from "@/lib/competitors/settings";

/**
 * TEST KNOBS (Website Scanning QA, 2026-11-04). Available only when
 * COMPETITORS_TEST_KNOBS=on and never in production — 404 otherwise. Tests set
 * time instead of waiting for it, and tick the scheduler instead of waiting an
 * hour. The logic under test never changes; only its inputs do.
 *
 *   GET                     → { clockOffsetMs }
 *   POST { clockOffsetMs }  → move the scanner's clock (absolute offset from the wall clock, ms)
 *   POST { tick: true }     → run the hourly tick once
 */
export async function GET() {
  if (!testKnobsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ clockOffsetMs: await clockOffsetMs() });
}

export async function POST(req: Request) {
  if (!testKnobsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const out: Record<string, unknown> = {};
  if (typeof body.clockOffsetMs === "number" && Number.isFinite(body.clockOffsetMs)) {
    await setClockOffsetMs(body.clockOffsetMs);
    out.clockOffsetMs = await clockOffsetMs();
  }
  if (body.tick === true) {
    const lines: string[] = [];
    await tick((m) => lines.push(m));
    out.tick = lines;
  }
  return NextResponse.json(out);
}
