"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import type { DomainRow } from "@/lib/competitors/store";

/**
 * Removing a domain that still holds capabilities asks once where they go
 * (Capability Analysis PRD, "PM and PMOS AI"). The capabilities stay in the
 * table; only the domain leaves it.
 *
 * The shared ConfirmDialog cannot hold a required choice (its primary button
 * is always enabled and Enter always confirms), so this dialog is local to the
 * Competitors settings and copies its look. Keyboard: Enter confirms once a
 * domain is picked, Esc cancels.
 */
export function MoveDomainDialog({ domain, count, targets, busy, onCancel, onConfirm }: {
  domain: DomainRow;
  /** Capabilities that move (in the table or waiting as suggestions). */
  count: number;
  /** The other domains in the table. */
  targets: DomainRow[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (moveTo: string) => void;
}) {
  const [moveTo, setMoveTo] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        // Enter on Cancel is that button's own click.
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement && dialogRef.current?.contains(active) && active.dataset.role === "cancel") return;
        e.preventDefault();
        e.stopPropagation();
        if (moveTo && !busy) onConfirm(moveTo);
      }
    };
    // Capture phase, like the shared dialog: page-level Esc handlers stay quiet while this is up.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [moveTo, busy, onCancel, onConfirm]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(12,25,41,.42)] p-10 backdrop-blur-[6px]" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cmp-move-domain-title"
        data-testid="cmp-move-domain-dialog"
        className="glass-strong flex w-[460px] max-w-full flex-col overflow-hidden rounded-[18px] shadow-[var(--app-shadow-modal)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-[3px]" style={{ background: "linear-gradient(90deg, #ef5a8a, #c23767)" }} />
        <div className="flex gap-3.5 px-6 pb-5 pt-[22px]">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: "rgba(239,90,138,.14)", color: "#c23767" }}>
            <AlertTriangle size={17} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="cmp-move-domain-title" className="font-title m-0 text-[18px] font-bold leading-snug">{C.settings.removeDomainTitle(domain.name)}</h2>
            <div className="mt-1.5 text-[13.5px] leading-relaxed text-fg-3">{C.settings.removeDomainMoveBody(count)}</div>
            <label className="mt-4 block text-[12.5px] font-medium text-foreground" htmlFor="cmp-move-domain-select">{C.settings.removeDomainMoveLabel(count)}</label>
            <select
              id="cmp-move-domain-select"
              ref={selectRef}
              data-testid="cmp-move-domain-select"
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              disabled={busy}
              className="mt-1.5 w-full rounded-lg border border-border bg-white px-3 py-2 pr-8 text-sm outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)] disabled:opacity-60"
            >
              <option value="" disabled>{C.settings.removeDomainMovePlaceholder}</option>
              {targets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-[rgba(247,250,253,.8)] px-6 py-3.5">
          <Button data-role="cancel" onClick={onCancel}>{C.settings.cancel}</Button>
          <Button
            variant="primary"
            glow
            disabled={!moveTo || busy}
            data-testid="cmp-move-domain-confirm"
            onClick={() => moveTo && onConfirm(moveTo)}
            className="bg-[linear-gradient(180deg,#f06f9c,#e04a7c)] shadow-[0_0_0_1px_rgba(239,90,138,.4),0_8px_24px_-6px_rgba(239,90,138,.75)] hover:bg-[linear-gradient(180deg,#ee5f90,#c23767)]"
          >
            {C.settings.remove}
          </Button>
        </div>
      </div>
    </div>
  );
}
