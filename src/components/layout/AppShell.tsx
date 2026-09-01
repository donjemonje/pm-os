"use client";

import { useState } from "react";
import { MessageSquare, X } from "lucide-react";
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
              <MessageSquare size={16} className="text-primary" />
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
          className="fixed bottom-6 right-6 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-white shadow-lg transition hover:bg-primary-hover"
        >
          <MessageSquare size={18} />
          Chat
        </button>
      )}
    </div>
  );
}
