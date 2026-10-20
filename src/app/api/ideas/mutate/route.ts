import { NextRequest, NextResponse } from "next/server";
import { buildIdeasSyncPreviews } from "@/lib/ideas/push";
import { apiAuthContext, ideasDisabledResponse } from "@/lib/api-auth";
import { mutateIdeas, type IdeasMutation } from "@/lib/ideas/store";

const MUTATION_TYPES = [
  "decision",
  "edit",
  "approveAll",
  "reassign",
  "rewrite",
  "keepText",
  "createIdeaFromTicket",
  "createIdea",
  "approveCustomer",
  "dismissCustomer",
  "undismissCustomer",
];

export async function POST(request: NextRequest) {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const auth = await apiAuthContext();
  if (auth instanceof NextResponse) return auth;
  const workspaceResult = auth.workspaceId;

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
    const { state, notice } = await mutateIdeas(workspaceResult, mutation, auth.userId);
    // The touched idea's "Changes to sync" rides along, so the drawer shows
    // the new comparison the moment the state lands — no second round trip.
    const touched = (mutation as { ideaId?: unknown }).ideaId;
    const previews =
      typeof touched === "string" && state.jiraConnected
        ? await buildIdeasSyncPreviews(workspaceResult, [touched])
        : undefined;
    return NextResponse.json({ state, notice, previews });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Update failed" },
      { status: 502 }
    );
  }
}
