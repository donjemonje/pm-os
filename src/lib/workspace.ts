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
