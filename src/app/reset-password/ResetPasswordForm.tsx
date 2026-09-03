"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { PasswordChecklist } from "@/components/auth/PasswordChecklist";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { isPasswordValid } from "@/lib/password-policy";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";

function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  // Invite links (sent by PM-OS Admin) reuse the same token mechanism with
  // welcome wording; the API path is identical.
  const invite = searchParams.get("invite") === "1";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const policyOk = isPasswordValid(password);
  const canSubmit = policyOk && confirm.length > 0 && password === confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!policyOk) {
      setError("Your password doesn't meet all the requirements yet");
      return;
    }
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
      // Signed in by the API; 2FA (challenge or first enrollment) is next,
      // then the app — no intermediate "now sign in" screen.
      router.push("/login/2fa?from=%2Fdashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthNeuralBackground width="lg">
      <div
        className="rounded-2xl border border-white/10 bg-[#050A15]/85 p-8 shadow-2xl backdrop-blur-xl"
        style={{ boxShadow: `0 25px 50px -12px ${brand.accentFaint}` }}
      >
        <div className="mb-8 flex items-center justify-center gap-4">
          <BrandLogo height={84} className="shrink-0" priority />
          <h1 className="font-title text-2xl font-bold leading-tight tracking-tight text-brand-text">
            {invite ? "Welcome to PM-OS" : "New password"}
          </h1>
        </div>

        {!token ? (
          <div className="space-y-4">
            <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {invite
                ? "This invite link is missing its token. Open the link from your email, or ask your admin to resend the invite."
                : "This reset link is missing its token. Open the link from your email, or request a new one."}
            </p>
            {!invite && (
              <a
                href="/forgot-password"
                className="font-title block text-center text-sm font-semibold text-brand-accent hover:opacity-80"
              >
                Request a new link
              </a>
            )}
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {invite && (
              <p className="font-subtitle text-sm text-brand-muted">
                Set a password to activate your account.
              </p>
            )}
            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}
            {/* Inputs left, live requirements right (stacked on narrow screens). */}
            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:gap-6">
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="new-password"
                    className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
                  >
                    {invite ? "Password" : "New password"}
                  </label>
                  <PasswordInput
                    id="new-password"
                    autoComplete="new-password"
                    autoFocus
                    value={password}
                    onChange={setPassword}
                  />
                </div>
                <div>
                  <label
                    htmlFor="confirm-password"
                    className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
                  >
                    Confirm password
                  </label>
                  <PasswordInput
                    id="confirm-password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={setConfirm}
                  />
                </div>
              </div>
              <PasswordChecklist
                password={password}
                confirm={confirm}
                className="sm:pt-6"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !canSubmit}
              className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90 disabled:opacity-60"
              style={{ background: brand.accent }}
            >
              {loading ? "Saving…" : invite ? "Set password" : "Set new password"}
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
