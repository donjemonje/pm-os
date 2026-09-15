import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { extractMappedFields } from "@/lib/ideas/csv-mapping";
import { mergeIdeasJiraConfig } from "@/lib/ideas/jira-mapping";
import { customerKey } from "@/lib/ideas/customer-key";

/**
 * Re-apply the org's current CSV mapping to every already-imported ticket,
 * from the verbatim raw rows — so a mapping fixed after an import doesn't
 * require re-uploading the file. AI verdicts are untouched; only the
 * deterministically mapped params change. Customer Name is truth, so names
 * it surfaces are added to the Customers catalog like on a fresh import.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const workspace = await db.workspace.findUnique({
    where: { organizationId: id },
    select: { id: true, ideasConfig: true },
  });
  if (!workspace) {
    return NextResponse.json({ error: "Organization has no workspace" }, { status: 404 });
  }
  const cfg = mergeIdeasJiraConfig(workspace.ideasConfig);
  const mapping = cfg.csv;

  const tickets = await db.zendeskTicketRaw.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, raw: true, affectedCustomers: true },
  });
  const existingCustomers = await db.customer.findMany({
    where: { workspaceId: workspace.id },
    select: { name: true, aliases: true },
  });
  const knownLower = new Set(
    existingCustomers.flatMap((c) => [
      customerKey(c.name),
      ...((c.aliases as string[]) ?? []).map(customerKey),
    ]),
  );

  const newCustomers = new Map<string, string>();
  let updated = 0;
  for (const t of tickets) {
    const raw = (t.raw ?? {}) as Record<string, string>;
    const fields = extractMappedFields(raw, mapping);
    // The catalog stage's extracted customers stay; mapped ones merge in.
    // With AI field parsing on, the import already cleaned the list column
    // (qualifiers, "all customers"); only the truth column is re-merged here
    // so a remap never reintroduces raw fragments.
    const mappedNames = cfg.fieldParsing.customers
      ? (fields.customerName ?? "").split(/[,;/]+/).map((n) => n.trim()).filter(Boolean)
      : fields.customers;
    const current = ((t.affectedCustomers as string[]) ?? []).map((c) => c.trim()).filter(Boolean);
    const merged = [...current, ...mappedNames].filter(
      (c, i, all) => all.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i
    );
    await db.zendeskTicketRaw.update({
      where: { id: t.id },
      data: {
        requester: fields.requester ?? null,
        productLine: fields.productLine ?? null,
        module: fields.module ?? null,
        customerName: fields.customerName ?? null,
        whyBuild: fields.whyBuild ?? null,
        insights: fields.insights ?? null,
        dealRelated: fields.dealRelated ?? null,
        customerType: fields.customerType ?? null,
        url: fields.url ?? null,
        tags: fields.tags,
        sourceCreatedAt: fields.created ?? null,
        affectedCustomers: merged,
      },
    });
    updated++;
    for (const name of (fields.customerName ?? "").split(/[,;/]+/).map((n) => n.trim())) {
      const key = customerKey(name);
      if (name && key && !knownLower.has(key) && !newCustomers.has(key)) {
        newCustomers.set(key, name);
      }
    }
  }
  if (newCustomers.size > 0) {
    await db.customer.createMany({
      data: Array.from(newCustomers.values()).map((name) => ({
        workspaceId: workspace.id,
        name,
        description: "",
      })),
    });
  }

  return NextResponse.json({ updated, customersAdded: newCustomers.size });
}
