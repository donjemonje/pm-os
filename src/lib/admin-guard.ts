/**
 * Pure guardrails for admin mutations on users and organizations. Kept
 * dependency-free so the rules are testable without a DB. The route computes
 * activeAdminCount = users with role PMOS_ADMIN and deactivatedAt null, then
 * asks this module whether the change is allowed.
 *
 * Role changes are not guarded here because they are not reachable through
 * the app at all — the admin API rejects them and roles move only via
 * scripts (seed-admin.mjs / set-user-role.mjs). The guards below matter
 * MORE under that model: with no in-app promotion, locking out (or deleting)
 * the last active pmos-admin means a trip to the scripts to recover.
 *
 * Rules:
 * - an admin cannot deactivate or delete themselves
 * - the last active pmos-admin cannot be deactivated or deleted
 * - an organization cannot be deleted when doing so would break either rule
 *   for any of its members (deleting an org deletes its users)
 */

export type RoleName = "USER" | "PMOS_ADMIN";

/** The word the admin must type in the UI (and the client must send) to
 * delete an organization. Checked on both sides. */
export const ORG_DELETE_CONFIRMATION = "delete";

export type AdminUserMutation = {
  actorId: string;
  target: {
    id: string;
    role: RoleName;
    deactivated: boolean;
  };
  change: {
    deactivated?: boolean;
    deleted?: boolean;
  };
  /** Count of users with role PMOS_ADMIN and no deactivation. */
  activeAdminCount: number;
};

/** Returns a human-readable refusal, or null when the mutation is allowed. */
export function adminMutationError(input: AdminUserMutation): string | null {
  const { actorId, target, change, activeAdminCount } = input;
  const targetIsSelf = target.id === actorId;
  const targetIsActiveAdmin = target.role === "PMOS_ADMIN" && !target.deactivated;

  if (change.deleted === true) {
    if (targetIsSelf) {
      return "You cannot delete your own account";
    }
    if (targetIsActiveAdmin && activeAdminCount <= 1) {
      return "Cannot delete the last active pmos-admin";
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

export type AdminOrgDeletion = {
  actorId: string;
  members: { id: string; role: RoleName; deactivated: boolean }[];
  /** Count of users with role PMOS_ADMIN and no deactivation, system-wide. */
  activeAdminCount: number;
};

/**
 * Deleting an organization deletes every member with it. Refuses when the
 * acting admin belongs to the org, or when the org holds every remaining
 * active pmos-admin (the system would be left with no admin at all).
 */
export function adminOrgDeleteError(input: AdminOrgDeletion): string | null {
  const { actorId, members, activeAdminCount } = input;

  if (members.some((m) => m.id === actorId)) {
    return "You cannot delete your own organization";
  }

  const activeAdminsInOrg = members.filter(
    (m) => m.role === "PMOS_ADMIN" && !m.deactivated
  ).length;
  if (activeAdminsInOrg > 0 && activeAdminCount - activeAdminsInOrg < 1) {
    return "Cannot delete an organization that holds the last active pmos-admin";
  }

  return null;
}
