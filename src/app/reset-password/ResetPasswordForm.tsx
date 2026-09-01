"use client";

import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";

const inputClassName =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-body text-brand-text outline-none transition-colors placeholder:text-brand-muted/60 focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/30";

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthNeuralBackground>
      <div
        className="rounded-2xl border border-white/10 bg-[#050A15]/85 p-8 shadow-2xl backdrop-blur-xl"
        style={{ boxShadow: `0 25px 50px -12px ${brand.accentFaint}` }}
      >
        <div className="mb-8 flex items-center justify-center gap-4">
          <BrandLogo height={84} className="shrink-0" priority />
          <h1 className="font-title text-2xl font-bold leading-tight tracking-tight text-brand-text">
            New password
          </h1>
        </div>

        {done ? (
          <div className="space-y-4">
            <p className="font-subtitle text-sm text-brand-muted">
              Password updated. Sign in with your new password.
            </p>
            <a
              href="/login"
              className="font-title block w-full rounded-lg py-2.5 text-center text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90"
              style={{ background: brand.accent }}
            >
              Sign in
            </a>
          </div>
        ) : !token ? (
          <div className="space-y-4">
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              This reset link is missing its token. Open the link from your email,
              or request a new one.
            </p>
            <a
              href="/forgot-password"
              className="font-title block text-center text-sm font-semibold text-brand-accent hover:opacity-80"
            >
              Request a new link
            </a>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}
            <div>
              <label
                htmlFor="new-password"
                className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
              >
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClassName}
              />
              <p className="font-subtitle mt-1.5 text-xs text-brand-muted">
                At least 8 characters
              </p>
            </div>
            <div>
              <label
                htmlFor="confirm-password"
                className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
              >
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={inputClassName}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90 disabled:opacity-60"
              style={{ background: brand.accent }}
            >
              {loading ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}
      </div>
    </AuthNeuralBackground>
  );
}

export function ResetPasswordForm() {
  return (
    <Suspense
      fallback={
        <AuthNeuralBackground>
          <p className="text-center text-sm text-brand-muted">Loading…</p>
        </AuthNeuralBackground>
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}
