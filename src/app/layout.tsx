import type { Metadata } from "next";
import { Chakra_Petch, Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import {
  getCurrentUser,
  getOrganizationSummary,
  userInitials,
} from "@/lib/auth";
import { brand } from "@/lib/brand";
import { isIdeasEnabled } from "@/lib/feature-flags";
import { Shell } from "@/components/layout/Shell";

const chakraPetch = Chakra_Petch({
  subsets: ["latin"],
  variable: "--font-brand",
  weight: ["700"],
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-title",
  weight: ["400", "500", "600", "700"],
});

const inter = Inter({
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
  // show a sidebar that is still "loading" its identity.
  const user = await getCurrentUser();
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

  return (
    <html
      lang="en"
      className={`${chakraPetch.variable} ${spaceGrotesk.variable} ${inter.variable}`}
    >
      <body className="font-body antialiased">
        <Shell
          ideasEnabled={isIdeasEnabled()}
          user={menuUser}
          organization={organization}
        >
          {children}
        </Shell>
      </body>
    </html>
  );
}
