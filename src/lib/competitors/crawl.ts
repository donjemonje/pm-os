import { fetchPlain, USER_AGENT } from "./fetcher";
import { extractLinks } from "./html";
import { isInsideSite, looksLikePage, pageKey, pagePriority } from "./url";

/**
 * Which pages of a site to read: robots.txt rules, sitemap URLs when there
 * is one, then links discovered on fetched pages — all inside the registrable
 * host, ordered by usefulness, capped at the org's page limit (no depth cap).
 */

export interface RobotsRules {
  disallow: string[];
  sitemaps: string[];
  /** Crawl-delay for our user-agent group (or *), seconds; null when absent. */
  crawlDelaySec: number | null;
}

export async function readRobots(origin: string): Promise<RobotsRules> {
  const rules: RobotsRules = { disallow: [], sitemaps: [], crawlDelaySec: null };
  const res = await fetchPlain(new URL("/robots.txt", origin).href);
  if (!res.html || res.status >= 400) return rules;
  let applies = false;
  for (const raw of res.html.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      // Our UA names PM-OS; honour "*" and anything naming pm-os.
      applies = value === "*" || /pm-os/i.test(value);
    } else if (key === "disallow" && applies && value) {
      rules.disallow.push(value);
    } else if (key === "crawl-delay" && applies) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) rules.crawlDelaySec = n;
    } else if (key === "sitemap" && value) {
      rules.sitemaps.push(value);
    }
  }
  return rules;
}

/** robots.txt Disallow matching: prefix rules with "*" and "$" wildcards. */
export function isAllowed(u: URL, rules: RobotsRules): boolean {
  const path = u.pathname + u.search;
  for (const rule of rules.disallow) {
    let r = rule;
    try {
      // Some sites write absolute URLs in Disallow (Cyberint does).
      if (/^https?:\/\//i.test(r)) r = new URL(r).pathname;
    } catch {
      // keep as-is
    }
    const re = new RegExp("^" + r.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"));
    if (re.test(path)) return false;
  }
  return true;
}

const SITEMAP_CAP = 2000;

/** URLs listed in a sitemap (or sitemap index, one level deep). */
export async function readSitemap(urls: string[], host: string): Promise<URL[]> {
  const out: URL[] = [];
  const seen = new Set<string>();
  const queue = [...urls];
  let indexesFollowed = 0;
  while (queue.length && out.length < SITEMAP_CAP) {
    const smUrl = queue.shift()!;
    if (seen.has(smUrl)) continue;
    seen.add(smUrl);
    // robots.txt and a sitemap index are the competitor's files: a sitemap they name is fetched only when it is on this site.
    try {
      if (!isInsideSite(new URL(smUrl), host)) continue;
    } catch {
      continue;
    }
    const res = await fetchPlain(smUrl, { host });
    if (!res.html || res.status >= 400) continue;
    const isIndex = /<sitemapindex/i.test(res.html);
    for (const m of res.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      try {
        const u = new URL(m[1]);
        if (isIndex) {
          // Page sitemaps first; skip image/video/news/tag/author feeds.
          if (indexesFollowed < 12 && !/image|video|news|tag|author|category|attachment/i.test(u.pathname)) {
            queue.push(u.href);
            indexesFollowed++;
          }
        } else if (isInsideSite(u, host) && looksLikePage(u)) {
          out.push(u);
        }
      } catch {
        // not a URL
      }
    }
  }
  return out;
}

export interface PageCandidate {
  key: string;
  url: string;
  priority: number;
  /** "home" | "sitemap" | "link" | "known" (a page of an earlier scan) */
  via: string;
}

/** Why the frontier kept a URL out — reported to users as counts (and paths for robots). */
export type SkipReason = "robots";

/** Order: priority, then shorter paths (hub pages before leaves), then alphabetical. */
export function orderCandidates(list: PageCandidate[]): PageCandidate[] {
  return [...list].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const da = a.url.split("/").length;
    const dbb = b.url.split("/").length;
    if (da !== dbb) return da - dbb;
    return a.url.localeCompare(b.url);
  });
}

/**
 * The page frontier of one scan: seeded by the home page and the sitemap,
 * grown with links from every fetched page, always handing out the most
 * useful unread page next.
 */
export class Frontier {
  private readonly seen = new Set<string>();
  private pending: PageCandidate[] = [];
  private readonly host: string;
  private readonly rules: RobotsRules;
  /** Distinct paths robots.txt kept out, first 50 — shown in the scan log. */
  readonly robotsSkipped: string[] = [];
  /** Pages robots.txt kept out, all of them (the "robots" count). */
  robotsSkippedCount = 0;
  /** Every URL that pointed somewhere this scan (inbound link or sitemap entry) — feeds "unlinked". */
  readonly linked = new Set<string>();

  constructor(host: string, rules: RobotsRules) {
    this.host = host;
    this.rules = rules;
  }

  private noteSkip(reason: SkipReason, u: URL) {
    const list = reason === "robots" ? this.robotsSkipped : this.robotsSkipped;
    const path = u.pathname || "/";
    this.robotsSkippedCount++;
    if (list.length < 50 && !list.includes(path)) list.push(path);
  }

  /**
   * Queue a URL. Everything a human PM would look at is in: people pages,
   * localized copies and PDFs included (Website Scanning PRD 2026-11-04).
   * Only robots.txt, the site boundary and plain non-content paths keep a
   * URL out. `first` puts the page ahead of its priority class (a resumed
   * scan's pending pages).
   */
  add(u: URL, via: string, opts: { first?: boolean } = {}): boolean {
    if (!isInsideSite(u, this.host) || !looksLikePage(u)) return false;
    const key = pageKey(u);
    if (via === "link" || via === "sitemap") this.linked.add(key);
    if (!isAllowed(u, this.rules)) {
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this.noteSkip("robots", u);
      }
      return false;
    }
    // Obvious non-content paths (CMS internals, feeds, pagination duplicates).
    if (/\/(wp-json|wp-admin|wp-content|feed|page\/\d+|cdn-cgi)\b/i.test(u.pathname)) return false;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.pending.push({ key, url: key, priority: opts.first ? -1 : pagePriority(u), via });
    return true;
  }

  /** Discovered but not fetched (the scan stopped early) — "not attempted". */
  remainingUrls(): string[] {
    return this.pending.map((p) => p.url);
  }

  addLinksFrom(html: string, base: string): number {
    let n = 0;
    for (const u of extractLinks(html, base)) if (this.add(u, "link")) n++;
    return n;
  }

  next(): PageCandidate | undefined {
    if (!this.pending.length) return undefined;
    this.pending = orderCandidates(this.pending);
    return this.pending.shift();
  }

  get remaining(): number {
    return this.pending.length;
  }
}

export { USER_AGENT };
