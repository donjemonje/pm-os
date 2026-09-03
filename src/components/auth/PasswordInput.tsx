"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

const inputClassName =
  "w-full rounded-lg border border-white/10 bg-white/5 py-2.5 pl-3 pr-10 text-sm font-body text-brand-text outline-none transition-colors placeholder:text-brand-muted/60 focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/30";

/**
 * Password field with a press-and-hold eye: the password is visible only
 * while the mouse button / finger is down on the icon (or while Space/Enter
 * is held with the icon focused), and hides again on release or when the
 * pointer leaves. Never toggles — nothing stays revealed by accident.
 */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  autoFocus,
  required = true,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  required?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const show = () => setRevealed(true);
  const hide = () => setRevealed(false);

  return (
    <div className="relative">
      <input
        id={id}
        type={revealed ? "text" : "password"}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClassName}
      />
      <button
        type="button"
        aria-label="Hold to show password"
        title="Hold to show password"
        onMouseDown={(e) => {
          e.preventDefault(); // keep focus in the input
          show();
        }}
        onMouseUp={hide}
        onMouseLeave={hide}
        onTouchStart={show}
        onTouchEnd={hide}
        onTouchCancel={hide}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            show();
          }
        }}
        onKeyUp={hide}
        onBlur={hide}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-brand-muted transition-colors hover:text-brand-text"
      >
        {revealed ? (
          <EyeOff className="h-4 w-4" aria-hidden />
        ) : (
          <Eye className="h-4 w-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
