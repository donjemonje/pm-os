import { AppShell } from "@/components/layout/AppShell";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ideasEnabled = await ideasEnabledForCurrentUser();
  // One flat tab row (no nested tabs) and one centered reading-width column
  // shared by the title, the tabs and every card (Daniel, 2026-10-19).
  const sections = [
    { href: "/settings/jira", label: "Integrations" },
    ...(ideasEnabled
      ? [
          { href: "/settings/ideas/product-lines", label: "Product Lines" },
          { href: "/settings/ideas/customers", label: "Customers" },
        ]
      : []),
  ];

  return (
    <AppShell>
      <div className="p-8">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="font-title text-2xl font-bold tracking-tight">Settings</h1>
          <SettingsNav sections={sections} />
          {children}
        </div>
      </div>
    </AppShell>
  );
}
