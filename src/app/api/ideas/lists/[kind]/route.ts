import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { db } from "@/lib/db";

const ITEM_SELECT = { id: true, name: true, description: true } as const;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 1000;

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
  create(workspaceId: string, name: string, description: string): Promise<unknown>;
  update(id: string, name: string, description: string): Promise<unknown>;
  remove(workspaceId: string, id: string): Promise<number>;
}

const KINDS: Record<string, ListOps> = {
  "product-lines": {
    list: (workspaceId) =>
      db.productLine.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, select: ITEM_SELECT }),
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
    create: (workspaceId, name, description) =>
      db.productLine.create({ data: { workspaceId, name, description } }),
    update: (id, name, description) =>
      db.productLine.update({ where: { id }, data: { name, description } }),
    remove: async (workspaceId, id) =>
      (await db.productLine.deleteMany({ where: { id, workspaceId } })).count,
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
    create: (workspaceId, name, description) =>
      db.platform.create({ data: { workspaceId, name, description } }),
    update: (id, name, description) =>
      db.platform.update({ where: { id }, data: { name, description } }),
    remove: async (workspaceId, id) =>
      (await db.platform.deleteMany({ where: { id, workspaceId } })).count,
  },
};

type RouteContext = { params: Promise<{ kind: string }> };

async function guard(context: RouteContext): Promise<{ ops: ListOps; workspaceId: string } | NextResponse> {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const { kind } = await context.params;
  const ops = KINDS[kind];
  if (!ops) return NextResponse.json({ error: "Unknown list" }, { status: 404 });
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;
  return { ops, workspaceId: workspaceResult };
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
  const auth = await guard(context);
  if (auth instanceof NextResponse) return auth;
  const { ops, workspaceId } = auth;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (name instanceof NextResponse) return name;

  if (await ops.nameTaken(workspaceId, name)) {
    return NextResponse.json({ error: `"${name}" already exists` }, { status: 409 });
  }

  await ops.create(workspaceId, name, cleanDescription(body.description));
  return NextResponse.json({ items: await ops.list(workspaceId) });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await guard(context);
  if (auth instanceof NextResponse) return auth;
  const { ops, workspaceId } = auth;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id || !(await ops.exists(workspaceId, id))) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  const name = cleanName(body.name);
  if (name instanceof NextResponse) return name;

  if (await ops.nameTaken(workspaceId, name, id)) {
    return NextResponse.json({ error: `"${name}" already exists` }, { status: 409 });
  }

  await ops.update(id, name, cleanDescription(body.description));
  return NextResponse.json({ items: await ops.list(workspaceId) });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await guard(context);
  if (auth instanceof NextResponse) return auth;
  const { ops, workspaceId } = auth;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const id = typeof body.id === "string" ? body.id : "";
  const count = id ? await ops.remove(workspaceId, id) : 0;
  if (count === 0) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  return NextResponse.json({ items: await ops.list(workspaceId) });
}
