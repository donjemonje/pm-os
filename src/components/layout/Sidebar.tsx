"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  LayoutDashboard,
  Lightbulb,
  MessageSquare,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLockup } from "@/components/brand/BrandLockup";
import { neuralBackgrounds } from "@/lib/neural-backgrounds";
import { UserMenu, type MenuOrganization, type MenuUser } from "./UserMenu";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/ideas", label: "Ideas", icon: Lightbulb },
  { href: "/docs", label: "Docs", icon: FileText },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/settings/jira", label: "Settings", icon: Settings },
];

const SIDEBAR_LOGO_HEIGHT = 38;

export function Sidebar({
  ideasEnabled,
  user,
  organization,
}: {
  ideasEnabled: boolean;
  user: MenuUser | null;
  organization: MenuOrganization | null;
}) {
  const pathname = usePathname();
  const items = ideasEnabled ? nav : nav.filter((item) => item.href !== "/ideas");

  return (
    <aside
      className="relative flex h-full w-60 shrink-0 flex-col bg-cover bg-center bg-no-repeat text-sidebar-fg"
      style={{
        backgroundColor: "var(--sidebar)",
        backgroundImage: `url('${neuralBackgrounds.diagonal}')`,
      }}
    >
      <div className="border-b border-white/10 px-4 py-5">
        <BrandLockup height={SIDEBAR_LOGO_HEIGHT} priority href="/dashboard" />
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {items.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/dashboard"
              ? pathname === "/dashboard"
              : href.startsWith("/settings")
                ? pathname.startsWith("/settings")
                : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-brand-accent/20 text-brand-accent shadow-[inset_0_0_0_1px_rgba(122,167,255,0.45),0_0_14px_rgba(122,167,255,0.3)]"
                  : "text-white/70 hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>
      {user && <UserMenu user={user} organization={organization} />}
    </aside>
  );
}
