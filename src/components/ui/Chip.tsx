import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChipKind = "product" | "customer" | "platform" | "all" | "suggested";

const KIND_CLASS: Record<ChipKind, string> = {
  product: "",
  customer: "",
  platform: "bg-[rgba(169,140,255,.16)] text-[#6b4bd0]",
  // Labels (Internal, All customers): neutral grey, never a catalog color.
  all: "bg-[#eef1f6] text-[#4a5b74]",
  // Off-catalog suggestions: amber dashed outline, never hidden.
  suggested: "border border-dashed border-[var(--app-warn)] bg-[var(--app-warn-bg)] text-[var(--app-warn-fg)]",
};

/**
 * Metadata chip: mono 11px, 6px radius. Product and customer chips carry
 * their palette color via `style` (see lib/ideas/colors.ts); the other kinds
 * are fixed. `dot` adds the small solid marker used on product chips in rows.
 */
export function Chip({
  kind = "product",
  style,
  dot,
  title,
  className,
  children,
}: {
  kind?: ChipKind;
  style?: CSSProperties;
  /** Leading 6px solid dot in the chip's foreground color. */
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      style={style}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip px-[7px] py-[2px] font-mono text-[11px] font-semibold leading-[15px]",
        KIND_CLASS[kind],
        className
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}
