import { NextRequest, NextResponse } from "next/server";
import { apiWorkspaceId, ideasDisabledResponse } from "@/lib/api-auth";
import { buildPushPlan, executePush } from "@/lib/ideas/push";

/**
 * Merge-to-Jira endpoint. `preview` returns the plan (what will be created /
 * updated, field by field); `execute` re-derives the same plan server-side
 * and writes it. Scope is an optional product-line list — the review gate
 * applies inside the scope only, so each PM can merge their own lines.
 */
export async function POST(request: NextRequest) {
  const disabled = await ideasDisabledResponse();
  if (disabled) return disabled;
  const workspaceResult = await apiWorkspaceId();
  if (workspaceResult instanceof NextResponse) return workspaceResult;

  let body: { mode?: string; productLines?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const scope =
    Array.isArray(body.productLines) && body.productLines.length > 0
      ? body.productLines.filter((p): p is string => typeof p === "string")
      : null;

  try {
    if (body.mode === "preview") {
      const plan = await buildPushPlan(workspaceResult, scope);
      return NextResponse.json({ plan });
    }
    if (body.mode === "execute") {
      const result = await executePush(workspaceResult, scope);
      if (!result.ok) {
        return NextResponse.json({ error: result.blockers.join(" "), blockers: result.blockers }, { status: 409 });
      }
      return NextResponse.json({ results: result.results, state: result.state });
    }
    return NextResponse.json({ error: "mode must be preview or execute" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Merge failed" },
      { status: 502 }
    );
  }
}
