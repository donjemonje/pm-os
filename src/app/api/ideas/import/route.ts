import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { importBatch, type ImportTicketInput } from "@/lib/ideas/store";

const MAX_BATCH = 200;

export async function POST(request: NextRequest) {
  const disabled = ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  let body: { tickets?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.tickets)) {
    return NextResponse.json({ error: "tickets must be an array" }, { status: 400 });
  }
  if (body.tickets.length > MAX_BATCH) {
    return NextResponse.json({ error: `At most ${MAX_BATCH} tickets per batch` }, { status: 400 });
  }

  const tickets: ImportTicketInput[] = [];
  for (const t of body.tickets) {
    const item = t as Partial<ImportTicketInput>;
    if (typeof item.key !== "string" || typeof item.subject !== "string") {
      return NextResponse.json({ error: "Each ticket needs a key and a subject" }, { status: 400 });
    }
    tickets.push({
      key: item.key,
      subject: item.subject,
      body: typeof item.body === "string" ? item.body : "",
      requester: typeof item.requester === "string" ? item.requester : undefined,
      tags: Array.isArray(item.tags) ? item.tags.filter((x) => typeof x === "string") : [],
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      productLine: typeof item.productLine === "string" ? item.productLine : undefined,
      raw:
        item.raw && typeof item.raw === "object" ? (item.raw as Record<string, string>) : {},
    });
  }

  try {
    const result = await importBatch(workspaceResult, tickets);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed" },
      { status: 502 }
    );
  }
}
