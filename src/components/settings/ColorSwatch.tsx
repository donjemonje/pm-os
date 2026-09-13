"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { CHIP_PALETTE, chipStyle, type ChipColor } from "@/lib/ideas/colors";

/**
 * A catalog row's color: a small swatch that opens the curated palette.
 * Picking writes immediately (one PATCH); Esc closes. Read-only rows show
 * the swatch without a picker.
 */
export function ColorSwatch({
  color,
  fallback,
  name,
  canEdit,
  onPick,
}: {
  color: string | null | undefined;
  fallback: ChipColor;
  name: string;
  canEdit: boolean;
  onPick: (color: string) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const style = chipStyle(color, fallback);
  const swatch = (
    <span
      className="block h-4 w-4 rounded-md border border-black/10"
      style={{ background: style.color as string }}
    />
  );
  if (!canEdit) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center" title="Chip color">
        {swatch}
      </span>
    );
  }
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Chip color for ${name}`}
        aria-label={`Chip color for ${name}`}
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-background"
      >
        {swatch}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 grid w-[168px] grid-cols-6 gap-1.5 rounded-lg border border-border bg-white p-2 shadow-[0_8px_24px_rgba(10,22,40,.12)]">
          {CHIP_PALETTE.map((c) => {
            const active = c.id === color;
            return (
              <button
                key={c.id}
                type="button"
                title={c.label}
                aria-label={c.label}
                onClick={() => {
                  setOpen(false);
                  void onPick(c.id);
                }}
                className="flex h-5 w-5 items-center justify-center rounded-md border border-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                style={{ background: c.fg }}
              >
                {active && <Check size={12} color="#fff" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
