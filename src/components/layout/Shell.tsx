"use client";

import { usePathname } from "next/navigation";
import { OrgFeaturesProvider } from "./OrgFeaturesContext";
import { Sidebar } from "./Sidebar";
import type { MenuOrganization, MenuUser } from "./UserMenu";

const NO_SHELL_PATHS = ["/", "/login", "/register"];

export function Shell({
  children,
  ideasEnabled,
  docsEnabled,
  chatEnabled,
  user,
  organization,
}: {
  children: React.ReactNode;
  ideasEnabled: boolean;
  docsEnabled: boolean;
  chatEnabled: boolean;
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
    <OrgFeaturesProvider value={{ chatEnabled }}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar
          ideasEnabled={ideasEnabled}
          docsEnabled={docsEnabled}
          chatEnabled={chatEnabled}
          user={user}
          organization={organization}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </OrgFeaturesProvider>
  );
}
