"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { OAuthButtons, OAUTH_ERROR_MESSAGES } from "@/components/auth/OAuthButtons";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";

const inputClassName =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-body text-brand-text outline-none transition-colors placeholder:text-brand-muted/60 focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/30";

/**
 * Sign-in only. There is no self-service sign-up: accounts are created by
 * PM-OS Admin and activated through the invite link (/invite), with either
 * Google or a password. Google sign-in is offered whenever the provider is
 * configured (env DISABLE_GOOGLE_LOGIN hides it).
 */
function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/dashboard";
  const oauthError = searchParams.get("error");
  const oauthErrorMessage = oauthError
    ? OAUTH_ERROR_MESSAGES[oauthError] ?? "Sign-in failed. Please try again."
    : "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSignIn(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      const target = from.startsWith("/") ? from : "/dashboard";
      if (data.twoFactorRequired) {
        router.push(`/login/2fa?from=${encodeURIComponent(target)}`);
      } else {
        router.push(target);
      }
      router.refresh();
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
            Log in
          </h1>
        </div>

        <form onSubmit={onSignIn} className="space-y-4">
          {(error || oauthErrorMessage) && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error || oauthErrorMessage}
            </p>
          )}
          <OAuthButtons from={from} variant="dark" />
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClassName}
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label
                htmlFor="password"
                className="font-subtitle block text-xs font-medium text-brand-muted"
              >
                Password
              </label>
              <a
                href="/forgot-password"
                className="font-subtitle text-xs text-brand-muted transition-colors hover:text-brand-accent"
              >
                Forgot password?
              </a>
            </div>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90 disabled:opacity-60"
            style={{ background: brand.accent }}
          >
            {loading ? "Logging in…" : "Log In"}
          </button>
        </form>
      </div>
    </AuthNeuralBackground>
  );
}

export function LoginForm() {
  return (
    <Suspense
      fallback={
        <AuthNeuralBackground>
          <p className="text-center text-sm text-brand-muted">Loading…</p>
        </AuthNeuralBackground>
      }
    >
      <LoginFormInner />
    </Suspense>
  );
}
