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

/** Canonical page key: origin + path without trailing slash, no query/hash. */
export function pageKey(u: URL): string {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.protocol}//${u.hostname.toLowerCase()}${path}`;
}

const NON_PAGE_EXT = /\.(css|js|mjs|json|xml|rss|atom|png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|gz|mp4|mp3|webm|woff2?|ttf|eot|txt|csv)$/i;

export function looksLikePage(u: URL): boolean {
  return !NON_PAGE_EXT.test(u.pathname);
}

/**
 * Crawl priority: lower sorts first. Product, platform, pricing, docs and
 * trust pages carry the capabilities; blog and news come last.
 */
export function pagePriority(u: URL): number {
  const p = u.pathname.toLowerCase();
  if (p === "/" || p === "") return 0;
  if (/pricing|plans/.test(p)) return 1;
  if (/product|platform|solution|feature|capabilit|module|service|use-case|usecase/.test(p)) return 2;
  if (/integration|partner|marketplace|api|developer|docs|documentation|help|support/.test(p)) return 3;
  if (/trust|security|compliance|certification|privacy/.test(p)) return 4;
  if (/customer|case-stud|success|testimonial|industr|vertical/.test(p)) return 5;
  if (/about|company|why/.test(p)) return 6;
  if (/release|changelog|what-?s-new|updates/.test(p)) return 7;
  if (/blog|news|press|event|webinar|resource|career|job|legal|terms|cookie|login|signin|sign-in|signup|register|thank/.test(p)) return 9;
  return 8;
}
