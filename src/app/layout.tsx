import type { Metadata } from "next";
import { Chakra_Petch, DM_Sans, IBM_Plex_Sans } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import {
  getCurrentUser,
  getOrganizationSummary,
  userInitials,
} from "@/lib/auth";
import { brand } from "@/lib/brand";
import { featureEnabledForCurrentUser } from "@/lib/org-features";
import { Shell } from "@/components/layout/Shell";
import { APP_VERSION } from "@/lib/version";
import { db } from "@/lib/db";

const chakraPetch = Chakra_Petch({
  subsets: ["latin"],
  variable: "--font-brand",
  weight: ["700"],
});

// App type: DM Sans titles and (since 2026-09-14) ids/chips/eyebrows too —
// there is no monospace face; IBM Plex Sans body outside Ideas. The CSS variable names are unchanged so
// every font-title / font-body / font-mono consumer follows automatically.
const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-title",
  weight: ["500", "600", "700"],
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "PM-OS — The Context-Aware Product Platform",
  description:
    "PM-OS consolidates your product lifecycle into a unified knowledge graph—guiding teams through every pillar of product management.",
  icons: {
    icon: [{ url: brand.logoStandalone, type: "image/png" }],
    apple: brand.logoStandalone,
    shortcut: brand.logoStandalone,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The shell renders with the user's details already in place — pages never
  // show a sidebar that is still "loading" its identity. getCurrentUser is
  // request-cached, so the per-org ideas flag reuses the same session lookup.
  const user = await getCurrentUser();
  const ideasEnabled = await featureEnabledForCurrentUser("ideas");
  const docsEnabled = await featureEnabledForCurrentUser("docs");
  const chatEnabled = await featureEnabledForCurrentUser("chat");
  const dashboardEnabled = await featureEnabledForCurrentUser("dashboard");
  const organization = user?.organizationId
    ? await getOrganizationSummary(user.organizationId)
    : null;
  const menuUser = user
    ? {
        email: user.email,
        name: user.name,
        initials: userInitials(user.name, user.email),
        organizationName: user.organizationName,
      }
    : null;

  // The rail starts collapsed; it stays open only once the user expanded it.
  const sidebarCollapsed = (await cookies()).get("pmos_sidebar")?.value !== "expanded";

  // Ideas awaiting review — the sidebar's badge on "Ideas". One count query;
  // unchanged/deleted ideas never need approval (see lib/ideas/idea.ts).
  const ideasPending =
    ideasEnabled && user?.workspaceId
      ? await db.idea.count({
          where: {
            workspaceId: user.workspaceId,
            decision: "pending",
            batchStatus: { notIn: ["unchanged", "deleted"] },
          },
        })
      : 0;

  return (
    <html
      lang="en"
      className={`${chakraPetch.variable} ${dmSans.variable} ${plexSans.variable}`}
    >
      <body className="font-body antialiased">
        <Shell
          sidebarDefaultCollapsed={sidebarCollapsed}
          ideasEnabled={ideasEnabled}
          ideasPending={ideasPending}
          docsEnabled={docsEnabled}
          chatEnabled={chatEnabled}
          dashboardEnabled={dashboardEnabled}
          user={menuUser}
          organization={organization}
          appVersion={APP_VERSION}
        >
          {children}
        </Shell>
      </body>
    </html>
  );
}
