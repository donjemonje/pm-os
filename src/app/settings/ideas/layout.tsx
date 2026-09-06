import { SettingsNav } from "@/components/settings/SettingsNav";

export default function IdeasSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SettingsNav
        sections={[
          { href: "/settings/ideas/product-lines", label: "Product Lines" },
          { href: "/settings/ideas/customers", label: "Customers" },
        ]}
      />
      {children}
    </div>
  );
}
