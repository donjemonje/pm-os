import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { tick } from "@/lib/competitors/run";
import { clockOffsetMs, scanTimeLimitMs, setClockOffsetMs, setLimitKnobs, setTestAiAnswers, storageLimitChars, storedTextChars, testKnobsEnabled } from "@/lib/competitors/settings";

/**
 * TEST KNOBS (Website Scanning QA, 2026-11-04). Available only when
 * COMPETITORS_TEST_KNOBS=on and never in production — 404 otherwise. Tests set
 * time instead of waiting for it, and tick the scheduler instead of waiting an
 * hour. The logic under test never changes; only its inputs do.
 *
 *   GET                     → { clockOffsetMs, ceilingMs, storageLimitChars, storedTextChars }
 *   POST { clockOffsetMs }  → move the scanner's clock (absolute offset from the wall clock, ms)
 *   POST { tick: true }     → run the hourly tick once
 *   POST { ceilingMs }      → a shorter time limit per scan (null = the default); WS-17
 *   POST { storageLimitChars } → a smaller PM-OS store limit (null = the default); WS-36
 *   POST { aiAnswers: { competitorId, classify, facts? } } → the model's raw answers for that competitor's scans
 *                             (JSON text in the answer's own shape; the scan runs the PMOS AI step with them even
 *                             when COMPETITORS_AI=off and never calls a model); { competitorId, classify: null } clears. CA rows
 */
export async function GET() {
  if (!testKnobsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ clockOffsetMs: await clockOffsetMs(), ceilingMs: await scanTimeLimitMs(), storageLimitChars: await storageLimitChars(), storedTextChars: await storedTextChars() });
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
  if (body.ceilingMs === null || (typeof body.ceilingMs === "number" && Number.isFinite(body.ceilingMs))) {
    await setLimitKnobs({ ceilingMs: body.ceilingMs as number | null });
    out.ceilingMs = await scanTimeLimitMs();
  }
  if (body.storageLimitChars === null || (typeof body.storageLimitChars === "number" && Number.isFinite(body.storageLimitChars))) {
    await setLimitKnobs({ storageLimitChars: body.storageLimitChars as number | null });
    out.storageLimitChars = await storageLimitChars();
    out.storedTextChars = await storedTextChars();
  }
  if (body.aiAnswers && typeof body.aiAnswers === "object" && !Array.isArray(body.aiAnswers)) {
    const a = body.aiAnswers as Record<string, unknown>;
    if (typeof a.competitorId !== "string" || !a.competitorId) return NextResponse.json({ error: "aiAnswers needs a competitorId" }, { status: 400 });
    if (a.classify === null) {
      await setTestAiAnswers(a.competitorId, null);
      out.aiAnswers = null;
    } else if (typeof a.classify === "string") {
      for (const text of [a.classify, a.facts]) {
        if (typeof text !== "string") continue;
        try {
          JSON.parse(text);
        } catch {
          return NextResponse.json({ error: "aiAnswers must be JSON text" }, { status: 400 });
        }
      }
      await setTestAiAnswers(a.competitorId, { classify: a.classify, facts: typeof a.facts === "string" ? a.facts : undefined });
      out.aiAnswers = a.competitorId;
    } else {
      return NextResponse.json({ error: "aiAnswers.classify must be JSON text, or null to clear" }, { status: 400 });
    }
  }
  if (body.tick === true) {
    const lines: string[] = [];
    await tick((m) => lines.push(m));
    out.tick = lines;
  }
  return NextResponse.json(out);
}
