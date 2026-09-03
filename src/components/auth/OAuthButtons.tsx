"use client";

import { useEffect, useState } from "react";

type Provider = { provider: string; label: string };

const PROVIDER_STYLES: Record<string, string> = {
  google: "border-border bg-white text-foreground hover:bg-zinc-50",
  microsoft: "border-border bg-white text-foreground hover:bg-zinc-50",
};

const PROVIDER_STYLES_DARK: Record<string, string> = {
  google: "border-white/10 bg-white/5 text-brand-text hover:bg-white/10",
  microsoft: "border-white/10 bg-white/5 text-brand-text hover:bg-white/10",
};

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "google") {
    return (
      <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    );
  }
  return (
    <svg className="h-5 w-5" viewBox="0 0 23 23" aria-hidden>
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}

export function OAuthButtons({
  from = "/",
  variant = "light",
}: {
  from?: string;
  variant?: "light" | "dark";
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/auth/oauth/providers")
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((data) => setProviders(data.providers ?? []))
      .catch(() => setProviders([]))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded || providers.length === 0) {
    return null;
  }

  const fromQuery = from.startsWith("/") ? from : "/";
  const isDark = variant === "dark";
  const providerStyles = isDark ? PROVIDER_STYLES_DARK : PROVIDER_STYLES;
  const providerFallback = isDark
    ? "border-white/10 bg-white/5 text-brand-text hover:bg-white/10"
    : "border-border bg-card hover:bg-zinc-50";

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        {providers.map((p) => (
          <a
            key={p.provider}
            href={`/api/auth/oauth/${p.provider}?from=${encodeURIComponent(fromQuery)}`}
            className={`flex w-full items-center justify-center gap-2.5 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${providerStyles[p.provider] ?? providerFallback}`}
          >
            <ProviderIcon provider={p.provider} />
            {p.label}
          </a>
        ))}
      </div>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className={`w-full border-t ${isDark ? "border-white/10" : "border-border"}`} />
        </div>
        <div className="relative flex justify-center text-xs uppercase tracking-wide">
          <span
            className={`px-2 font-subtitle ${isDark ? "bg-[#0a1220] text-brand-muted" : "bg-card text-muted"}`}
          >
            Or continue with email
          </span>
        </div>
      </div>
    </div>
  );
}

export const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  google_not_configured: "Google sign-in is not configured.",
  microsoft_not_configured: "Microsoft sign-in is not configured.",
  invalid_provider: "Unknown sign-in provider.",
  oauth_denied: "Sign-in was cancelled.",
  oauth_expired: "Sign-in expired. Please try again.",
  oauth_state_mismatch: "Sign-in session invalid. Please try again.",
  oauth_token_failed: "Could not complete sign-in. Please try again.",
  oauth_profile_failed: "Could not read your profile from the provider.",
  oauth_signin_failed: "Sign-in failed. Please try again.",
  signup_disabled:
    "No PM-OS account exists for this Google email. Ask your admin for an invite.",
  account_deactivated: "This account has been deactivated. Contact your admin.",
  google_sso_disabled:
    "Google sign-in is disabled in this environment. Sign in with email instead.",
  email_uses_password:
    "This email uses password sign-in. Enter your email and password below.",
};
