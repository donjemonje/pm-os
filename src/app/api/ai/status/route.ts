import { NextResponse } from "next/server";
import { getAiProvider, isAiEnabled } from "@/lib/ai-config";
import {
  getVertexLocation,
  getVertexModel,
  getVertexProjectId,
} from "@/lib/vertex-config";

export async function GET() {
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
