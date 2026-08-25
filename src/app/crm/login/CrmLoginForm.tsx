"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { brand } from "@/lib/brand";

export function CrmLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/crm/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      router.push("/crm");
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a1220] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#050A15] p-8 shadow-xl">
        <BrandLogo height={40} className="mb-4" variant="withWordmark" />
        <h1 className="font-title text-xl font-bold text-brand-text">PM-OS CRM</h1>
        <p className="font-subtitle mt-1 text-sm text-brand-muted">Demo leads & inquiries</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          {error && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>
          )}
          <label className="block">
            <span className="font-subtitle mb-1 block text-xs text-brand-muted">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-body text-brand-text outline-none focus:border-brand-accent/50"
            />
          </label>
          <label className="block">
            <span className="font-subtitle mb-1 block text-xs text-brand-muted">Password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-body text-brand-text outline-none focus:border-brand-accent/50"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="font-title w-full rounded-lg py-2.5 text-sm font-semibold text-[#050A15] hover:opacity-90 disabled:opacity-60"
            style={{ background: brand.accent }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
