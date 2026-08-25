"use client";

import ReactMarkdown from "react-markdown";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ChatEmbed } from "@/lib/types";

interface DocEmbedProps {
  embed: ChatEmbed;
}

export function DocEmbed({ embed }: DocEmbedProps) {
  const href =
    embed.type === "document"
      ? `/docs/${embed.id}`
      : embed.type === "issue"
        ? `#${embed.id}`
        : "#";

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-background px-3 py-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">
          {embed.type === "document" ? "Live document" : "Issue"}
        </div>
        {embed.type === "document" && (
          <Link
            href={href}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Open editor
            <ExternalLink size={12} />
          </Link>
        )}
      </div>
      <div className="p-3">
        <div className="mb-1 text-sm font-semibold">{embed.title}</div>
        {embed.preview && (
          <div className="markdown-body max-h-40 overflow-hidden text-sm text-muted">
            <ReactMarkdown>{embed.preview.slice(0, 400)}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
