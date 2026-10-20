import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";

/**
 * The whole decisions-and-edits ledger of one organization for a window, as
 * CSV — every row, no cap, flattened plus the raw payload. Daniel feeds this
 * to Claude to learn where PMOS AI was wrong (2026-10-20).
 */
export async function GET(request: NextRequest) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const orgId = request.nextUrl.searchParams.get("org") ?? "";
  const days = Math.min(3650, Math.max(1, parseInt(request.nextUrl.searchParams.get("days") ?? "30", 10) || 30));
  const since = new Date(Date.now() - days * 86_400_000);
  const workspace = await db.workspace.findUnique({ where: { organizationId: orgId }, select: { id: true } });
  if (!workspace) return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });

  const [events, users, ideas] = await Promise.all([
    db.reviewEvent.findMany({
      where: { workspaceId: workspace.id, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, userId: true, action: true, ideaId: true, payload: true },
    }),
    db.user.findMany({ where: { organization: { workspace: { id: workspace.id } } }, select: { id: true, name: true, email: true } }),
    db.idea.findMany({
      where: { workspaceId: workspace.id },
      select: {
        id: true,
        title: true,
        products: true,
        decision: true,
        batchStatus: true,
        origin: true,
        sources: { select: { kind: true, jiraKey: true, ticket: { select: { externalId: true } } } },
      },
    }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name || u.email]));
  const ideaById = new Map(ideas.map((i) => [i.id, i]));

  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String).join(" | ") : "");
  const side = (p: unknown, which: "before" | "after") =>
    ((p ?? {}) as Record<string, Record<string, unknown> | undefined>)[which] ?? {};
  const header = [
    "at", "user", "action", "idea_id", "idea_title_now", "idea_products_now", "idea_sources_now", "idea_status_now", "idea_decision_now", "idea_origin",
    "title_before", "title_after", "text_before", "text_after", "products_before", "products_after",
    "customers_added", "customers_removed", "sources_before", "sources_after", "customer_name", "payload_json",
  ];
  const rows = events.map((e) => {
    const idea = ideaById.get(e.ideaId);
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const b = side(e.payload, "before"), a = side(e.payload, "after");
    const isEdit = e.action === "edit", isReassign = e.action === "reassign";
    const src = (o: Record<string, unknown>) =>
      list([...(((o.zen as string[]) ?? []).map((k) => `ZEN-${k}`)), ...((o.jira as string[]) ?? [])]);
    const ideaSources = idea
      ? list(idea.sources.map((s) => (s.kind === "zendesk" && s.ticket ? `ZEN-${s.ticket.externalId}` : s.jiraKey ?? "")).filter(Boolean))
      : "";
    return [
      e.createdAt.toISOString(),
      e.userId ? (userName.get(e.userId) ?? "unknown") : "",
      e.action,
      e.ideaId,
      idea?.title ?? "(deleted idea)",
      idea ? list(idea.products) : "",
      ideaSources,
      idea?.batchStatus ?? "",
      idea?.decision ?? "",
      idea?.origin ?? "",
      isEdit ? String(b.title ?? "") : "",
      isEdit ? String(a.title ?? "") : "",
      isEdit && b.details !== a.details ? String(b.details ?? "") : "",
      isEdit && b.details !== a.details ? String(a.details ?? "") : "",
      isEdit ? list(b.products) : "",
      isEdit ? list(a.products) : "",
      isEdit
        ? list(((a.addedCustomers as string[]) ?? []).filter((c) => !((b.addedCustomers as string[]) ?? []).includes(c)))
        : e.action === "approve_customer" || e.action === "undismiss_customer" ? String(p.name ?? "") : "",
      isEdit
        ? list([
            ...((b.addedCustomers as string[]) ?? []).filter((c) => !((a.addedCustomers as string[]) ?? []).includes(c)),
            ...((a.removedCustomers as string[]) ?? []),
          ])
        : e.action === "dismiss_customer" ? String(p.name ?? "") : "",
      isReassign ? src(b) : "",
      isReassign ? src(a) : "",
      typeof p.name === "string" ? p.name : "",
      JSON.stringify(e.payload ?? {}),
    ]
      .map(esc)
      .join(",");
  });
  const csv = "﻿" + [header.join(","), ...rows].join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pmos-ledger-${orgId}-${days}d.csv"`,
    },
  });
}
