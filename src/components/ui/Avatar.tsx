import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** "Acme Corp" → "AC"; single words take their first two letters. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Customer avatar: initials on the customer's chip tint, white ring so a
 * stack of them reads as separate discs. Color comes from the same palette
 * as the chips (pass `chipStyle(...)`).
 */
export function Avatar({
  name,
  size = 26,
  style,
  className,
}: {
  name: string;
  size?: number;
  /** Background/foreground from the chip palette. */
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span
      title={name}
      aria-label={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-white font-title font-bold",
        className
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), ...style }}
    >
      {initialsOf(name)}
    </span>
  );
}
