import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";

/** Usage rows older than this are purged on every admin read (no cron needed). */
const USAGE_RETENTION_DAYS = 90;

/**
 * Admin → Analytics data for one organization and a time window:
 * - decisions/edits (ReviewEvent) by action and by user, plus the latest rows
 *   with a compact before → after
 * - behaviour (UsageEvent) by event, sessions, searches, filters
 * - imports (IdeaBatch) and the per-product-line correction rate
 */
export async function GET(request: NextRequest) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const orgId = request.nextUrl.searchParams.get("org") ?? "";
  const days = Math.min(365, Math.max(1, parseInt(request.nextUrl.searchParams.get("days") ?? "30", 10) || 30));
  const since = new Date(Date.now() - days * 86_400_000);
  const workspace = await db.workspace.findUnique({ where: { organizationId: orgId }, select: { id: true } });
  if (!workspace) return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });
  const wid = workspace.id;

  await db.usageEvent.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000) } },
  });

  const [reviewRows, usageRows, batches, users, ideaRows, ticketCount] = await Promise.all([
    db.reviewEvent.findMany({
      where: { workspaceId: wid, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { id: true, ideaId: true, action: true, payload: true, userId: true, createdAt: true },
      take: 5000,
    }),
    db.usageEvent.findMany({
      where: { workspaceId: wid, createdAt: { gte: since } },
      select: { event: true, props: true, userId: true, sessionId: true, createdAt: true, path: true },
      take: 20000,
    }),
    db.ideaBatch.findMany({
      where: { workspaceId: wid, startedAt: { gte: since } },
      orderBy: { startedAt: "desc" },
      select: { id: true, startedAt: true, completedAt: true, status: true, error: true, stats: true },
    }),
    db.user.findMany({
      where: { organization: { workspace: { id: wid } } },
      select: { id: true, name: true, email: true },
    }),
    db.idea.findMany({
      where: { workspaceId: wid, batchStatus: { not: "deleted" } },
      select: { id: true, title: true, products: true, decision: true },
    }),
    db.zendeskTicketRaw.count({ where: { workspaceId: wid } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name || u.email]));
  const ideaById = new Map(ideaRows.map((i) => [i.id, i]));

  // Decisions and edits
  const byAction = new Map<string, number>();
  const byUser = new Map<string, number>();
  const touchedIdeas = new Set<string>();
  const EDIT_ACTIONS = new Set(["edit", "reassign", "rewrite", "keep_text", "dismiss_customer", "approve_customer", "undismiss_customer", "create_from_ticket"]);
  for (const r of reviewRows) {
    byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
    const u = r.userId ? (userName.get(r.userId) ?? "unknown") : "—";
    byUser.set(u, (byUser.get(u) ?? 0) + 1);
    if (EDIT_ACTIONS.has(r.action)) touchedIdeas.add(r.ideaId);
  }
  // Correction rate per product line: ideas a PM changed / ideas in that line
  const perLine = new Map<string, { ideas: number; corrected: number; approved: number }>();
  for (const i of ideaRows) {
    for (const p of ((i.products as string[]) ?? ["Other"]).length ? ((i.products as string[]) ?? []) : ["Other"]) {
      const row = perLine.get(p) ?? { ideas: 0, corrected: 0, approved: 0 };
      row.ideas += 1;
      if (touchedIdeas.has(i.id)) row.corrected += 1;
      if (i.decision !== "pending") row.approved += 1;
      perLine.set(p, row);
    }
  }
  const latest = reviewRows.slice(0, 300).map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    user: r.userId ? (userName.get(r.userId) ?? "unknown") : "—",
    action: r.action,
    ideaId: r.ideaId,
    idea: ideaById.get(r.ideaId)?.title ?? "(deleted idea)",
    payload: r.payload ?? null,
  }));

  // Behaviour
  const byEvent = new Map<string, number>();
  const sessions = new Set<string>();
  const activeUsers = new Set<string>();
  const searches = new Map<string, number>();
  const filters = new Map<string, number>();
  const pages = new Map<string, number>();
  for (const u of usageRows) {
    byEvent.set(u.event, (byEvent.get(u.event) ?? 0) + 1);
    if (u.sessionId) sessions.add(`${u.sessionId}:${u.createdAt.toISOString().slice(0, 10)}`);
    if (u.userId) activeUsers.add(u.userId);
    const props = (u.props ?? {}) as Record<string, unknown>;
    if (u.event === "search" && typeof props.query === "string") {
      const q = props.query.toLowerCase();
      searches.set(q, (searches.get(q) ?? 0) + 1);
    }
    if (u.event === "filter" && typeof props.kind === "string") {
      filters.set(props.kind, (filters.get(props.kind) ?? 0) + 1);
    }
    if (u.event === "page_view" && typeof props.name === "string") {
      pages.set(props.name, (pages.get(props.name) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, n = 15) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));

  // Imports
  const imports = batches.map((b) => {
    const stats = (b.stats ?? {}) as Record<string, unknown>;
    return {
      id: b.id,
      at: b.startedAt.toISOString(),
      status: b.status,
      error: b.error,
      ms: b.completedAt ? b.completedAt.getTime() - b.startedAt.getTime() : null,
      tickets: typeof stats.uploaded === "number" ? stats.uploaded : typeof stats.fresh === "number" ? stats.fresh : null,
    };
  });
  const durations = imports.filter((i) => i.ms != null).map((i) => i.ms as number).sort((a, b) => a - b);

  return NextResponse.json({
    days,
    since: since.toISOString(),
    totals: {
      ideas: ideaRows.length,
      tickets: ticketCount,
      reviewEvents: reviewRows.length,
      usageEvents: usageRows.length,
      sessions: sessions.size,
      activeUsers: activeUsers.size,
      ideasTouched: touchedIdeas.size,
      approved: ideaRows.filter((i) => i.decision !== "pending").length,
    },
    decisions: { byAction: top(byAction, 40), byUser: top(byUser, 20), latest },
    behaviour: { byEvent: top(byEvent, 40), pages: top(pages), searches: top(searches), filters: top(filters) },
    imports: {
      runs: imports.length,
      failed: imports.filter((i) => i.status === "failed" || i.status === "aborted").length,
      medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      latest: imports.slice(0, 20),
    },
    correction: Array.from(perLine.entries())
      .map(([line, v]) => ({ line, ...v, rate: v.ideas ? Math.round((100 * v.corrected) / v.ideas) : 0 }))
      .sort((a, b) => b.ideas - a.ideas),
  });
}
