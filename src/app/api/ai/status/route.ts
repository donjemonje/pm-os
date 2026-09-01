import { NextResponse } from "next/server";
import { getAiProvider, isAiEnabled } from "@/lib/ai-config";
import { getCurrentUser } from "@/lib/auth";
import {
  getVertexLocation,
  getVertexModel,
  getVertexProjectId,
} from "@/lib/vertex-config";

export async function GET() {
  // Leaks deploy metadata (GCP project id, model) — signed-in users only.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const provider = getAiProvider();
  const model = getVertexModel();
  const enabled = isAiEnabled();

  const hint = enabled
    ? `Using Vertex — project ${getVertexProjectId()}, location ${getVertexLocation()}, model ${model}.`
    : "Set VERTEX_PROJECT_ID and Google Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS).";

  return NextResponse.json({
    enabled,
    provider,
    model,
    aggregationUsesAi: false,
    projectId: getVertexProjectId(),
    location: getVertexLocation(),
    hint,
  });
}
