"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

/** Shared accent styles for filter triggers, options and selected-value chips. */
export const FILTER_ACCENTS = {
  product: {
    trigger: "border-primary bg-[rgba(36,87,245,.10)] text-[#2a5fd0]",
    badge: "bg-primary text-white",
    selected: "bg-[rgba(36,87,245,.12)] text-[#2a5fd0]",
    chip: "bg-primary shadow-[0_4px_10px_-4px_var(--app-accent)] hover:bg-primary-hover",
  },
  platform: {
    trigger: "border-[#9d7ce8] bg-[rgba(169,140,255,.12)] text-[#6b4bd0]",
    badge: "bg-[#7f5be0] text-white",
    selected: "bg-[rgba(169,140,255,.16)] text-[#6b4bd0]",
    chip: "bg-[#7f5be0] shadow-[0_4px_10px_-4px_#7f5be0] hover:bg-[#6c48cd]",
  },
  customer: {
    trigger: "border-[#3aa48f] bg-[rgba(24,145,121,.10)] text-[#0f7a6a]",
    badge: "bg-[#189179] text-white",
    selected: "bg-[rgba(24,145,121,.14)] text-[#0f7a6a]",
    chip: "bg-[#189179] shadow-[0_4px_10px_-4px_#189179] hover:bg-[#127d67]",
  },
  status: {
    trigger: "border-[#7a8aa3] bg-[rgba(91,108,133,.10)] text-[#3f506b]",
    badge: "bg-[#5b6c85] text-white",
    selected: "bg-[rgba(91,108,133,.14)] text-[#3f506b]",
    chip: "bg-[#5b6c85] shadow-[0_4px_10px_-4px_#5b6c85] hover:bg-[#4a5b73]",
  },
} as const;

export type FilterAccent = keyof typeof FILTER_ACCENTS;

/**
 * Compact filter pill that opens a searchable option popover — one per filter
 * dimension, so all filters share a single toolbar row.
 *
 * Keyboard (per the standing rules): ArrowUp/Down move the highlight, Enter
 * toggles the highlighted option (multi-select stays open; single-select
 * closes), Esc closes the popover.
 */
export function FilterPopover({
  label,
  options,
  selected,
  onToggle,
  accent = "product",
  emptyText = "No match",
  single = false,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (option: string) => void;
  accent?: FilterAccent;
  emptyText?: string;
  /** Single-select mode: picking an option closes the popover; trigger shows the value. */
  single?: boolean;
}) {
  const accents = FILTER_ACCENTS[accent];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const shown = options.filter(
    (o) => !query.trim() || o.toLowerCase().startsWith(query.trim().toLowerCase())
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (option: string) => {
    onToggle(option);
    if (single) close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[highlight]) pick(shown[highlight]);
    }
  };

  const active = selected.length > 0;
  const triggerText = single && selected[0] ? `${label}: ${selected[0]}` : label;

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control border pl-3 pr-2.5 text-[12.5px] font-medium shadow-sm ${
          active
            ? accents.trigger
            : "border-border bg-[var(--app-glass)] text-[#3f506b] hover:border-primary/55 hover:bg-white"
        }`}
      >
        {triggerText}
        {!single && active && (
          <span
            className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold ${accents.badge}`}
          >
            {selected.length}
          </span>
        )}
        <ChevronDown size={13} className="opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[24]" onClick={() => setOpen(false)} />
          <div
            onKeyDown={onKeyDown}
            className="absolute left-0 top-[calc(100%+6px)] z-[25] w-[260px] rounded-inner border border-border bg-white p-1.5 shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]"
          >
            {options.length > 6 && (
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                placeholder={`Search ${label.toLowerCase()}…`}
                className="mb-1.5 w-full rounded-[8px] border border-border bg-[var(--app-bg)] px-3 py-[7px] text-[13px] outline-none placeholder:text-fg-faint focus:border-primary focus:bg-white focus:shadow-[0_0_0_2px_var(--app-accent-soft)]"
              />
            )}
            <div className="max-h-60 overflow-y-auto">
              {shown.map((option, i) => {
                const isSelected = selected.includes(option);
                return (
                  <button
                    key={option}
                    onClick={() => pick(option)}
                    onMouseEnter={() => setHighlight(i)}
                    className={`flex w-full items-center justify-between gap-2 rounded-[8px] px-3 py-[7px] text-left text-[13px] ${
                      isSelected ? "font-semibold" : "font-medium"
                    } ${i === highlight ? "bg-[var(--app-accent-soft)]" : ""} ${
                      isSelected ? accents.selected : "text-fg-2"
                    }`}
                  >
                    <span className="truncate">{option}</span>
                    {isSelected && <Check size={13} strokeWidth={3} className="shrink-0" />}
                  </button>
                );
              })}
              {shown.length === 0 && (
                <div className="px-3 py-2 text-[12.5px] text-fg-muted">{emptyText}</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
