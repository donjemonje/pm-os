"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import { ChatEmptyState } from "./ChatEmptyState";
import type { ChatContext, ChatMessageMetadata } from "@/lib/types";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: ChatMessageMetadata;
}

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

interface ChatInterfaceProps {
  context?: ChatContext;
  compact?: boolean;
}

export function ChatInterface({ context, compact }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId,
          context,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Chat failed");

      if (data.sessionId) setSessionId(data.sessionId);

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.reply,
          metadata: data.metadata,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, sessionId, context]);

  const toggleHistory = useCallback(async () => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (!opening) return;

    setHistoryLoading(true);
    try {
      const res = await fetch("/api/chat/sessions");
      const data = await res.json();
      if (res.ok) setSessions(data.sessions ?? []);
    } catch {
      // History list is best-effort; the chat itself still works.
    } finally {
      setHistoryLoading(false);
    }
  }, [historyOpen]);

  const loadSession = useCallback(async (id: string) => {
    setHistoryOpen(false);
    setLoading(true);
    try {
      const res = await fetch(`/api/chat/sessions/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load chat");
      setSessionId(data.id);
      setMessages(
        (data.messages ?? []).map(
          (m: { id: string; role: "user" | "assistant"; content: string; metadata?: ChatMessageMetadata }) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            metadata: m.metadata,
          })
        )
      );
    } catch {
      // Keep the current conversation if loading fails.
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteSession = useCallback(
    async (id: string, event: React.MouseEvent) => {
      event.stopPropagation();
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
        if (!res.ok) return;
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (sessionId === id) {
          setSessionId(null);
          setMessages([]);
        }
      } catch {
        // Best-effort delete
      }
    },
    [sessionId]
  );

  const newChat = useCallback(() => {
    setHistoryOpen(false);
    setSessionId(null);
    setMessages([]);
  }, []);

  const contextLabel = [
    context?.projectKey && `Project: ${context.projectKey}`,
    context?.releaseId && `Release context active`,
    context?.documentId && `Document context active`,
    context?.issueKeys?.length && `Issues: ${context.issueKeys.join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full w-full flex-col">
      {(contextLabel || !compact) && (
        <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2">
          <div className="min-w-0 truncate text-xs text-muted">{contextLabel}</div>
          {!compact && (
            <div className="relative flex shrink-0 items-center gap-1">
              <button
                onClick={newChat}
                title="New chat"
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-card hover:text-foreground"
              >
                <Plus size={14} />
                New chat
              </button>
              <button
                onClick={toggleHistory}
                title="Chat history"
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-card hover:text-foreground"
              >
                <History size={14} />
                History
              </button>
              {historyOpen && (
                <div className="absolute right-0 top-8 z-20 max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
                  {historyLoading ? (
                    <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
                      <Loader2 size={12} className="animate-spin" />
                      Loading…
                    </div>
                  ) : sessions.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted">No previous chats</div>
                  ) : (
                    sessions.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => loadSession(s.id)}
                        className="group flex cursor-pointer items-center justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-background"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium">{s.title}</div>
                          <div className="text-[11px] text-muted">
                            {new Date(s.updatedAt).toLocaleDateString()} · {s.messageCount} messages
                          </div>
                        </div>
                        <button
                          onClick={(e) => deleteSession(s.id, e)}
                          title="Delete chat"
                          className="shrink-0 rounded p-1 text-muted opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {messages.length === 0 ? (
          <ChatEmptyState compact={compact} onPromptSelect={setInput} />
        ) : (
          <div className="space-y-4 px-6 py-4">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
                metadata={msg.metadata}
              />
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 size={14} className="animate-spin" />
                Thinking…
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
        {messages.length === 0 && loading && (
          <div className="flex items-center justify-center gap-2 px-6 pb-4 text-sm text-muted">
            <Loader2 size={14} className="animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      <div className="border-t border-border px-6 py-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder="Ask about your Jira tickets, Drive docs, or PRDs…"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            disabled={loading}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-white transition hover:bg-primary-hover disabled:opacity-50"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
