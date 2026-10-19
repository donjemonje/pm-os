"use client";

/**
 * Product-usage telemetry, client side. `track(event, props)` queues an event;
 * the queue flushes every 5 s, at 20 events, or when the tab hides/unloads
 * (sendBeacon), so a busy session costs a handful of requests, not hundreds.
 * Behaviour only — decisions and edits are ReviewEvents written by the API.
 * Nothing leaves our own DB (POST /api/track).
 */
type Props = Record<string, string | number | boolean | null | undefined>;
interface Queued {
  event: string;
  props?: Props;
  path: string;
  ts: string;
}

const FLUSH_MS = 5000;
const FLUSH_AT = 20;
let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sessionId: string | null = null;
let bound = false;

function tabSession(): string {
  if (sessionId) return sessionId;
  try {
    const k = "pmos.tab";
    const v = sessionStorage.getItem(k);
    if (v) return (sessionId = v);
    const fresh = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(k, fresh);
    return (sessionId = fresh);
  } catch {
    return (sessionId = "na");
  }
}

function bind() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => flush(true));
}

export function flush(beacon = false): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const body = JSON.stringify({ sessionId: tabSession(), events: batch });
  if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
    return;
  }
  void fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Telemetry never surfaces errors to the user.
  });
}

export function track(event: string, props?: Props): void {
  if (typeof window === "undefined") return;
  bind();
  queue.push({ event, props, path: window.location.pathname, ts: new Date().toISOString() });
  if (queue.length >= FLUSH_AT) flush();
  else if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
}
