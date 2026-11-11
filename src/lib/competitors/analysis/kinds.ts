/**
 * Which stored pages the analysis reads (Capability Analysis, "How the analysis runs").
 *
 * Page kinds are DATA: an ordered list of rules, first match wins, no logic in a rule. Three tiers:
 *   strong — read; evidence from it makes a cell "found"
 *   weak   — read only when the workspace setting readWeakPages is on; evidence from weak pages alone = "low confidence"
 *   skip   — never read
 *
 * Daniel 2026-11-11: "start lean with: product, features, pricing, docs, help, integrations. Skip blog, news,
 * careers, legal." So the default for a page no rule names is SKIP, with one exception: the site's home page is
 * read as a product page. Moving a kind between tiers, or adding a path word, is an edit of the lists below.
 *
 * Pure: no database, no network.
 */

export type PageTier = "strong" | "weak" | "skip";

export interface KindRule {
  kind: string;
  tier: PageTier;
  /** Matches the first path segment (lower case, file extension dropped). "" is the home page. */
  first?: RegExp;
  /** Matches the first two path segments joined by "/". */
  head?: RegExp;
  /** Matches the page's source type (a collector's source: documents, helpcenter, blog …). */
  sourceTypes?: readonly string[];
}

/** A site that lives under one of these prefixes is read as if the prefix were not there (/en/products/x = /products/x). */
export const ENGLISH_PREFIXES: readonly string[] = ["en", "en-us", "en-gb"];

/** Other languages: a localized copy of the site says nothing new. */
const LOCALES = "de|fr|es|it|pt|pt-br|nl|sv|da|no|fi|pl|cs|tr|ru|uk|he|ar|ja|jp|ko|zh|zh-cn|zh-tw|cn";

export const PAGE_KIND_RULES: readonly KindRule[] = [
  // 1–3. A collector's source says what its pages are, whatever their address.
  { kind: "docs", tier: "strong", sourceTypes: ["documents", "helpcenter", "apidocs", "changelog", "code", "marketplaces", "video", "archive"] },
  { kind: "news", tier: "weak", sourceTypes: ["blog", "press", "social", "reviews"] },
  { kind: "skipped", tier: "skip", sourceTypes: ["jobs", "events"] },
  // The home page: the one page outside the read list that is read (as a product page).
  { kind: "product", tier: "strong", first: /^$/ },
  // 4. Careers, legal, account and listing pages.
  { kind: "legal", tier: "skip", first: /^(careers?|jobs|legal|terms|privacy|cookies?|gdpr|disclaimer|login|signin|sign-in|signup|register|thank-you|search|tags?|authors?|category|events?|cart|checkout|account)$/ },
  // 5. Localized duplicates.
  { kind: "localized", tier: "skip", first: new RegExp(`^(${LOCALES})$`) },
  // 6. Blog, news, press.
  { kind: "news", tier: "weak", first: /^(blog|news|press|newsroom|press-releases?|media)$/ },
  // 7. Content marketing.
  { kind: "content", tier: "weak", first: /^(resources?|insights|articles|research|whitepapers?|ebooks?|reports?|webinars?|podcasts?|glossary|learn|academy|library)$/ },
  // 8. Pricing.
  { kind: "pricing", tier: "strong", head: /(^|[/-])(pricing|plans)([/-]|$)/ },
  // 9. Docs and help.
  { kind: "docs", tier: "strong", first: /^(docs|documentation|developers?|api|reference|help|support|kb|knowledge-base|faq|guides?|manual|release-notes|changelog|whats-new|datasheets?)$/ },
  // 10. Product, features, integrations.
  { kind: "product", tier: "strong", first: /^(products?|platform|solutions?|features?|capabilit.*|modules?|services?|use-cases?|offerings?|integrations?|marketplace|partners?|trust|security|compliance)$/ },
];

/** Everything no rule names: about, customers, company … — not read (Daniel 2026-11-11). */
export const DEFAULT_KIND = { kind: "other", tier: "skip" } as const;

/** Evidence rank of a kind: its index in this list (lower = stronger). */
export const KIND_RANK: readonly string[] = ["pricing", "docs", "product", "other", "content", "news"];

function segmentsOf(url: string): string[] {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0];
  }
  const segs = path
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/\.(html?|php|aspx?|jsp)$/, ""));
  // "index" is the folder's own page.
  if (segs.length && segs[segs.length - 1] === "index") segs.pop();
  if (segs.length && ENGLISH_PREFIXES.includes(segs[0])) segs.shift();
  return segs;
}

function matches(rule: KindRule, first: string, head: string, sourceType: string): boolean {
  if (rule.sourceTypes) return rule.sourceTypes.includes(sourceType);
  if (rule.first) return rule.first.test(first);
  if (rule.head) return rule.head.test(head);
  return false;
}

/**
 * The kind and tier of one stored page. `pageKind` is SourcePage.kind (page | document | …).
 *
 * The one exception in code: a document (a PDF) is never skipped for its folder — datasheets live under
 * /wp-content/uploads/ and the like. It is weak when a weak rule names its path, else a strong "docs" page.
 */
export function pageTier(url: string, sourceType: string, pageKind: string): { kind: string; tier: PageTier } {
  const segs = segmentsOf(url);
  const first = segs[0] ?? "";
  const head = segs.slice(0, 2).join("/");
  const rule = PAGE_KIND_RULES.find((r) => matches(r, first, head, sourceType));
  if (pageKind === "document" && !rule?.sourceTypes) {
    if (rule && rule.tier !== "skip") return { kind: rule.kind, tier: rule.tier };
    return { kind: "docs", tier: "strong" };
  }
  return rule ? { kind: rule.kind, tier: rule.tier } : { ...DEFAULT_KIND };
}

export interface PickablePage {
  id: string;
  url: string;
  hash: string;
  chars: number;
  /** SourcePage.state */
  state: string;
  /** SourcePage.kind */
  kind: string;
  sourceType: string;
  hasText: boolean;
}

/**
 * The pages the research step reads, sorted by url (plain string compare): tier strong, plus weak when readWeak.
 * Never: a page in state "removed", a page with no text.
 */
export function pickPages<T extends PickablePage>(pages: T[], opts: { readWeak: boolean }): Array<T & { tier: "strong" | "weak"; pageKind: string }> {
  const out: Array<T & { tier: "strong" | "weak"; pageKind: string }> = [];
  for (const p of pages) {
    if (p.state === "removed" || !p.hasText) continue;
    const t = pageTier(p.url, p.sourceType, p.kind);
    if (t.tier === "skip") continue;
    if (t.tier === "weak" && !opts.readWeak) continue;
    out.push({ ...p, tier: t.tier, pageKind: t.kind });
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}
