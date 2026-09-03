"use client";

import { Check, X } from "lucide-react";
import { PASSWORD_RULES } from "@/lib/password-policy";

/**
 * Live policy checklist under a password field: one row per rule, ✓ when
 * the current value satisfies it, ✗ otherwise. Rows stay neutral until the
 * user starts typing so an empty field isn't a wall of red.
 */
export function PasswordChecklist({ password }: { password: string }) {
  const started = password.length > 0;
  return (
    <ul className="mt-2 space-y-1" aria-live="polite">
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(password);
        const tone = !started
          ? "text-brand-muted"
          : ok
            ? "text-emerald-300"
            : "text-red-300";
        return (
          <li
            key={rule.key}
            className={`font-subtitle flex items-center gap-1.5 text-xs ${tone}`}
            data-rule={rule.key}
            data-ok={started ? String(ok) : undefined}
          >
            {!started ? (
              <span className="inline-block h-3.5 w-3.5 rounded-full border border-current opacity-50" aria-hidden />
            ) : ok ? (
              <Check className="h-3.5 w-3.5" aria-label="met" />
            ) : (
              <X className="h-3.5 w-3.5" aria-label="not met" />
            )}
            {rule.label}
          </li>
        );
      })}
    </ul>
  );
}
