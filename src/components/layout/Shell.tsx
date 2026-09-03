"use client";

import { usePathname } from "next/navigation";
import { OrgFeaturesProvider } from "./OrgFeaturesContext";
import { Sidebar } from "./Sidebar";
import type { MenuOrganization, MenuUser } from "./UserMenu";

// Every public (pre-auth) page. These must never render inside the app
// chrome: the sidebar would flash before the page's own background paints
// over it, and the form would center in the area beside the sidebar.
const NO_SHELL_PATHS = [
  "/",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/invite",
];

export function Shell({
  children,
  ideasEnabled,
  docsEnabled,
  chatEnabled,
  dashboardEnabled,
  user,
  organization,
}: {
  children: React.ReactNode;
  ideasEnabled: boolean;
  docsEnabled: boolean;
  chatEnabled: boolean;
  dashboardEnabled: boolean;
  user: MenuUser | null;
  organization: MenuOrganization | null;
}) {
  const pathname = usePathname();
  const isAuthPage =
    NO_SHELL_PATHS.includes(pathname) ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/admin");

  // No session → no chrome, whatever the path. The proxy already bounces
  // anonymous visitors off app pages, so this only affects public pages, and
  // it guarantees a signed-out visitor can never see a sidebar frame.
  if (isAuthPage || !user) {
    return <>{children}</>;
  }

  return (
    <OrgFeaturesProvider value={{ chatEnabled }}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar
          ideasEnabled={ideasEnabled}
          docsEnabled={docsEnabled}
          chatEnabled={chatEnabled}
          dashboardEnabled={dashboardEnabled}
          user={user}
          organization={organization}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </OrgFeaturesProvider>
  );
}
