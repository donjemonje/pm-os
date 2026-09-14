"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Info } from "lucide-react";
import { Button } from "./Button";

/**
 * The PM-OS dialog that replaces every browser `confirm()` / `alert()`:
 *
 *   const { confirm, notice } = useConfirm();
 *   if (!(await confirm({ title: "Are you sure?", confirmLabel: "Remove all", tone: "danger" }))) return;
 *   await notice({ title: "Export failed", message: err.message });
 *
 * One provider (mounted in Shell) renders the dialog for the whole app.
 * Keyboard follows the house rules: Enter confirms, Esc cancels. The
 * primary button takes focus on open so Enter is never a surprise.
 */
export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Primary action label. Default "Confirm". */
  confirmLabel?: string;
  /** Secondary action label. Default "Cancel"; `null` hides it (notice mode). */
  cancelLabel?: string | null;
  /** `danger` for destructive actions: pink strip and a red primary button. */
  tone?: "default" | "danger";
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  notice: (options: Omit<ConfirmOptions, "cancelLabel">) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending((cur) => {
          // A second request while one is open cancels the first — never
          // two stacked dialogs.
          cur?.resolve(false);
          return { options, resolve };
        });
      }),
    []
  );
  const notice = useCallback(
    async (options: Omit<ConfirmOptions, "cancelLabel">) => {
      await confirm({ confirmLabel: "OK", ...options, cancelLabel: null });
    },
    [confirm]
  );
  const value = useMemo(() => ({ confirm, notice }), [confirm, notice]);

  const settle = useCallback(
    (ok: boolean) => {
      setPending((cur) => {
        cur?.resolve(ok);
        return null;
      });
    },
    []
  );

  useEffect(() => {
    if (!pending) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(pending.options.cancelLabel !== null ? false : true);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        settle(true);
      }
    };
    // Capture phase so page-level Esc handlers (drawer, merge edit) don't
    // also fire while the dialog is up.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, settle]);

  const o = pending?.options;
  const danger = o?.tone === "danger";

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {o && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(12,25,41,.42)] p-10 backdrop-blur-[6px]"
          onClick={() => settle(o.cancelLabel === null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pmos-dialog-title"
            className="glass-strong flex w-[440px] max-w-full flex-col overflow-hidden rounded-[18px] shadow-[var(--app-shadow-modal)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="h-[3px]"
              style={{
                background: danger
                  ? "linear-gradient(90deg, #ef5a8a, #c23767)"
                  : "linear-gradient(90deg, var(--app-accent), #17b26a)",
              }}
            />
            <div className="flex gap-3.5 px-6 pb-5 pt-[22px]">
              <span
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: danger ? "rgba(239,90,138,.14)" : "var(--app-accent-soft)",
                  color: danger ? "#c23767" : "var(--app-accent)",
                }}
              >
                {danger ? <AlertTriangle size={17} strokeWidth={2.25} /> : <Info size={17} strokeWidth={2.25} />}
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="pmos-dialog-title" className="font-title m-0 text-[18px] font-bold leading-snug">
                  {o.title}
                </h2>
                {o.message && (
                  <div className="mt-1.5 whitespace-pre-line text-[13.5px] leading-relaxed text-fg-3">
                    {o.message}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border bg-[rgba(247,250,253,.8)] px-6 py-3.5">
              {o.cancelLabel !== null && (
                <Button onClick={() => settle(false)}>{o.cancelLabel ?? "Cancel"}</Button>
              )}
              <Button
                ref={confirmRef}
                variant="primary"
                glow
                onClick={() => settle(true)}
                className={
                  danger
                    ? "bg-[linear-gradient(180deg,#f06f9c,#e04a7c)] shadow-[0_0_0_1px_rgba(239,90,138,.4),0_8px_24px_-6px_rgba(239,90,138,.75)] hover:bg-[linear-gradient(180deg,#ee5f90,#c23767)]"
                    : undefined
                }
              >
                {o.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmProvider");
  return ctx;
}
