"use client";

import { useRouter } from "next/navigation";

export function CrmLogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/crm/auth/logout", { method: "POST" });
    router.push("/crm/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={logout}
      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
    >
      Sign out
    </button>
  );
}
