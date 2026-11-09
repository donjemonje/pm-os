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

/** Registrable host: "www.docs.example.co.uk" → "example.co.uk". IP literals and single labels ("localhost") stay as they are. */
export function registrableHost(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(lower) || lower.includes(":") || !lower.includes(".")) return lower;
  const parts = lower.split(".");
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

/**
 * The site a URL belongs to (Website Scanning PRD: "one domain — app.pm-os.io
 * is a separate add"): the hostname without a leading "www.", plus a
 * non-default port. So www.acme.com and acme.com are one site; docs.acme.com
 * is another competitor source. Real websites never carry a port; the port
 * keeps two fixture sites apart in tests.
 */
export function siteHost(u: URL): string {
  const h = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return `${h}${u.port ? `:${u.port}` : ""}`;
}

/**
 * TEST KNOB (never in production): let a competitor site live on localhost so
 * the e2e fixture (tests/fixtures/fake-site) can be scanned. Logic unchanged
 * otherwise — the private-network guard stays on everywhere else.
 */
function privateHostsAllowed(): boolean {
  const knobs = process.env.COMPETITORS_TEST_KNOBS?.trim().toLowerCase();
  if (!(knobs === "on" || knobs === "true" || knobs === "1")) return false;
  const v = process.env.COMPETITORS_ALLOW_PRIVATE_HOSTS?.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

export function isPrivateHost(hostname: string): boolean {
  if (privateHostsAllowed()) return false;
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
  // A single-label host ("localhost") is only a website in the test environment (private-hosts knob).
  if (!u.hostname || (!u.hostname.includes(".") && !privateHostsAllowed() && !isPrivateHost(u.hostname))) throw new InvalidUrlError("invalid");
  if (isPrivateHost(u.hostname)) throw new InvalidUrlError("private");
  if (u.username || u.password) throw new InvalidUrlError("invalid");
  const url = `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}`;
  return { url, host: siteHost(u) };
}

/** True when `candidate` stays inside the site (same registrable host, http(s)). */
export function isInsideSite(candidate: URL, host: string): boolean {
  if (candidate.protocol !== "https:" && candidate.protocol !== "http:") return false;
  if (isPrivateHost(candidate.hostname)) return false;
  return siteHost(candidate) === host;
}

/**
 * Canonical page key: origin + path without trailing slash, no query/hash —
 * except a video id (youtube.com/watch?v=…), where the query is the page.
 * With `site` (the source's website address), the http/https and www/bare
 * copies of the site's own host collapse onto that address: one page, one
 * row (PRD: "www.pm-os.io and pm-os.io are the same site"). Subdomains stay
 * what they are.
 */
export function pageKey(u: URL, site?: string | URL | null): string {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  let host = u.host.toLowerCase();
  let protocol = u.protocol;
  if (site) {
    const s = typeof site === "string" ? new URL(site) : site;
    if (siteHost(u) === siteHost(s)) {
      host = s.host.toLowerCase();
      protocol = s.protocol;
    }
  }
  const video = /(^|\.)youtube\.com$/.test(host) && path === "/watch" ? u.searchParams.get("v") : null;
  return `${protocol}//${host}${path}${video ? `?v=${video}` : ""}`;
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
