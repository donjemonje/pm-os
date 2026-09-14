"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "success" | "warning";
export type ButtonSize = "sm" | "md";

/**
 * The one button of the app (Direction B): DM Sans 600, 9px radius, 36px tall
 * (30px small). `primary` is the accent with a soft glow; `secondary` is the
 * white glass control; `ghost` is text-only; `success` is the approve green.
 * Disabled buttons keep their variant but drop to 45% — the title attribute
 * on the wrapper explains why.
 */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Accent glow under primary/success — the "call to action" version. */
    glow?: boolean;
  }
>(function Button({ variant = "secondary", size = "md", glow, className, children, ...rest }, ref) {
  const base =
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control border font-title font-semibold transition-[background,box-shadow,border-color,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-45";
  const sizes = size === "sm" ? "h-[30px] px-3 text-[12.5px]" : "h-9 px-3.5 text-[13px]";
  const variants: Record<ButtonVariant, string> = {
    primary: cn(
      "border-transparent bg-[linear-gradient(180deg,color-mix(in_srgb,var(--app-accent)_85%,white),var(--app-accent))] text-white hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--app-accent)_70%,white),var(--app-accent-hover))]",
      glow
        ? "shadow-[0_0_0_1px_rgba(36,87,245,.4),0_8px_24px_-6px_rgba(36,87,245,.75)]"
        : "shadow-[0_1px_2px_rgba(10,22,40,.15),inset_0_1px_0_rgba(255,255,255,.25)]"
    ),
    secondary:
      "border-border bg-[var(--app-glass)] text-fg-2 shadow-sm hover:border-primary/60 hover:bg-white",
    ghost: "border-transparent bg-transparent text-fg-3 hover:bg-white/70 hover:text-foreground",
    success: cn(
      "border-transparent bg-[linear-gradient(180deg,#22c57a,#17b26a)] text-white hover:bg-[linear-gradient(180deg,#1fb871,#149c5d)]",
      glow ? "shadow-[0_8px_24px_-6px_rgba(23,178,106,.7)]" : "shadow-[0_1px_2px_rgba(10,22,40,.15)]"
    ),
    warning:
      "border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400",
  };
  return (
    <button ref={ref} className={cn(base, sizes, variants[variant], className)} {...rest}>
      {children}
    </button>
  );
});
