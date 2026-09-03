"use client";

import { Check, X } from "lucide-react";
import { PASSWORD_RULES } from "@/lib/password-policy";

/**
 * Live policy checklist beside a password field: one row per rule, ✓ when
 * the current value satisfies it, ✗ otherwise. Rows stay neutral until the
 * user starts typing so an empty field isn't a wall of red. Pass `confirm`
 * to add a "Passwords match" row (neutral until the confirmation is typed).
 */
export function PasswordChecklist({
  password,
  confirm,
  className = "",
}: {
  password: string;
  confirm?: string;
  className?: string;
}) {
  const rows: { key: string; label: string; ok: boolean; started: boolean }[] =
    PASSWORD_RULES.map((rule) => ({
      key: rule.key,
      label: rule.label,
      ok: rule.test(password),
      started: password.length > 0,
    }));
  if (confirm !== undefined) {
    rows.push({
      key: "match",
      label: "Passwords match",
      ok: confirm.length > 0 && confirm === password,
      started: confirm.length > 0,
    });
  }

  return (
    <ul className={`space-y-1.5 ${className}`} aria-live="polite">
      {rows.map((row) => {
        const tone = !row.started
          ? "text-brand-muted"
          : row.ok
            ? "text-emerald-300"
            : "text-red-300";
        return (
          <li
            key={row.key}
            className={`font-subtitle flex items-center gap-1.5 text-xs ${tone}`}
            data-rule={row.key}
            data-ok={row.started ? String(row.ok) : undefined}
          >
            {!row.started ? (
              <span
                className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-current opacity-50"
                aria-hidden
              />
            ) : row.ok ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-label="met" />
            ) : (
              <X className="h-3.5 w-3.5 shrink-0" aria-label="not met" />
            )}
            {row.label}
          </li>
        );
      })}
    </ul>
  );
}
