"use client";

import { useState } from "react";
import Image from "next/image";
import { X } from "lucide-react";
import { brand } from "@/lib/brand";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { useOrgFeatures } from "@/components/layout/OrgFeaturesContext";
import type { ChatContext } from "@/lib/types";

interface AppShellProps {
  children: React.ReactNode;
  chatContext?: ChatContext;
}

export function AppShell({ children, chatContext }: AppShellProps) {
  const [chatOpen, setChatOpen] = useState(false);
  // Server-resolved org flag (provided by Shell): when chat is off for the
  // org, the floating chat is gone entirely — the /api/chat routes 404 too.
  const { chatEnabled } = useOrgFeatures();

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 overflow-auto bg-background text-foreground">{children}</main>
      </div>

      {chatEnabled && chatOpen && (
        <div className="flex w-[420px] shrink-0 flex-col border-l border-border bg-card shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Image
                src={brand.logoWithWordmark}
                alt=""
                width={18}
                height={18}
                className="h-[18px] w-[18px] select-none object-contain [filter:drop-shadow(0_0_3px_rgba(36,87,245,.35))]"
              />
              PMOS Chat
            </div>
            <button
              onClick={() => setChatOpen(false)}
              className="rounded-md p-1 text-muted hover:bg-background"
              aria-label="Close chat"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <ChatInterface context={chatContext} compact />
          </div>
        </div>
      )}

      {chatEnabled && !chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="group fixed bottom-6 right-6 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:bg-primary-hover hover:shadow-[0_14px_30px_-10px_rgba(36,87,245,.55)]"
          aria-label="Chat with PMOS"
        >
          <Image
            src={brand.logoWithWordmark}
            alt=""
            width={24}
            height={24}
            className="-ml-0.5 h-6 w-6 select-none object-contain transition-[filter] duration-200 [filter:drop-shadow(0_0_6px_rgba(127,235,255,.75))] group-hover:[filter:drop-shadow(0_0_9px_rgba(127,235,255,1))]"
          />
          Chat
        </button>
      )}
    </div>
  );
}
