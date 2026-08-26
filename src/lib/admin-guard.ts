/**
 * Pure guardrails for admin mutations on users (role changes and
 * deactivation). Kept dependency-free so the rules are testable without a
 * DB. The route computes activeAdminCount = users with role PMOS_ADMIN and
 * deactivatedAt null, then asks this function whether the change is allowed.
 *
 * Rules:
 * - an admin cannot change their own role (no self-demotion, and
 *   self-promotion is meaningless — they are already an admin)
 * - the last active pmos-admin cannot be demoted (would lock everyone out)
 * - an admin cannot deactivate themselves
 * - the last active pmos-admin cannot be deactivated
 */

export type RoleName = "USER" | "PMOS_ADMIN";

export type AdminUserMutation = {
  actorId: string;
  target: {
    id: string;
    role: RoleName;
    deactivated: boolean;
  };
  change: {
    role?: RoleName;
    deactivated?: boolean;
  };
  /** Count of users with role PMOS_ADMIN and no deactivation. */
  activeAdminCount: number;
};

/** Returns a human-readable refusal, or null when the mutation is allowed. */
export function adminMutationError(input: AdminUserMutation): string | null {
  const { actorId, target, change, activeAdminCount } = input;
  const targetIsSelf = target.id === actorId;
  const targetIsActiveAdmin = target.role === "PMOS_ADMIN" && !target.deactivated;

  if (change.role !== undefined && change.role !== target.role) {
    if (targetIsSelf) {
      return "You cannot change your own role";
    }
    if (
      change.role === "USER" &&
      targetIsActiveAdmin &&
      activeAdminCount <= 1
    ) {
      return "Cannot demote the last active pmos-admin";
    }
  }

  if (change.deactivated === true && !target.deactivated) {
    if (targetIsSelf) {
      return "You cannot deactivate your own account";
    }
    if (targetIsActiveAdmin && activeAdminCount <= 1) {
      return "Cannot deactivate the last active pmos-admin";
    }
  }

  return null;
}
