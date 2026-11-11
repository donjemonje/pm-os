import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { tick } from "@/lib/competitors/run";
import { clockOffsetMs, scanTimeLimitMs, setClockOffsetMs, readTestAiAnswers, setLimitKnobs, setTestAiAnswers, storageLimitChars, storedTextChars, testKnobsEnabled } from "@/lib/competitors/settings";

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
 *   POST { aiAnswers: { competitorId, answers } } → the model's raw answers for that competitor's analysis runs
 *                             (settings.ts TestAiAnswers: research by page address, merge and match by call number,
 *                             secondLook by capability name, facts, rateLimit; every answer is JSON text). A run with
 *                             injected answers never calls a model, also when COMPETITORS_AI=off. answers: null clears.
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
  if (body.aiAnswers !== undefined) {
    const a = body.aiAnswers as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || Array.isArray(a) || typeof a.competitorId !== "string" || !a.competitorId) return NextResponse.json({ error: "aiAnswers needs a competitorId" }, { status: 400 });
    if (!("answers" in a)) return NextResponse.json({ error: "aiAnswers needs answers (an object, or null to clear); the classify / facts shape is gone" }, { status: 400 });
    if (a.answers === null) {
      await setTestAiAnswers(a.competitorId, null);
      out.aiAnswers = null;
    } else {
      const answers = readTestAiAnswers(a.answers);
      if ("error" in answers) return NextResponse.json({ error: `aiAnswers: ${answers.error}` }, { status: 400 });
      await setTestAiAnswers(a.competitorId, answers);
      out.aiAnswers = a.competitorId;
    }
  }
  if (body.tick === true) {
    const lines: string[] = [];
    await tick((m) => lines.push(m));
    out.tick = lines;
  }
  return NextResponse.json(out);
}
