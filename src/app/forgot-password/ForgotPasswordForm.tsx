"use client";

import { FormEvent, useState } from "react";
import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";

const inputClassName =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-body text-brand-text outline-none transition-colors placeholder:text-brand-muted/60 focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/30";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Try again.");
        return;
      }
      setSent(true);
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
            Reset password
          </h1>
        </div>

        {sent ? (
          <div className="space-y-4">
            <p className="font-subtitle text-sm text-brand-muted">
              If an account exists for <span className="text-brand-text">{email}</span>,
              a reset link is on its way. The link expires in 24 hours.
            </p>
            <a
              href="/login"
              className="font-title block text-center text-sm font-semibold text-brand-accent hover:opacity-80"
            >
              Back to sign in
            </a>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}
            <p className="font-subtitle text-sm text-brand-muted">
              Enter your account email and we&apos;ll send you a link to set a new
              password.
            </p>
            <div>
              <label
                htmlFor="email"
                className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClassName}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90 disabled:opacity-60"
              style={{ background: brand.accent }}
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
            <a
              href="/login"
              className="font-subtitle block text-center text-xs text-brand-muted hover:text-brand-text"
            >
              Back to sign in
            </a>
          </form>
        )}
      </div>
    </AuthNeuralBackground>
  );
}
