import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { nextChipColor } from "@/lib/ideas/colors";
import { isAllCustomers } from "@/lib/ideas/customer-key";

/**
 * Merge two customers that are the same company under different spellings
 * (Settings → Customers). The kept customer absorbs the other's name as an
 * alias; every ticket and idea reference is rewritten to the kept name; the
 * other row is deleted. Reversible: "unmerge" turns an alias back into a
 * customer (references stay with the kept name — the PM re-assigns if the
 * split was about evidence, not spelling).
 *
 * POST { action: "merge", keepId, mergeId } | { action: "unmerge", id, alias }
 */

const ITEM_SELECT = { id: true, name: true, description: true, color: true, aliases: true } as const;

function renameIn(list: unknown, from: string, to: string): string[] {
  const arr = Array.isArray(list) ? (list as string[]) : [];
  const out: string[] = [];
  for (const v of arr) {
    const next = v.toLowerCase() === from.toLowerCase() ? to : v;
    if (!out.some((x) => x.toLowerCase() === next.toLowerCase())) out.push(next);
  }
  return out;
}

/** Rewrite one spelling to another across the workspace's tickets and ideas. */
async function renameReferences(workspaceId: string, from: string, to: string): Promise<void> {
  const tickets = await db.zendeskTicketRaw.findMany({
    where: { workspaceId },
    select: { id: true, affectedCustomers: true, dismissedCustomers: true },
  });
  for (const t of tickets) {
    const affected = renameIn(t.affectedCustomers, from, to);
    const dismissed = renameIn(t.dismissedCustomers, from, to);
    if (
      JSON.stringify(affected) !== JSON.stringify(t.affectedCustomers) ||
      JSON.stringify(dismissed) !== JSON.stringify(t.dismissedCustomers)
    ) {
      await db.zendeskTicketRaw.update({
        where: { id: t.id },
        data: {
          affectedCustomers: affected as Prisma.InputJsonValue,
          dismissedCustomers: dismissed as Prisma.InputJsonValue,
        },
      });
    }
  }
  const ideas = await db.idea.findMany({
    where: { workspaceId },
    select: { id: true, addedCustomers: true },
  });
  for (const i of ideas) {
    const added = renameIn(i.addedCustomers, from, to);
    if (JSON.stringify(added) !== JSON.stringify(i.addedCustomers)) {
      await db.idea.update({
        where: { id: i.id },
        data: { addedCustomers: added as Prisma.InputJsonValue },
      });
    }
  }
}

export async function POST(request: NextRequest) {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceId = await apiWorkspaceId();
  if (workspaceId instanceof NextResponse) return workspaceId;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "merge") {
    const keepId = typeof body.keepId === "string" ? body.keepId : "";
    const mergeId = typeof body.mergeId === "string" ? body.mergeId : "";
    if (!keepId || !mergeId || keepId === mergeId) {
      return NextResponse.json({ error: "Pick two different customers" }, { status: 400 });
    }
    const [keep, merge] = await Promise.all([
      db.customer.findFirst({ where: { id: keepId, workspaceId } }),
      db.customer.findFirst({ where: { id: mergeId, workspaceId } }),
    ]);
    if (!keep || !merge) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    // The built-in All Customers row is neither absorbed nor absorbing.
    if (isAllCustomers(keep.name) || isAllCustomers(merge.name)) {
      return NextResponse.json(
        { error: "All Customers is built in and can't be merged" },
        { status: 400 },
      );
    }
    const aliases = Array.from(
      new Set([
        ...((keep.aliases as string[]) ?? []),
        merge.name,
        ...((merge.aliases as string[]) ?? []),
      ]),
    ).filter((a) => a.toLowerCase() !== keep.name.toLowerCase());
    await renameReferences(workspaceId, merge.name, keep.name);
    await db.customer.update({
      where: { id: keep.id },
      data: { aliases: aliases as Prisma.InputJsonValue },
    });
    await db.customer.delete({ where: { id: merge.id } });
  } else if (body.action === "unmerge") {
    const id = typeof body.id === "string" ? body.id : "";
    const alias = typeof body.alias === "string" ? body.alias.trim() : "";
    const keep = id ? await db.customer.findFirst({ where: { id, workspaceId } }) : null;
    if (!keep || !alias) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    const aliases = ((keep.aliases as string[]) ?? []).filter(
      (a) => a.toLowerCase() !== alias.toLowerCase(),
    );
    const clash = await db.customer.findFirst({
      where: { workspaceId, name: { equals: alias, mode: "insensitive" } },
      select: { id: true },
    });
    if (clash) return NextResponse.json({ error: `"${alias}" already exists` }, { status: 409 });
    const used = (
      await db.customer.findMany({ where: { workspaceId }, select: { color: true } })
    ).map((c) => c.color);
    await db.customer.update({
      where: { id: keep.id },
      data: { aliases: aliases as Prisma.InputJsonValue },
    });
    await db.customer.create({
      data: { workspaceId, name: alias, description: "", color: nextChipColor(used) },
    });
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const items = await db.customer.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    select: ITEM_SELECT,
  });
  return NextResponse.json({ items });
}
