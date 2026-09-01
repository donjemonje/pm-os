"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Building2, Lightbulb, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { AdminLogoutButton } from "./AdminLogoutButton";

type AdminShellUser = {
  email: string;
  name: string;
};

type NavItem = {
  label: string;
  href: string;
  icon: typeof Users;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Organizations",
    items: [{ label: "User Management", href: "/admin/users", icon: Users }],
  },
  {
    title: "Platform",
    items: [
      { label: "Enablements", href: "/admin/enablements", icon: Settings },
      { label: "Ideas", href: "/admin/ideas", icon: Lightbulb },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({
  user,
  title,
  description,
  actions,
  children,
}: {
  user: AdminShellUser;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
          <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-white">
              PM
            </div>
            <div>
              <p className="text-sm font-bold leading-tight">PM-OS Admin</p>
              <p className="text-xs text-slate-500">Operations</p>
            </div>
          </div>

          <nav className="flex-1 space-y-6 px-3 py-5">
            {NAV_SECTIONS.map((section) => (
              <div key={section.title}>
                <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {section.title}
                </p>
                <ul className="space-y-1">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const active = isActive(pathname, item.href);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                            active
                              ? "bg-slate-900 text-white"
                              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                          )}
                        >
                          <Icon className="h-4 w-4" />
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="border-t border-slate-200 px-5 py-4">
            <Link
              href="/dashboard"
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              ← Back to app
            </Link>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-slate-200 bg-white">
            <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-8">
              <div className="min-w-0">
                <div className="flex items-center gap-2 lg:hidden">
                  <Building2 className="h-4 w-4 text-slate-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    PM-OS Admin
                  </span>
                </div>
                <h1 className="truncate text-lg font-bold">{title}</h1>
                {description ? (
                  <p className="truncate text-sm text-slate-500">{description}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <div className="hidden text-right sm:block">
                  <p className="text-sm font-medium leading-tight">{user.name}</p>
                  <p className="text-xs text-slate-500">{user.email}</p>
                </div>
                <AdminLogoutButton />
              </div>
            </div>

            <nav className="flex gap-1 overflow-x-auto border-t border-slate-100 px-4 py-2 lg:hidden">
              {NAV_SECTIONS.flatMap((section) => section.items).map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium",
                      active
                        ? "bg-slate-900 text-white"
                        : "text-slate-600 hover:bg-slate-100"
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </header>

          <main className="flex-1 px-4 py-8 sm:px-8">
            <div className="mx-auto max-w-6xl">
              {actions ? <div className="mb-6">{actions}</div> : null}
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
