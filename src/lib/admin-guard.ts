/**
 * Pure guardrails for admin mutations on users. Kept dependency-free so the
 * rules are testable without a DB. The route computes activeAdminCount =
 * users with role PMOS_ADMIN and deactivatedAt null, then asks this function
 * whether the change is allowed.
 *
 * Role changes are not guarded here because they are not reachable through
 * the app at all — the admin API rejects them and roles move only via
 * scripts (seed-admin.mjs / set-user-role.mjs). The deactivation guards
 * below matter MORE under that model: with no in-app promotion, locking out
 * the last active pmos-admin means a trip to the scripts to recover.
 *
 * Rules:
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
