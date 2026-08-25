"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { AuthNeuralBackground } from "@/components/auth/AuthNeuralBackground";
import { OAuthButtons, OAUTH_ERROR_MESSAGES } from "@/components/auth/OAuthButtons";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";

const inputClassName =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-body text-brand-text outline-none transition-colors placeholder:text-brand-muted/60 focus:border-brand-accent/50 focus:ring-1 focus:ring-brand-accent/30";

const outlineButtonClassName =
  "font-title w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-brand-text transition-colors hover:bg-white/10";

type AuthMode = "signIn" | "signUp";

type AuthFormInnerProps = {
  initialMode?: AuthMode;
  signupAllowed?: boolean;
};

function AuthFormInner({ initialMode = "signIn", signupAllowed = false }: AuthFormInnerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/dashboard";
  const oauthError = searchParams.get("error");
  const oauthErrorMessage = oauthError
    ? OAUTH_ERROR_MESSAGES[oauthError] ?? "Sign-in failed. Please try again."
    : "";

  const [mode, setMode] = useState<AuthMode>(
    signupAllowed ? initialMode : "signIn"
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgMode, setOrgMode] = useState<"create" | "join">("create");
  const [organizationName, setOrganizationName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function switchMode(next: AuthMode) {
    if (next === "signUp" && !signupAllowed) return;
    setMode(next);
    setError("");
  }

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
      router.push(from.startsWith("/") ? from : "/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function onSignUp(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          ...(orgMode === "join"
            ? { inviteCode }
            : { organizationName }),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Registration failed");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const isSignIn = mode === "signIn";

  return (
    <AuthNeuralBackground>
      <div
        className="rounded-2xl border border-white/10 bg-[#050A15]/85 p-8 shadow-2xl backdrop-blur-xl"
        style={{ boxShadow: `0 25px 50px -12px ${brand.accentFaint}` }}
      >
        <div className="mb-8 flex items-center justify-center gap-4">
          <BrandLogo height={84} className="shrink-0" priority />
          <h1 className="font-title text-2xl font-bold leading-tight tracking-tight text-brand-text">
            {isSignIn ? "Sign in" : "Sign up"}
          </h1>
        </div>

        {isSignIn ? (
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
              <label
                htmlFor="password"
                className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClassName}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90 disabled:opacity-60"
              style={{ background: brand.accent }}
            >
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </form>
        ) : (
          <form onSubmit={onSignUp} className="space-y-4">
            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}
            <OAuthButtons from="/" variant="dark" />
            <div>
              <label
                htmlFor="name"
                className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
              >
                Name
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label
                  htmlFor="organization"
                  className="font-subtitle block text-xs font-medium text-brand-muted"
                >
                  Organization
                </label>
                <div className="flex gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setOrgMode("create")}
                    className={`rounded px-2 py-0.5 font-medium transition-colors ${
                      orgMode === "create"
                        ? "bg-brand-accent/20 text-brand-accent"
                        : "text-brand-muted hover:text-brand-text"
                    }`}
                  >
                    Create new
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrgMode("join")}
                    className={`rounded px-2 py-0.5 font-medium transition-colors ${
                      orgMode === "join"
                        ? "bg-brand-accent/20 text-brand-accent"
                        : "text-brand-muted hover:text-brand-text"
                    }`}
                  >
                    Join with code
                  </button>
                </div>
              </div>
              {orgMode === "create" ? (
                <input
                  id="organization"
                  type="text"
                  required
                  placeholder="e.g. RoomLens"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  className={inputClassName}
                />
              ) : (
                <input
                  id="invite-code"
                  type="text"
                  required
                  placeholder="Invite code from your admin"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  className={inputClassName}
                />
              )}
              <p className="font-subtitle mt-1.5 text-xs text-brand-muted">
                {orgMode === "create"
                  ? "Your workspace, integrations, and documents are private to this organization."
                  : "Join an existing organization to share its documents and integrations."}
              </p>
            </div>
            <div>
              <label
                htmlFor="signup-email"
                className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
              >
                Email
              </label>
              <input
                id="signup-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div>
              <label
                htmlFor="signup-password"
                className="font-subtitle mb-1.5 block text-xs font-medium text-brand-muted"
              >
                Password
              </label>
              <input
                id="signup-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClassName}
              />
              <p className="font-subtitle mt-1.5 text-xs text-brand-muted">At least 8 characters</p>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] transition-colors hover:opacity-90 disabled:opacity-60"
              style={{ background: brand.accent }}
            >
              {loading ? "Signing up…" : "Sign Up"}
            </button>
          </form>
        )}
      </div>

      {signupAllowed && (
        <div className="mt-6 text-center">
          {isSignIn ? (
            <p className="font-subtitle text-sm text-brand-muted">
              New user?{" "}
              <button
                type="button"
                onClick={() => switchMode("signUp")}
                className="font-title text-sm font-semibold text-brand-accent hover:opacity-80"
              >
                Create account
              </button>
            </p>
          ) : (
            <p className="font-subtitle text-sm text-brand-muted">
              Already signed in?{" "}
              <button
                type="button"
                onClick={() => switchMode("signIn")}
                className="font-title text-sm font-semibold text-brand-accent hover:opacity-80"
              >
                Log in
              </button>
            </p>
          )}
        </div>
      )}
    </AuthNeuralBackground>
  );
}

export function LoginForm({ signupAllowed = false }: { signupAllowed?: boolean }) {
  return (
    <Suspense
      fallback={
        <AuthNeuralBackground>
          <p className="text-center text-sm text-brand-muted">Loading…</p>
        </AuthNeuralBackground>
      }
    >
      <AuthFormInner initialMode="signIn" signupAllowed={signupAllowed} />
    </Suspense>
  );
}

export function RegisterForm({ signupAllowed = false }: { signupAllowed?: boolean }) {
  return (
    <Suspense
      fallback={
        <AuthNeuralBackground>
          <p className="text-center text-sm text-brand-muted">Loading…</p>
        </AuthNeuralBackground>
      }
    >
      <AuthFormInner initialMode="signUp" signupAllowed={signupAllowed} />
    </Suspense>
  );
}
