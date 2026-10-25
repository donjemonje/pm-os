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
}

export async function readRobots(origin: string): Promise<RobotsRules> {
  const rules: RobotsRules = { disallow: [], sitemaps: [] };
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
    const res = await fetchPlain(smUrl);
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
  /** "home" | "sitemap" | "link" */
  via: string;
}

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

  constructor(host: string, rules: RobotsRules) {
    this.host = host;
    this.rules = rules;
  }

  add(u: URL, via: string): boolean {
    if (!isInsideSite(u, this.host) || !looksLikePage(u) || !isAllowed(u, this.rules)) return false;
    // Skip localized duplicates and obvious non-content paths.
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?)\//i.test(u.pathname) && !/^\/en\b/i.test(u.pathname)) return false;
    if (/\/(wp-json|wp-admin|wp-content|feed|tag|author|page\/\d+|cdn-cgi)\b/i.test(u.pathname)) return false;
    const key = pageKey(u);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.pending.push({ key, url: key, priority: pagePriority(u), via });
    return true;
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
