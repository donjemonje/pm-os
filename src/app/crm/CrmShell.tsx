"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Building2, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { CrmLogoutButton } from "./CrmLogoutButton";

type CrmShellUser = {
  email: string;
  name: string;
};

type NavItem = {
  label: string;
  href: string;
  icon: typeof Users;
  disabled?: boolean;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Organizations",
    items: [{ label: "User Management", href: "/crm/users", icon: Users }],
  },
  {
    title: "Platform",
    items: [
      { label: "Configurations", href: "/crm/configurations", icon: Settings, disabled: true },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/crm") return pathname === "/crm";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function CrmShell({
  user,
  title,
  description,
  actions,
  children,
}: {
  user: CrmShellUser;
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
              <p className="text-sm font-bold leading-tight">PM-OS Backoffice</p>
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
                    if (item.disabled) {
                      return (
                        <li key={item.href}>
                          <span className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400">
                            <Icon className="h-4 w-4" />
                            <span className="flex-1">{item.label}</span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                              Soon
                            </span>
                          </span>
                        </li>
                      );
                    }
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
              href="/"
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              ← Marketing site
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
                    PM-OS Backoffice
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
                <CrmLogoutButton />
              </div>
            </div>

            <nav className="flex gap-1 overflow-x-auto border-t border-slate-100 px-4 py-2 lg:hidden">
              {NAV_SECTIONS.flatMap((section) => section.items).map((item) => {
                const active = isActive(pathname, item.href);
                if (item.disabled) {
                  return (
                    <span
                      key={item.href}
                      className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-slate-300"
                    >
                      {item.label}
                    </span>
                  );
                }
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
