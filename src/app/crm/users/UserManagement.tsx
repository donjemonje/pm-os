"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  Building2,
  Check,
  Copy,
  Loader2,
  Plus,
  Trash2,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Member = {
  id: string;
  email: string;
  name: string;
  hasPassword: boolean;
  createdAt: string;
};

type Organization = {
  id: string;
  name: string;
  slug: string;
  inviteCode: string;
  createdAt: string;
  memberCount: number;
  members: Member[];
};

const NEW_ORG = "__new__";

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10";

export function UserManagement({
  initialOrganizations,
}: {
  initialOrganizations: Organization[];
}) {
  const [organizations, setOrganizations] =
    useState<Organization[]>(initialOrganizations);
  const [showAddUser, setShowAddUser] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const totalUsers = useMemo(
    () => organizations.reduce((sum, org) => sum + org.members.length, 0),
    [organizations]
  );

  async function refresh() {
    const res = await fetch("/api/crm/organizations");
    if (res.ok) {
      const data = await res.json();
      setOrganizations(data.organizations ?? []);
    }
  }

  async function deleteUser(orgName: string, member: Member) {
    if (
      !window.confirm(
        `Remove ${member.name || member.email} from ${orgName}? This cannot be undone.`
      )
    ) {
      return;
    }
    setBusyUserId(member.id);
    try {
      const res = await fetch(`/api/crm/users/${member.id}`, {
        method: "DELETE",
      });
      if (res.ok) await refresh();
    } finally {
      setBusyUserId(null);
    }
  }

  async function copyInvite(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-3">
          <StatCard label="Organizations" value={organizations.length} />
          <StatCard label="Users" value={totalUsers} />
        </div>
        <button
          type="button"
          onClick={() => setShowAddUser((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          <UserPlus className="h-4 w-4" />
          Add user
        </button>
      </div>

      {showAddUser && (
        <AddUserForm
          organizations={organizations}
          onClose={() => setShowAddUser(false)}
          onCreated={async () => {
            setShowAddUser(false);
            await refresh();
          }}
        />
      )}

      {organizations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
          No organizations yet. Add a user and create the first organization
          along the way.
        </div>
      ) : (
        <div className="space-y-4">
          {organizations.map((org) => (
            <div
              key={org.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold">{org.name}</p>
                    <p className="text-xs text-slate-500">
                      {org.memberCount}{" "}
                      {org.memberCount === 1 ? "member" : "members"} · /{org.slug}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copyInvite(org.inviteCode)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  title="Copy invite code"
                >
                  {copiedCode === org.inviteCode ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span className="font-mono">{org.inviteCode}</span>
                </button>
              </div>

              {org.members.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-slate-400">
                  No users in this organization yet.
                </p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-100 bg-slate-50/60 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">Name</th>
                      <th className="px-5 py-2.5 font-medium">Email</th>
                      <th className="px-5 py-2.5 font-medium">Access</th>
                      <th className="px-5 py-2.5 font-medium">Added</th>
                      <th className="px-5 py-2.5 font-medium text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {org.members.map((member) => (
                      <tr key={member.id} className="hover:bg-slate-50/60">
                        <td className="px-5 py-3 font-medium">
                          {member.name || "—"}
                        </td>
                        <td className="px-5 py-3 text-slate-600">
                          {member.email}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs font-medium",
                              member.hasPassword
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-amber-50 text-amber-700"
                            )}
                          >
                            {member.hasPassword ? "Password set" : "Invite pending"}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-slate-500 whitespace-nowrap">
                          {new Date(member.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => deleteUser(org.name, member)}
                            disabled={busyUserId === member.id}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            {busyUserId === member.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-2xl font-bold leading-none">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{label}</p>
    </div>
  );
}

function AddUserForm({
  organizations,
  onClose,
  onCreated,
}: {
  organizations: Organization[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgChoice, setOrgChoice] = useState(
    organizations[0]?.id ?? NEW_ORG
  );
  const [newOrgName, setNewOrgName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const creatingNewOrg = orgChoice === NEW_ORG;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/crm/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password: password || undefined,
          organizationId: creatingNewOrg ? undefined : orgChoice,
          organizationName: creatingNewOrg ? newOrgName : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to add user");
        return;
      }
      await onCreated();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="mb-4 flex items-center gap-2">
        <Plus className="h-4 w-4 text-slate-400" />
        <h3 className="text-sm font-semibold">Add a user</h3>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            className={inputClass}
          />
        </Field>
        <Field label="Email">
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@company.com"
            className={inputClass}
          />
        </Field>

        <Field label="Organization">
          <select
            value={orgChoice}
            onChange={(e) => setOrgChoice(e.target.value)}
            className={inputClass}
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
            <option value={NEW_ORG}>+ Create new organization…</option>
          </select>
        </Field>

        {creatingNewOrg ? (
          <Field label="New organization name">
            <input
              required
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              placeholder="Acme Inc."
              className={inputClass}
            />
          </Field>
        ) : (
          <Field label="Temporary password (optional)">
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to send invite"
              className={inputClass}
            />
          </Field>
        )}

        {creatingNewOrg && (
          <Field label="Temporary password (optional)">
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to send invite"
              className={inputClass}
            />
          </Field>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Passwords must be at least 8 characters. Leave it blank to create the
        user with an invite-pending status.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Adding…" : "Add user"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}
