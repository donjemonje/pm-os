"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";

const NO_SHELL_PATHS = ["/", "/login", "/register"];

export function Shell({
  children,
  ideasEnabled,
}: {
  children: React.ReactNode;
  ideasEnabled: boolean;
}) {
  const pathname = usePathname();
  const isAuthPage =
    NO_SHELL_PATHS.includes(pathname) || pathname.startsWith("/admin");

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar ideasEnabled={ideasEnabled} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
