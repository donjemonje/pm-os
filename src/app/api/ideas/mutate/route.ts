import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { mutateIdeas, type IdeasMutation } from "@/lib/ideas/store";

const MUTATION_TYPES = [
  "decision",
  "edit",
  "approveAll",
  "reassign",
  "approveCustomer",
  "dismissCustomer",
  "undismissCustomer",
];

export async function POST(request: NextRequest) {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  let mutation: IdeasMutation;
  try {
    mutation = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!mutation || !MUTATION_TYPES.includes(mutation.type)) {
    return NextResponse.json({ error: "Unknown mutation type" }, { status: 400 });
  }

  try {
    const state = await mutateIdeas(workspaceResult, mutation);
    return NextResponse.json({ state });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Update failed" },
      { status: 502 }
    );
  }
}
