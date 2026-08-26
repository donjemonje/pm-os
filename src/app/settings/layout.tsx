import { AppShell } from "@/components/layout/AppShell";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { isIdeasEnabled } from "@/lib/feature-flags";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const sections = [
    { href: "/settings/jira", label: "Integrations" },
    ...(isIdeasEnabled() ? [{ href: "/settings/ideas", label: "Ideas" }] : []),
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
