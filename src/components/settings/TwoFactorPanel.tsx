"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";

const INPUT_CLASS =
  "w-40 rounded-lg border border-border bg-white px-3 py-2 text-sm tracking-widest outline-none focus:border-primary focus:shadow-[0_0_0_1px_rgba(122,167,255,.3)]";

type Enrollment = { qrDataUrl: string; secret: string };

export function TwoFactorPanel({
  enabledAt,
}: {
  /** ISO date when 2FA was enabled, or null when it's off. */
  enabledAt: string | null;
}) {
  const [enabled, setEnabled] = useState(Boolean(enabledAt));
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/two-factor/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onStartSetup() {
    const data = await call("setup");
    if (data) {
      setEnrollment(data as Enrollment);
      setCode("");
    }
  }

  async function onVerify() {
    if (code.length !== 6 || busy) return;
    if (await call("verify", { code })) {
      setEnrollment(null);
      setEnabled(true);
      setCode("");
    }
  }

  async function onDisable() {
    if (!disableCode.trim() || busy) return;
    if (await call("disable", { code: disableCode })) {
      setEnabled(false);
      setShowDisable(false);
      setDisableCode("");
    }
  }

  function onCodeKeyDown(action: () => void, cancel: () => void): React.KeyboardEventHandler {
    return (e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        action();
      } else if (e.key === "Escape") {
        cancel();
      }
    };
  }

  return (
    <section className="max-w-3xl rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2 font-medium text-foreground">
          {enabled ? (
            <ShieldCheck size={16} className="text-primary" />
          ) : (
            <ShieldOff size={16} className="text-muted" />
          )}
          Two-factor authentication
        </div>
        <p className="mt-1 text-sm text-muted">
          {enabled
            ? "Signing in requires a code from your authenticator app."
            : "Add a second step to sign-in: a 6-digit code from an authenticator app."}
        </p>
      </div>

      <div className="px-5 py-4">
        {!enabled && !enrollment && (
          <button
            onClick={onStartSetup}
            disabled={busy}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Enable two-factor authentication
          </button>
        )}

        {enrollment && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium text-foreground">
                1. Scan this QR code
              </div>
              <p className="mt-0.5 text-sm text-muted">
                Use Google Authenticator, 1Password, or any authenticator app.
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL, not an optimizable asset */}
              <img
                src={enrollment.qrDataUrl}
                alt="QR code for authenticator app"
                className="mt-2 rounded-lg border border-border bg-white"
                width={180}
                height={180}
              />
              <p className="mt-2 text-sm text-muted">
                Can&apos;t scan? Enter this key manually:{" "}
                <span className="select-all font-mono text-foreground">
                  {enrollment.secret}
                </span>
              </p>
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">
                2. Enter the 6-digit code from the app
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={onCodeKeyDown(onVerify, () => setEnrollment(null))}
                  placeholder="000000"
                  className={INPUT_CLASS}
                  disabled={busy}
                  autoFocus
                />
                <button
                  onClick={onVerify}
                  disabled={busy || code.length !== 6}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy && <Loader2 size={14} className="animate-spin" />}
                  Verify &amp; turn on
                </button>
                <button
                  onClick={() => {
                    setEnrollment(null);
                    setError(null);
                  }}
                  disabled={busy}
                  className="h-9 rounded-lg px-3 text-[13px] font-medium text-muted hover:bg-background hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {enabled && (
          <div className="text-sm text-muted">
            {enabledAt && <span>On since {new Date(enabledAt).toLocaleDateString()}. </span>}
            If you lose access to your authenticator app, ask your admin to
            reset two-factor for your account.
          </div>
        )}

        {enabled && (
          <div className="mt-4">
            {showDisable ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={onCodeKeyDown(onDisable, () => {
                    setShowDisable(false);
                    setDisableCode("");
                    setError(null);
                  })}
                  placeholder="6-digit code"
                  className={INPUT_CLASS}
                  disabled={busy}
                  autoFocus
                />
                <button
                  onClick={onDisable}
                  disabled={busy || disableCode.length !== 6}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3.5 text-[13px] font-medium text-red-600 hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy && <Loader2 size={14} className="animate-spin" />}
                  Turn off
                </button>
                <button
                  onClick={() => {
                    setShowDisable(false);
                    setDisableCode("");
                    setError(null);
                  }}
                  disabled={busy}
                  className="h-9 rounded-lg px-3 text-[13px] font-medium text-muted hover:bg-background hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowDisable(true)}
                className="text-[13px] font-medium text-muted underline-offset-2 hover:text-red-600 hover:underline"
              >
                Turn off two-factor authentication
              </button>
            )}
          </div>
        )}

        {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
      </div>
    </section>
  );
}
