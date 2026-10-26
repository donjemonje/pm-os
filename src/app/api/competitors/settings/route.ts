import { NextResponse } from "next/server";
import { bad, competitorsGuard, readJson, stateResponse } from "@/lib/competitors/api";
import { isScanFrequency, MAX_MAX_PAGES, MIN_MAX_PAGES } from "@/lib/competitors/config";
import { getCompetitorsConfig, saveCompetitorsConfig } from "@/lib/competitors/store";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";

/** PATCH {scanFrequency?, maxPagesPerScan?, manualRescansPerDay?} — customer admin. */
export async function PATCH(req: Request) {
  const ctx = await competitorsGuard({ admin: true });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const current = await getCompetitorsConfig(ctx.workspaceId);
  const next = { ...current };
  if (body.scanFrequency !== undefined) {
    if (!isScanFrequency(body.scanFrequency)) return bad("Pick daily, weekly or monthly.");
    next.scanFrequency = body.scanFrequency;
  }
  if (body.maxPagesPerScan !== undefined) {
    const n = typeof body.maxPagesPerScan === "number" ? Math.round(body.maxPagesPerScan) : NaN;
    if (!Number.isFinite(n) || n < MIN_MAX_PAGES || n > MAX_MAX_PAGES) return bad(`Pages per scan must be between ${MIN_MAX_PAGES} and ${MAX_MAX_PAGES}.`);
    next.maxPagesPerScan = n;
  }
  if (body.manualRescansPerDay !== undefined) {
    const n = typeof body.manualRescansPerDay === "number" ? Math.round(body.manualRescansPerDay) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > 50) return bad("Manual rescans per day must be between 1 and 50.");
    next.manualRescansPerDay = n;
  }
  await saveCompetitorsConfig(ctx.workspaceId, next);
  if (next.scanFrequency !== current.scanFrequency) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_settings_changed", { setting: "scanFrequency", from: current.scanFrequency, to: next.scanFrequency });
  }
  if (next.manualRescansPerDay !== current.manualRescansPerDay) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_settings_changed", { setting: "manualRescansPerDay", from: current.manualRescansPerDay, to: next.manualRescansPerDay });
  }
  if (next.maxPagesPerScan !== current.maxPagesPerScan) {
    await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_settings_changed", { setting: "maxPages", from: current.maxPagesPerScan, to: next.maxPagesPerScan });
  }
  return stateResponse(ctx);
}
