"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Data arrives server-rendered via the root layout — the menu never renders
// without it, so there is no fetch and no loading state here.
export type MenuUser = {
  email: string;
  name: string;
  initials: string;
  organizationName?: string | null;
};

export type MenuOrganization = {
  id: string;
  name: string;
  memberCount: number;
};

export function UserMenu({
  user,
  organization,
  collapsed = false,
  appVersion,
}: {
  user: MenuUser;
  organization: MenuOrganization | null;
  /** Narrow-rail mode: avatar-only trigger; the menu overflows the rail. */
  collapsed?: boolean;
  /** package.json version — shown at the bottom of the menu. */
  appVersion: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } finally {
      setLoggingOut(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative border-t border-white/10 p-3" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // px-0.5 puts the 36px avatar at x=14 inside the 64px collapsed
          // rail — dead center — while keeping a constant x when expanded
          // (the curtain rule: nothing shifts, only the rail width moves).
          "flex w-full items-center gap-3 rounded-lg px-0.5 py-2 text-left transition-colors",
          open ? "bg-white/10" : "hover:bg-white/5"
        )}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-sm font-semibold text-white"
          aria-hidden
        >
          {user.initials}
        </span>
        <span
          className="shrink-0 overflow-hidden transition-[max-width,opacity] duration-200 ease-out"
          style={{ maxWidth: collapsed ? 0 : 140, opacity: collapsed ? 0 : 1 }}
        >
          <span className="block w-[140px]">
            <span className="block truncate text-sm font-medium text-white">{user.name}</span>
            <span className="block truncate text-xs text-white/50">
              {user.organizationName ?? user.email}
            </span>
          </span>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute bottom-full mb-1 overflow-hidden rounded-lg border border-white/10 bg-sidebar shadow-lg",
            collapsed ? "left-2 w-56" : "left-3 right-3"
          )}
        >
          <div className="border-b border-white/10 px-3 py-2">
            <p className="truncate text-xs text-white/50">{user.email}</p>
          </div>
          {organization && (
            <div className="border-b border-white/10 px-3 py-2.5">
              <p className="text-[11px] text-white/40">Organization</p>
              <p className="mt-0.5 truncate text-sm font-medium text-white">
                {organization.name}
              </p>
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={logout}
            disabled={loggingOut}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white/80 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            <LogOut size={16} />
            {loggingOut ? "Signing out…" : "Sign out"}
          </button>
          <div
            className="border-t border-white/10 px-3 py-2 text-[11px] text-white/40"
            data-app-version={appVersion}
          >
            PM-OS v{appVersion}
          </div>
        </div>
      )}
    </div>
  );
}
