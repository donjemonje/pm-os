"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The review checkmark on an idea row (round) and the source checkbox on the
 * Merge board (square): green gradient when on, white with a grey ring when
 * off, dimmed when blocked. The title tells the PM what a click does — or
 * why it can't.
 */
export function ApproveMark({
  on,
  blocked,
  round = true,
  size = 20,
  title,
  onClick,
  className,
}: {
  on: boolean;
  /** Approval is refused (unresolved suggested metadata). */
  blocked?: boolean;
  round?: boolean;
  size?: number;
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={blocked}
      title={title}
      aria-pressed={on}
      className={cn(
        "flex shrink-0 items-center justify-center border-[1.5px] p-0 text-white transition-[background,border-color,box-shadow] duration-150",
        round ? "rounded-full" : "rounded-[5px]",
        on
          ? "border-[#17b26a] bg-[linear-gradient(180deg,#22c57a,#17b26a)] shadow-[0_0_0_3px_rgba(23,178,106,.18)]"
          : "border-[#c8d4e3] bg-white hover:border-[#17b26a] hover:shadow-[0_0_0_3px_rgba(23,178,106,.14)]",
        blocked ? "cursor-not-allowed opacity-40" : "cursor-pointer",
        className
      )}
      style={{ width: size, height: size }}
    >
      {on && <Check size={Math.round(size * 0.6)} strokeWidth={3.5} />}
    </button>
  );
}
