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

/**
 * Midnight rail (Direction B): a #0b1430→#101c40 gradient, the active item
 * tinted with the accent and lit by a soft glow, the pending-review count
 * on Ideas as a green badge (hidden while collapsed, where the label is).
 */
export function Sidebar({
  defaultCollapsed,
  ideasEnabled,
  ideasPending = 0,
  docsEnabled,
  chatEnabled,
  dashboardEnabled,
  user,
  organization,
  appVersion,
}: {
  /** Initial rail state, read from the pmos_sidebar cookie on the server. */
  defaultCollapsed: boolean;
  ideasEnabled: boolean;
  /** Ideas awaiting review — badge on the Ideas item. */
  ideasPending?: number;
  docsEnabled: boolean;
  chatEnabled: boolean;
  dashboardEnabled: boolean;
  user: MenuUser | null;
  organization: MenuOrganization | null;
  appVersion: string;
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
        "relative flex h-full shrink-0 flex-col text-sidebar-fg transition-[width] duration-200 ease-out",
        collapsed ? "w-16" : "w-60"
      )}
      style={{
        background: "var(--app-side-bg)",
        borderRight: "1px solid var(--app-side-line)",
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-5"
        style={{ borderBottom: "1px solid var(--app-side-line)" }}
      >
        <button
          onClick={toggle}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-white/60 hover:bg-white/10 hover:text-white"
        >
          <Menu size={18} />
        </button>
        <Curtain collapsed={collapsed} width={150}>
          <BrandLockup height={SIDEBAR_LOGO_HEIGHT} priority showLogo={false} href="/" />
        </Curtain>
      </div>
      <nav className="flex-1 space-y-[3px] p-3">
        {items.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/dashboard"
              ? pathname === "/dashboard"
              : href.startsWith("/settings")
                ? pathname.startsWith("/settings")
                : pathname.startsWith(href);
          const badge = href === "/ideas" && ideasPending > 0 ? ideasPending : null;
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? (badge ? `${label} · ${badge} awaiting review` : label) : undefined}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-control px-[10px] text-[13.5px] transition-colors",
                active
                  ? "bg-[var(--app-side-active-bg)] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(36,87,245,.4),0_0_16px_-4px_rgba(36,87,245,.55)]"
                  : "font-medium text-white/60 hover:bg-white/5 hover:text-white"
              )}
            >
              <Icon size={16} strokeWidth={active ? 2.25 : 2} className="shrink-0" />
              <Curtain collapsed={collapsed} width={140}>
                <span className="flex w-[140px] items-center whitespace-nowrap">
                  {label}
                  {badge != null && (
                    <span
                      className="ml-auto mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-success px-1.5 font-mono text-[10px] font-semibold text-white"
                      title={`${badge} awaiting review`}
                    >
                      {badge}
                    </span>
                  )}
                </span>
              </Curtain>
            </Link>
          );
        })}
      </nav>
      {user && (
        <UserMenu
          user={user}
          organization={organization}
          collapsed={collapsed}
          appVersion={appVersion}
        />
      )}
    </aside>
  );
}
