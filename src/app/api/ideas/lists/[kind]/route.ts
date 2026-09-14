import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { isPmosAdmin } from "@/lib/admin-auth";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isChipColorId, nextChipColor } from "@/lib/ideas/colors";
import { isAllCustomers } from "@/lib/ideas/customer-key";

const ITEM_SELECT = { id: true, name: true, description: true, color: true } as const;
const CUSTOMER_SELECT = { ...ITEM_SELECT, aliases: true } as const;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 2000;

export interface ListItem {
  id: string;
  name: string;
  description: string;
}

/** Per-kind DB ops; Prisma delegates differ in type, so each kind binds its own. */
interface ListOps {
  list(workspaceId: string): Promise<ListItem[]>;
  /** Case-insensitive duplicate check within the workspace, optionally excluding one row. */
  nameTaken(workspaceId: string, name: string, excludeId?: string): Promise<boolean>;
  exists(workspaceId: string, id: string): Promise<boolean>;
  /** All colors in use — the next new row gets the least-used palette color. */
  colors(workspaceId: string): Promise<(string | null)[]>;
  create(workspaceId: string, name: string, description: string, color: string): Promise<unknown>;
  /** `color` undefined = unchanged. */
  update(id: string, name: string, description: string, color?: string): Promise<unknown>;
  setColor(id: string, color: string): Promise<unknown>;
  remove(workspaceId: string, id: string): Promise<number>;
}

const KINDS: Record<string, ListOps> = {
  "product-lines": {
    list: (workspaceId) =>
      db.productLine.findMany({
        where: { workspaceId },
        orderBy: [{ position: "asc" }, { name: "asc" }],
        select: ITEM_SELECT,
      }),
    nameTaken: async (workspaceId, name, excludeId) =>
      Boolean(
        await db.productLine.findFirst({
          where: {
            workspaceId,
            name: { equals: name, mode: "insensitive" },
            ...(excludeId ? { id: { not: excludeId } } : {}),
          },
          select: { id: true },
        })
      ),
    exists: async (workspaceId, id) =>
      Boolean(await db.productLine.findFirst({ where: { id, workspaceId }, select: { id: true } })),
    colors: async (workspaceId) =>
      (await db.productLine.findMany({ where: { workspaceId }, select: { color: true } })).map((r) => r.color),
    create: async (workspaceId, name, description, color) => {
      const last = await db.productLine.findFirst({
        where: { workspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      return db.productLine.create({
        data: { workspaceId, name, description, color, position: (last?.position ?? -1) + 1 },
      });
    },
    update: (id, name, description, color) =>
      db.productLine.update({ where: { id }, data: { name, description, ...(color ? { color } : {}) } }),
    setColor: (id, color) => db.productLine.update({ where: { id }, data: { color } }),
    remove: async (workspaceId, id) =>
      (await db.productLine.deleteMany({ where: { id, workspaceId } })).count,
  },
  customers: {
    list: (workspaceId) =>
      db.customer.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, select: CUSTOMER_SELECT }),
    nameTaken: async (workspaceId, name, excludeId) =>
      Boolean(
        await db.customer.findFirst({
          where: {
            workspaceId,
            name: { equals: name, mode: "insensitive" },
            ...(excludeId ? { id: { not: excludeId } } : {}),
          },
          select: { id: true },
        })
      ),
    exists: async (workspaceId, id) =>
      Boolean(await db.customer.findFirst({ where: { id, workspaceId }, select: { id: true } })),
    colors: async (workspaceId) =>
      (await db.customer.findMany({ where: { workspaceId }, select: { color: true } })).map((r) => r.color),
    create: (workspaceId, name, description, color) =>
      db.customer.create({ data: { workspaceId, name, description, color } }),
    update: (id, name, description, color) =>
      db.customer.update({ where: { id }, data: { name, description, ...(color ? { color } : {}) } }),
    setColor: (id, color) => db.customer.update({ where: { id }, data: { color } }),
    remove: async (workspaceId, id) =>
      (await db.customer.deleteMany({ where: { id, workspaceId } })).count,
  },
  platforms: {
    list: (workspaceId) =>
      db.platform.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, select: ITEM_SELECT }),
    nameTaken: async (workspaceId, name, excludeId) =>
      Boolean(
        await db.platform.findFirst({
          where: {
            workspaceId,
            name: { equals: name, mode: "insensitive" },
            ...(excludeId ? { id: { not: excludeId } } : {}),
          },
          select: { id: true },
        })
      ),
    exists: async (workspaceId, id) =>
      Boolean(await db.platform.findFirst({ where: { id, workspaceId }, select: { id: true } })),
    colors: async () => [],
    create: (workspaceId, name, description) =>
      db.platform.create({ data: { workspaceId, name, description } }),
    update: (id, name, description) =>
      db.platform.update({ where: { id }, data: { name, description } }),
    setColor: async () => undefined,
    remove: async (workspaceId, id) =>
      (await db.platform.deleteMany({ where: { id, workspaceId } })).count,
  },
};

type RouteContext = { params: Promise<{ kind: string }> };

async function guard(
  context: RouteContext,
  opts: { write?: boolean; colorOnly?: boolean } = {}
): Promise<{ ops: ListOps; kind: string; workspaceId: string } | NextResponse> {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const { kind } = await context.params;
  const ops = KINDS[kind];
  if (!ops) return NextResponse.json({ error: "Unknown list" }, { status: 404 });
  // Product lines are the AI's ground truth: readable by everyone in the
  // workspace, changed only by a PM-OS admin. The chip color is
  // presentation, not ground truth — any workspace user may pick it.
  if (
    opts.write &&
    !opts.colorOnly &&
    kind === "product-lines" &&
    !isPmosAdmin(await getCurrentUser())
  ) {
    return NextResponse.json(
      { error: "Only a PM-OS admin can change product lines" },
      { status: 403 }
    );
  }
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  return { ops, kind, workspaceId: workspaceResult };
}

async function readJson(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") throw new Error();
    return body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}

function cleanName(value: unknown): string | NextResponse {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (name.length > MAX_NAME) {
    return NextResponse.json({ error: `Name must be under ${MAX_NAME} characters` }, { status: 400 });
  }
  return name;
}

function cleanDescription(value: unknown): string {
  const description = typeof value === "string" ? value.trim() : "";
  return description.slice(0, MAX_DESCRIPTION);
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const auth = await guard(context);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ items: await auth.ops.list(auth.workspaceId) });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await guard(context, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { ops, workspaceId } = auth;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (name instanceof NextResponse) return name;

  if (await ops.nameTaken(workspaceId, name)) {
    return NextResponse.json({ error: `"${name}" already exists` }, { status: 409 });
  }

  const color = isChipColorId(body.color)
    ? body.color
    : nextChipColor(await ops.colors(workspaceId));
  await ops.create(workspaceId, name, cleanDescription(body.description), color);
  return NextResponse.json({ items: await ops.list(workspaceId) });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  // { id, color } alone is a color pick — allowed for every workspace user.
  const colorOnly =
    isChipColorId(body.color) && body.name === undefined && body.description === undefined;
  const auth = await guard(context, { write: true, colorOnly });
  if (auth instanceof NextResponse) return auth;
  const { ops, workspaceId } = auth;

  const id = typeof body.id === "string" ? body.id : "";
  if (!id || !(await ops.exists(workspaceId, id))) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (colorOnly) {
    await ops.setColor(id, body.color as string);
    return NextResponse.json({ items: await ops.list(workspaceId) });
  }
  const name = cleanName(body.name);
  if (name instanceof NextResponse) return name;

  if (await ops.nameTaken(workspaceId, name, id)) {
    return NextResponse.json({ error: `"${name}" already exists` }, { status: 409 });
  }

  await ops.update(
    id,
    name,
    cleanDescription(body.description),
    isChipColorId(body.color) ? body.color : undefined,
  );
  return NextResponse.json({ items: await ops.list(workspaceId) });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await guard(context, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { ops, kind, workspaceId } = auth;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const id = typeof body.id === "string" ? body.id : "";
  if (kind === "customers" && id) {
    const row = await db.customer.findFirst({ where: { id, workspaceId }, select: { name: true } });
    if (row && isAllCustomers(row.name)) {
      return NextResponse.json(
        { error: "All Customers is built in and can't be deleted" },
        { status: 400 },
      );
    }
  }
  const count = id ? await ops.remove(workspaceId, id) : 0;
  if (count === 0) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  return NextResponse.json({ items: await ops.list(workspaceId) });
}

/** Reorder — product lines only: body { order: [id, …] } sets positions by index. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = await guard(context, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { ops, kind, workspaceId } = auth;
  if (kind !== "product-lines") {
    return NextResponse.json({ error: "This list has no manual order" }, { status: 400 });
  }

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const order = Array.isArray(body.order) ? body.order.filter((x) => typeof x === "string") : [];
  const rows = await db.productLine.findMany({ where: { workspaceId }, select: { id: true } });
  const known = new Set(rows.map((r) => r.id));
  if (
    order.length !== rows.length ||
    new Set(order).size !== rows.length ||
    !order.every((id) => known.has(id as string))
  ) {
    return NextResponse.json({ error: "Order must list every product line once" }, { status: 400 });
  }
  await db.$transaction(
    order.map((id, index) =>
      db.productLine.update({ where: { id: id as string }, data: { position: index } })
    )
  );
  return NextResponse.json({ items: await ops.list(workspaceId) });
}
