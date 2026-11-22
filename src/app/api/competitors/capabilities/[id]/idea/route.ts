import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bad, competitorsGuard, stateResponse } from "@/lib/competitors/api";
import { competitorsPartOff } from "@/lib/competitors/parts-server";
import { recordCompetitorEvent } from "@/lib/competitors/analytics";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
import { mutateIdeas } from "@/lib/ideas/store";

type Params = { params: Promise<{ id: string }> };

/**
 * POST: create an Idea from a roadmap row (a gap). The
 * idea is a manual idea titled after the capability; its details carry the
 * evidence — every competitor that has the capability, with the quote and the
 * page it came from. One idea per capability: a second press returns the row
 * as it is.
 */
export async function POST(_req: Request, { params }: Params) {
  const ctx = await competitorsGuard();
  if (ctx instanceof NextResponse) return ctx;
  const off = await competitorsPartOff("roadmap");
  if (off) return off;
  if (!(await ideasEnabledForCurrentUser())) return bad(C.roadmap.ideasOff, 403);
  const { id } = await params;
  const capability = await db.capability.findFirst({
    where: { id, workspaceId: ctx.workspaceId, state: "active" },
    include: {
      domain: { select: { name: true } },
      statuses: { include: { competitor: { select: { name: true, host: true } } } },
      ideas: { select: { ideaId: true } },
    },
  });
  if (!capability) return bad("Not found", 404);
  if (capability.ideas.length > 0) return stateResponse(ctx);

  const evidence = capability.statuses
    .map((s) => ({ s, value: (s.overrideValue ?? s.value) as string }))
    .filter(({ value }) => value === "found" || value === "low")
    .sort((a, b) => a.s.competitor.name.localeCompare(b.s.competitor.name));
  const lines = evidence.map(({ s, value }) => {
    const bits = [`${s.competitor.name}: ${value === "found" ? C.values.found : C.values.low}`];
    if (s.product) bits.push(s.product);
    if (s.quote) bits.push(`“${s.quote}”`);
    if (s.sourceUrl) bits.push(s.sourceUrl);
    return `- ${bits.join(" — ")}`;
  });
  const productLines = Array.isArray(capability.productLines) ? (capability.productLines as string[]) : [];
  const details = [
    C.roadmap.ideaIntro(ctx.orgName, capability.name, capability.domain.name, C.values[capability.ourStatus] ?? capability.ourStatus),
    capability.description ? `\n${capability.description}` : "",
    `\n${C.roadmap.ideaEvidence(evidence.length)}`,
    ...lines,
  ].filter(Boolean).join("\n");

  await mutateIdeas(ctx.workspaceId, {
    type: "createIdea",
    title: capability.name,
    details,
    manual: null,
    products: productLines,
    platforms: [],
    addedCustomers: [],
    zen: [],
    jira: [],
  }, ctx.user.id);
  // mutateIdeas returns the whole state, not the new row: it is the newest manual idea with this title.
  const idea = await db.idea.findFirst({ where: { workspaceId: ctx.workspaceId, title: capability.name, origin: "manual" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!idea) return bad(C.roadmap.ideaFailed, 500);
  await db.capabilityIdea.create({ data: { capabilityId: id, ideaId: idea.id, origin: "created" } });
  await recordCompetitorEvent(ctx.workspaceId, ctx.user.id, "cmp_roadmap_idea_created", { capabilityId: id, ideaId: idea.id, evidence: evidence.length, kind: "gap" });
  return stateResponse(ctx, 201);
}
