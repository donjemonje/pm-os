"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ChatInterface } from "@/components/chat/ChatInterface";
import type { ChatContext } from "@/lib/types";

function ChatContent() {
  const searchParams = useSearchParams();

  const context: ChatContext = {
    releaseId: searchParams.get("release") ?? undefined,
    documentId: searchParams.get("doc") ?? undefined,
    projectKey: searchParams.get("project") ?? undefined,
    issueKeys: searchParams.get("issues")?.split(",").filter(Boolean),
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-6">
        <h1 className="text-2xl font-bold">Chat</h1>
        <p className="text-sm text-muted">
          Ask any PRD related questions
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-card">
          <ChatInterface context={context} />
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatContent />
    </Suspense>
  );
}
