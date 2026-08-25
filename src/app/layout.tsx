import type { Metadata } from "next";
import { Chakra_Petch, Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { brand } from "@/lib/brand";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";
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
  const ideasEnabled = await ideasEnabledForCurrentUser();
  return (
    <html
      lang="en"
      className={`${chakraPetch.variable} ${spaceGrotesk.variable} ${inter.variable}`}
    >
      <body className="font-body antialiased">
        <Shell ideasEnabled={ideasEnabled}>{children}</Shell>
      </body>
    </html>
  );
}
