"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  FileText,
  LayoutDashboard,
  Lightbulb,
  Menu,
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

/**
 * Curtain wrapper: clips its fixed-width content as max-width animates to 0,
 * so collapsing reveals/covers text without any reflow or wrapping.
 */
function Curtain({
  collapsed,
  width,
  children,
}: {
  collapsed: boolean;
  width: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="shrink-0 overflow-hidden transition-[max-width,opacity] duration-200 ease-out"
      style={{ maxWidth: collapsed ? 0 : width, opacity: collapsed ? 0 : 1 }}
    >
      <div style={{ width }}>{children}</div>
    </div>
  );
}

export function Sidebar({
  defaultCollapsed,
  ideasEnabled,
  docsEnabled,
  chatEnabled,
  dashboardEnabled,
  user,
  organization,
}: {
  /** Initial rail state, read from the pmos_sidebar cookie on the server. */
  defaultCollapsed: boolean;
  ideasEnabled: boolean;
  docsEnabled: boolean;
  chatEnabled: boolean;
  dashboardEnabled: boolean;
  user: MenuUser | null;
  organization: MenuOrganization | null;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const toggle = () =>
    setCollapsed((v) => {
      const next = !v;
      document.cookie = `pmos_sidebar=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });

  const hidden = new Set([
    ...(dashboardEnabled ? [] : ["/dashboard"]),
    ...(ideasEnabled ? [] : ["/ideas"]),
    ...(docsEnabled ? [] : ["/docs"]),
    ...(chatEnabled ? [] : ["/chat"]),
  ]);
  const items = nav.filter((item) => !hidden.has(item.href));

  // Fixed paddings in both states keep every icon (and the hamburger) at a
  // constant x while only the rail width animates — the curtain effect.
  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col bg-cover bg-center bg-no-repeat text-sidebar-fg transition-[width] duration-200 ease-out",
        collapsed ? "w-16" : "w-60"
      )}
      style={{
        backgroundColor: "var(--sidebar)",
        backgroundImage: `url('${neuralBackgrounds.diagonal}')`,
      }}
    >
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-5">
        <button
          onClick={toggle}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Menu size={18} />
        </button>
        <Curtain collapsed={collapsed} width={150}>
          <BrandLockup height={SIDEBAR_LOGO_HEIGHT} priority href="/dashboard" />
        </Curtain>
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
              title={collapsed ? label : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-brand-accent/20 text-brand-accent shadow-[inset_0_0_0_1px_rgba(122,167,255,0.45),0_0_14px_rgba(122,167,255,0.3)]"
                  : "text-white/70 hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon size={16} className="shrink-0" />
              <Curtain collapsed={collapsed} width={140}>
                <span className="block whitespace-nowrap">{label}</span>
              </Curtain>
            </Link>
          );
        })}
      </nav>
      {user && <UserMenu user={user} organization={organization} collapsed={collapsed} />}
    </aside>
  );
}
