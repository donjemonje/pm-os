import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { canManageOrgSettings } from "@/lib/admin-auth";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isChipColorId, nextChipColor } from "@/lib/ideas/colors";
import { customerKey, isAllCustomers } from "@/lib/ideas/customer-key";
import { productLineKey } from "@/lib/ideas/product-line-key";

const ITEM_SELECT = { id: true, name: true, description: true, color: true } as const;
const CUSTOMER_SELECT = { ...ITEM_SELECT, aliases: true } as const;
/** Product lines carry aliases too (other spellings, the Jira option name). */
const PRODUCT_LINE_SELECT = { ...ITEM_SELECT, aliases: true } as const;
const MAX_ALIASES = 20;
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
  create(
    workspaceId: string,
    name: string,
    description: string,
    color: string,
    aliases?: string[]
  ): Promise<unknown>;
  /** `color` undefined = unchanged; `aliases` undefined = unchanged (product lines only). */
  update(
    id: string,
    name: string,
    description: string,
    color?: string,
    aliases?: string[]
  ): Promise<unknown>;
  setColor(id: string, color: string): Promise<unknown>;
  remove(workspaceId: string, id: string): Promise<number>;
}

const KINDS: Record<string, ListOps> = {
  "product-lines": {
    list: (workspaceId) =>
      db.productLine.findMany({
        where: { workspaceId },
        orderBy: [{ position: "asc" }, { name: "asc" }],
        select: PRODUCT_LINE_SELECT,
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
    create: async (workspaceId, name, description, color, aliases) => {
      const last = await db.productLine.findFirst({
        where: { workspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      return db.productLine.create({
        data: {
          workspaceId,
          name,
          description,
          color,
          position: (last?.position ?? -1) + 1,
          aliases: aliases ?? [],
        },
      });
    },
    update: (id, name, description, color, aliases) =>
      db.productLine.update({
        where: { id },
        data: { name, description, ...(color ? { color } : {}), ...(aliases ? { aliases } : {}) },
      }),
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
    create: (workspaceId, name, description, color, aliases) =>
      db.customer.create({ data: { workspaceId, name, description, color, aliases: aliases ?? [] } }),
    update: (id, name, description, color, aliases) =>
      db.customer.update({
        where: { id },
        data: { name, description, ...(color ? { color } : {}), ...(aliases ? { aliases } : {}) },
      }),
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
  // workspace, changed only by an admin (the org's customer admin or a
  // PM-OS admin). The chip color is presentation, not ground truth — any
  // workspace user may pick it.
  if (
    opts.write &&
    !opts.colorOnly &&
    kind === "product-lines" &&
    !canManageOrgSettings(await getCurrentUser())
  ) {
    return NextResponse.json(
      { error: "Only an admin can change product lines" },
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

/** Aliases: array or comma-separated string → trimmed, deduped, the name itself dropped. */
function cleanAliases(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>([name.toLowerCase()]);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const a = v.trim().slice(0, MAX_NAME);
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/** An alias (or the name) may not collide with another product line's name or aliases —
 *  the resolver is first-wins, so a collision would route a Module value by sort order. */
async function aliasClash(
  workspaceId: string,
  aliases: string[],
  name: string,
  excludeId?: string
): Promise<string | null> {
  const rows = await db.productLine.findMany({
    where: { workspaceId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { name: true, aliases: true },
  });
  const mine = [name, ...aliases].map((a) => productLineKey(a));
  for (const r of rows) {
    const theirs = [r.name, ...(Array.isArray(r.aliases) ? (r.aliases as string[]) : [])];
    for (const t of theirs) {
      if (mine.includes(productLineKey(t))) {
        return `"${t}" already belongs to product line "${r.name}" — a name or alias can only mean one product line`;
      }
    }
  }
  return null;
}

/** A customer alias (or name) may not be another customer's name or alias — same first-wins reason. */
async function customerAliasClash(
  workspaceId: string,
  aliases: string[],
  name: string,
  excludeId?: string
): Promise<string | null> {
  const rows = await db.customer.findMany({
    where: { workspaceId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { name: true, aliases: true },
  });
  const mine = [name, ...aliases].map((a) => customerKey(a));
  for (const r of rows) {
    const theirs = [r.name, ...(Array.isArray(r.aliases) ? (r.aliases as string[]) : [])];
    for (const t of theirs) {
      if (mine.includes(customerKey(t))) {
        return `"${t}" already belongs to customer "${r.name}" — a name or alias can only mean one customer`;
      }
    }
  }
  return null;
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
  const { ops, kind, workspaceId } = auth;

  const body = await readJson(request);
  if (body instanceof NextResponse) return body;
  const name = cleanName(body.name);
  if (name instanceof NextResponse) return name;

  if (await ops.nameTaken(workspaceId, name)) {
    return NextResponse.json({ error: `"${name}" already exists` }, { status: 409 });
  }
  if (kind === "product-lines") {
    const clash = await aliasClash(workspaceId, cleanAliases(body.aliases, name) ?? [], name);
    if (clash) return NextResponse.json({ error: clash }, { status: 409 });
  }
  if (kind === "customers") {
    const clash = await customerAliasClash(workspaceId, cleanAliases(body.aliases, name) ?? [], name);
    if (clash) return NextResponse.json({ error: clash }, { status: 409 });
  }

  const color = isChipColorId(body.color)
    ? body.color
    : nextChipColor(await ops.colors(workspaceId));
  await ops.create(
    workspaceId,
    name,
    cleanDescription(body.description),
    color,
    kind === "product-lines" || kind === "customers" ? cleanAliases(body.aliases, name) : undefined
  );
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
  const { ops, kind, workspaceId } = auth;

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

  if (kind === "customers") {
    const row = await db.customer.findFirst({ where: { id, workspaceId }, select: { name: true } });
    if (row && isAllCustomers(row.name) && !isAllCustomers(name)) {
      return NextResponse.json(
        { error: "All Customers is built in and can't be renamed" },
        { status: 400 },
      );
    }
  }

  if (await ops.nameTaken(workspaceId, name, id)) {
    return NextResponse.json({ error: `"${name}" already exists` }, { status: 409 });
  }
  if (kind === "product-lines") {
    const clash = await aliasClash(workspaceId, cleanAliases(body.aliases, name) ?? [], name, id);
    if (clash) return NextResponse.json({ error: clash }, { status: 409 });
  }
  if (kind === "customers" && body.aliases !== undefined) {
    const clash = await customerAliasClash(workspaceId, cleanAliases(body.aliases, name) ?? [], name, id);
    if (clash) return NextResponse.json({ error: clash }, { status: 409 });
  }

  await ops.update(
    id,
    name,
    cleanDescription(body.description),
    isChipColorId(body.color) ? body.color : undefined,
    kind === "product-lines" || kind === "customers" ? cleanAliases(body.aliases, name) : undefined,
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
