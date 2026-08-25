"use client";

import Image from "next/image";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/utils";

const DEFAULT_PROMPTS = [
  "What's the acceptance criteria?",
  "Any edge cases I'm missing?",
  "What's in scope for v1?",
];

type ChatEmptyStateProps = {
  compact?: boolean;
  onPromptSelect?: (prompt: string) => void;
};

export function ChatEmptyState({ compact, onPromptSelect }: ChatEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-full w-full flex-1 items-center justify-center",
        compact ? "px-4 py-8" : "px-6 py-12"
      )}
      style={{
        background:
          "radial-gradient(120% 120% at 50% 22%, #f4f8fc 0%, #eef3f9 45%, #e7edf5 100%)",
      }}
    >
      <div
        className={cn(
          "flex flex-col items-center text-center",
          compact ? "max-w-xs" : "max-w-[560px]"
        )}
      >
        <div
          className={cn(
            "relative mb-6",
            compact ? "h-[120px] w-[105px]" : "mb-[30px] h-[228px] w-[200px]"
          )}
        >
          <div
            className={cn(
              "chat-pm-glow absolute left-1/2 top-[48%] rounded-full",
              compact ? "h-[130px] w-[130px]" : "h-[230px] w-[230px]"
            )}
            style={{
              background:
                "radial-gradient(circle, rgba(56,170,235,.55) 0%, rgba(56,170,235,0) 68%)",
              filter: "blur(6px)",
            }}
            aria-hidden
          />
          <Image
            src={brand.logoStandalone}
            alt="PM-OS mind"
            width={200}
            height={200}
            className={cn(
              "chat-pm-float relative mx-auto h-auto drop-shadow-[0_16px_28px_rgba(40,110,170,.28)]",
              compact ? "w-[105px]" : "w-[200px]"
            )}
            priority
          />
        </div>

        <h2
          className={cn(
            "font-title font-semibold tracking-tight text-[#162536]",
            compact ? "text-lg leading-snug" : "text-[31px] leading-[1.28]"
          )}
        >
          Ask me anything, and let&apos;s get
          {!compact && <br />}
          {compact ? " " : null}
          you unblocked{" "}
          <span className="text-[#2f9fdc]">:)</span>
        </h2>

        <p
          className={cn(
            "mt-4 font-body leading-relaxed text-[#5d6c7e]",
            compact ? "text-xs" : "max-w-[420px] text-[15.5px] leading-[1.6]"
          )}
        >
          Tap into the PM-OS mind for instant answers on specs, scope, and edge cases — straight
          from your PRD.
        </p>

        {!compact && (
          <div className="mt-[34px] flex flex-wrap justify-center gap-2">
            {DEFAULT_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onPromptSelect?.(prompt)}
                className="cursor-pointer rounded-full border border-[#dde6f0] bg-white/70 px-3.5 py-2 text-[13px] text-[#46586b] transition-colors hover:border-[#9cc9ea] hover:bg-white hover:text-[#1d3a52]"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
