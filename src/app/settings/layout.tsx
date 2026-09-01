import { AppShell } from "@/components/layout/AppShell";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { ideasEnabledForCurrentUser } from "@/lib/org-features";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ideasEnabled = await ideasEnabledForCurrentUser();
  const sections = [
    { href: "/settings/jira", label: "Integrations" },
    ...(ideasEnabled ? [{ href: "/settings/ideas", label: "Ideas" }] : []),
  ];

  return (
    <AppShell>
      <div className="p-8">
        <h1 className="font-title text-2xl font-bold tracking-tight">Settings</h1>
        <SettingsNav sections={sections} />
        {children}
      </div>
    </AppShell>
  );
}
