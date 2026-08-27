"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import type { MenuOrganization, MenuUser } from "./UserMenu";

const NO_SHELL_PATHS = ["/", "/login", "/register"];

export function Shell({
  children,
  ideasEnabled,
  user,
  organization,
}: {
  children: React.ReactNode;
  ideasEnabled: boolean;
  user: MenuUser | null;
  organization: MenuOrganization | null;
}) {
  const pathname = usePathname();
  const isAuthPage =
    NO_SHELL_PATHS.includes(pathname) ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/admin");

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar ideasEnabled={ideasEnabled} user={user} organization={organization} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
