"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";

const inputClassName =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-center text-lg tracking-[0.3em] font-body text-brand-text outline-none transition-colors placeholder:tracking-normal placeholder:text-brand-muted/60 focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/30";

function ChallengeFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/dashboard";

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || loading) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/two-factor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Verification failed");
        return;
      }
      router.push(from.startsWith("/") ? from : "/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function onBackToSignIn() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  }

  return (
    <AuthNeuralBackground>
      <div
        className="rounded-2xl border border-white/10 bg-[#050A15]/85 p-8 shadow-2xl backdrop-blur-xl"
        style={{ boxShadow: `0 25px 50px -12px ${brand.accentFaint}` }}
      >
        <div className="mb-6 flex items-center justify-center gap-4">
          <BrandLogo height={84} className="shrink-0" priority />
          <h1 className="font-title text-2xl font-bold leading-tight tracking-tight text-brand-text">
            Two-factor check
          </h1>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          {error && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
          <div>
            <label
              htmlFor="code"
              className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
            >
              Enter the 6-digit code from your authenticator app
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Escape") void onBackToSignIn();
              }}
              placeholder="000000"
              className={inputClassName}
            />
          </div>
          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90 disabled:opacity-60"
            style={{ background: brand.accent }}
          >
            {loading ? "Verifying…" : "Verify"}
          </button>
        </form>

        <div className="mt-6 space-y-2 text-center">
          <button
            type="button"
            onClick={onBackToSignIn}
            className="font-subtitle block w-full text-sm text-brand-muted hover:text-brand-text"
          >
            Back to sign in
          </button>
          <p className="font-subtitle text-xs text-brand-muted">
            Lost your authenticator? Ask your admin to reset two-factor for
            your account.
          </p>
        </div>
      </div>
    </AuthNeuralBackground>
  );
}

export function TwoFactorChallengeForm() {
  return (
    <Suspense
      fallback={
        <AuthNeuralBackground>
          <p className="text-center text-sm text-brand-muted">Loading…</p>
        </AuthNeuralBackground>
      }
    >
      <ChallengeFormInner />
    </Suspense>
  );
}
