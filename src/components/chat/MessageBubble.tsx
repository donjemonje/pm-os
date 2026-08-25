"use client";

import ReactMarkdown from "react-markdown";
import { DocEmbed } from "./DocEmbed";
import type { ChatMessageMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  metadata?: ChatMessageMetadata;
}

export function MessageBubble({ role, content, metadata }: MessageBubbleProps) {
  const isUser = role === "user";

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "rounded-2xl px-4 py-2.5 text-sm",
          isUser
            ? "max-w-xl bg-primary text-white"
            : "w-full border border-border bg-card text-foreground"
        )}
      >
        {metadata?.embed && <DocEmbed embed={metadata.embed} />}
        <div className="markdown-body">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
        {metadata?.citations && metadata.citations.length > 0 && (
          <div className="mt-3 border-t border-border pt-2">
            <div className="mb-1 text-xs font-medium text-muted">Sources</div>
            <div className="space-y-1">
              {metadata.citations.map((c, i) => (
                <div key={i} className="rounded bg-background px-2 py-1 text-xs">
                  <span className="font-mono font-medium text-primary">
                    {c.issueKey ?? c.driveFileName ?? "Source"}
                  </span>
                  {c.field && <span className="text-muted"> · {c.field}</span>}
                  {!c.field && c.source === "drive" && (
                    <span className="text-muted"> · Drive</span>
                  )}
                  <div className="text-muted">{c.snippet}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {metadata?.confidence && (
          <div className="mt-2 text-xs text-muted">
            Confidence: {metadata.confidence}
          </div>
        )}
      </div>
    </div>
  );
}
