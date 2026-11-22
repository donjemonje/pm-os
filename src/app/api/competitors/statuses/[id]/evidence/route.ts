import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rankEvidence, type Evidence } from "@/lib/competitors/analysis/cells";
import { loadReadingPlan } from "@/lib/competitors/analysis/plan";
import { bad, competitorsGuard } from "@/lib/competitors/api";

type Params = { params: Promise<{ id: string }> };

/** Entries returned at most. */
const MAX_EVIDENCE = 50;

/**
 * GET every piece of evidence behind one cell, best first — any member of the org.
 *   /api/competitors/statuses/<cellId>/evidence               a capability cell
 *   /api/competitors/statuses/<cellId>/evidence?kind=feature  a feature cell
 * → { evidence: [{ quote, url, title, reasoning, wording, tier }] }
 *
 * The evidence is not copied on the cell: it is the proofs of the competitor's items matched to the row (for a
 * capability also the proofs of its items on the row's active features — a company that has any feature of a row
 * has the row — and second-look findings that answer it). `reasoning` is "" for everything the chunked reading
 * found (the description covers it); a finding of the old per-page reading still carries one.
 */
export async function GET(req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const feature = new URL(req.url).searchParams.get("kind") === "feature";
  let where;
  if (feature) {
    const cell = await db.featureStatus.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { competitorId: true, featureId: true } });
    if (!cell) return bad("Not found", 404);
    where = { competitorId: cell.competitorId, item: { featureId: cell.featureId } };
  } else {
    const cell = await db.capabilityStatus.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { competitorId: true, capabilityId: true } });
    if (!cell) return bad("Not found", 404);
    const features = await db.feature.findMany({ where: { capabilityId: cell.capabilityId, state: "active" }, select: { id: true } });
    where = {
      competitorId: cell.competitorId,
      OR: [
        { item: { capabilityId: cell.capabilityId } },
        ...(features.length ? [{ item: { featureId: { in: features.map((f) => f.id) } } }] : []),
        { origin: "second_look", capabilityId: cell.capabilityId },
      ],
    };
  }
  const findings = await db.pageFinding.findMany({
    where,
    select: { id: true, origin: true, quote: true, reasoning: true, description: true, wording: true, item: { select: { name: true } }, page: { select: { url: true, title: true, kind: true, sourceId: true, readAs: true, source: { select: { type: true } } } } },
  });
  // A finding's tier and kind come from its page's place in the competitor's reading plan, as when the cell was filled.
  const plan = await loadReadingPlan(where.competitorId);
  const titleOf = new Map(findings.map((f) => [f.page.url, f.page.title]));
  const evidence: Evidence[] = [];
  for (const f of findings) {
    const t = plan.read({ url: f.page.url, sourceId: f.page.sourceId, sourceType: f.page.source.type, kind: f.page.kind, readAs: f.page.readAs });
    if (t.tier === "skip") continue;
    evidence.push({ findingId: f.id, pageUrl: f.page.url, tier: t.tier, pageKind: t.kind, origin: f.origin === "second_look" ? "second_look" : "reading", quote: f.quote, reasoning: f.reasoning, wording: f.item?.name ?? f.wording, description: f.description });
  }
  return NextResponse.json({
    evidence: rankEvidence(evidence)
      .slice(0, MAX_EVIDENCE)
      .map((e) => ({ quote: e.quote, url: e.pageUrl, title: titleOf.get(e.pageUrl) ?? null, reasoning: e.reasoning, wording: e.wording, tier: e.tier })),
  });
}
