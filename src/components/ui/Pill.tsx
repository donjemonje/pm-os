import { Check } from "lucide-react";
import type { BadgeStyle } from "@/lib/ideas/idea";
import { cn } from "@/lib/utils";

/**
 * Solid status pill (New / Updated / Archive / In Jira / Deleted) — the
 * colors come from `badgeOf` so every screen agrees on what a status looks
 * like. `title` carries the Updated idea's what-changed narration on hover.
 */
export function Pill({
  badge,
  size = "md",
  title,
  className,
}: {
  badge: BadgeStyle;
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-body font-semibold",
        size === "sm" ? "px-2 py-px text-[11px]" : "px-2.5 py-0.5 text-xs",
        className
      )}
      style={{ background: badge.bg, color: badge.fg, borderColor: badge.bd }}
    >
      {badge.check && <Check size={size === "sm" ? 10 : 11} strokeWidth={3} />}
      {badge.label}
    </span>
  );
}
