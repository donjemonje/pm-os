import { redirect } from "next/navigation";
import { getCurrentUser } from "./auth";
import { db } from "./db";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/**
 * Page-side auth guard (API routes keep the throwing requireUser + 401
 * helpers). No valid session → redirect through the dead-cookie exit ramp,
 * which clears stale cookies and lands on /login — never a 500, never a
 * redirect loop.
 */
export async function requireUserPage(fromPath: string) {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/api/auth/session-expired?from=${encodeURIComponent(fromPath)}`);
  }
  return user;
}

export async function getOrCreateWorkspace() {
  const user = await requireUser();
  if (!user.workspaceId) {
    throw new UnauthorizedError("No workspace for user");
  }

  const workspace = await db.workspace.findUnique({
    where: { id: user.workspaceId },
  });
  if (!workspace) {
    throw new UnauthorizedError("Workspace not found");
  }
  return workspace;
}

export async function getWorkspaceId(): Promise<string> {
  const user = await requireUser();
  if (!user.workspaceId) {
    throw new UnauthorizedError("No workspace for user");
  }
  return user.workspaceId;
}
