import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rankEvidence, type Evidence } from "@/lib/competitors/analysis/cells";
import { pageTier } from "@/lib/competitors/analysis/kinds";
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
 * The evidence is not copied on the cell: it is the findings of the competitor's items matched to the row (for a
 * capability also the findings of its active features, and second-look findings that answer it).
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
    select: { id: true, origin: true, quote: true, reasoning: true, wording: true, item: { select: { name: true } }, page: { select: { url: true, title: true, kind: true, source: { select: { type: true } } } } },
  });
  const titleOf = new Map(findings.map((f) => [f.page.url, f.page.title]));
  const evidence: Evidence[] = [];
  for (const f of findings) {
    const t = pageTier(f.page.url, f.page.source.type, f.page.kind);
    if (t.tier === "skip") continue;
    evidence.push({ findingId: f.id, pageUrl: f.page.url, tier: t.tier, pageKind: t.kind, origin: f.origin === "second_look" ? "second_look" : "research", quote: f.quote, reasoning: f.reasoning, wording: f.item?.name ?? f.wording });
  }
  return NextResponse.json({
    evidence: rankEvidence(evidence)
      .slice(0, MAX_EVIDENCE)
      .map((e) => ({ quote: e.quote, url: e.pageUrl, title: titleOf.get(e.pageUrl) ?? null, reasoning: e.reasoning, wording: e.wording, tier: e.tier })),
  });
}
