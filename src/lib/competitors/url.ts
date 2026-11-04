/**
 * URL rules for competitor websites: normalization, the registrable host that
 * bounds a crawl, and the private-network guard (story checklist §12).
 */

/** Two-level public suffixes we meet in practice; others are one level. */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.il", "org.il", "ac.il", "gov.il", "com.au", "net.au", "org.au",
  "co.jp", "co.nz", "co.za", "com.br", "com.mx", "com.sg", "com.tr", "co.in", "co.kr",
]);

export class InvalidUrlError extends Error {
  readonly reason: "invalid" | "private" | "scheme";
  constructor(reason: "invalid" | "private" | "scheme") {
    super(reason);
    this.reason = reason;
  }
}

/** Registrable host: "www.docs.example.co.uk" → "example.co.uk". */
export function registrableHost(hostname: string): string {
  const parts = hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

function isPrivateHost(hostname: string): boolean {
  // URL keeps IPv6 literals in brackets ("[::1]").
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) {
    // IPv6 literal: loopback, link-local, unique-local, unspecified.
    return h === "::1" || h === "::" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd");
  }
  return false;
}

/**
 * A user-entered website → canonical https origin + registrable host.
 * Accepts "example.com", "www.example.com/pricing", "http://…"; rejects
 * non-http schemes and private addresses.
 */
export function normalizeWebsite(input: string): { url: string; host: string } {
  const raw = input.trim();
  if (!raw) throw new InvalidUrlError("invalid");
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new InvalidUrlError("invalid");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new InvalidUrlError("scheme");
  if (!u.hostname || !u.hostname.includes(".") && !isPrivateHost(u.hostname)) throw new InvalidUrlError("invalid");
  if (isPrivateHost(u.hostname)) throw new InvalidUrlError("private");
  if (u.username || u.password) throw new InvalidUrlError("invalid");
  const url = `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}`;
  return { url, host: registrableHost(u.hostname) };
}

/** True when `candidate` stays inside the site (same registrable host, http(s)). */
export function isInsideSite(candidate: URL, host: string): boolean {
  if (candidate.protocol !== "https:" && candidate.protocol !== "http:") return false;
  if (isPrivateHost(candidate.hostname)) return false;
  return registrableHost(candidate.hostname) === host;
}

/**
 * Canonical page key: origin + path without trailing slash, no query/hash —
 * except a video id (youtube.com/watch?v=…), where the query is the page.
 */
export function pageKey(u: URL): string {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const host = u.hostname.toLowerCase();
  const video = /(^|\.)youtube\.com$/.test(host) && path === "/watch" ? u.searchParams.get("v") : null;
  return `${u.protocol}//${host}${path}${video ? `?v=${video}` : ""}`;
}

/** Assets that are never pages. PDFs ARE pages (Website Scanning PRD 2026-11-04: "the entire website, PDFs included"). */
const NON_PAGE_EXT = /\.(css|js|mjs|json|xml|rss|atom|png|jpe?g|gif|svg|webp|avif|ico|zip|gz|mp4|mp3|webm|woff2?|ttf|eot|txt|csv)$/i;

export function looksLikePage(u: URL): boolean {
  return !NON_PAGE_EXT.test(u.pathname);
}

export function isPdfUrl(u: URL | string): boolean {
  const path = typeof u === "string" ? u.replace(/[?#].*$/, "") : u.pathname;
  return /\.pdf$/i.test(path);
}

/**
 * Crawl priority: lower sorts first. Product, platform, pricing, docs and
 * trust pages carry the capabilities; blog and news come last.
 */
export function pagePriority(u: URL): number {
  const p = u.pathname.toLowerCase();
  if (p === "/" || p === "") return 0;
  // The first segment decides the kind of page: a blog post about "product
  // updates" is still a blog post, and legal pages are never product pages.
  const first = p.split("/").filter(Boolean)[0] ?? "";
  if (/^(blog|news|press|newsroom|events?|webinars?|resources?|careers?|jobs|legal|terms|privacy|cookies?|login|signin|sign-in|signup|register|thank-you|tags?|authors?|category|wp-content|search)$/.test(first)) return 9;
  if (/terms|legal|privacy|policy|cookie|gdpr|disclaimer/.test(first)) return 9;
  if (/^(release-notes|changelog|whats-new|what-s-new|updates)$/.test(first)) return 7;
  // Only the first two segments say what a page is; words deeper in a slug
  // ("/research/…-use-cases-ai") do not make it a product page.
  const head = p.split("/").filter(Boolean).slice(0, 2).join("/");
  if (/pricing|plans/.test(head)) return 1;
  if (/^(products?|platform|solutions?|features?|capabilit|modules?|services?|use-cases?|usecases?|offerings?)(\/|$)/.test(first)) return 2;
  if (/integration|partner|marketplace|api|developer|docs|documentation|help|support/.test(head)) return 3;
  if (/trust|security|compliance|certification/.test(head)) return 4;
  if (/customer|case-stud|success|testimonial|industr|vertical/.test(head)) return 5;
  if (/about|company|why/.test(head)) return 6;
  return 8;
}
