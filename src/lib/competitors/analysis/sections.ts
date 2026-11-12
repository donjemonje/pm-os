import { folderSkip, segmentsOf, sourceSkip, type PageTier } from "./kinds";

/**
 * The READING PLAN of a competitor (Capability Analysis, "Map, read, go back").
 *
 * A page used to be read only when its address had a known word (product, platform, pricing, docs …), which missed
 * products named by brand (/prisma, /cortex, /quantum, /product-brain). Now the site is cut into SECTIONS in code —
 * the stored pages under one address prefix — and PMOS AI labels each section once (the map step). What is read
 * follows from the label, by the rules in this file:
 *
 *   product, pricing, compare          → every page, in the broad read
 *   help, release_notes, api_docs      → the section's index pages in the broad read (the section root and its direct
 *                                        children); every deeper page is a DEEP page, read only when the run goes
 *                                        back for a gap (analysis/gaps.ts) and shown to the second look
 *   news                               → weak: read only when the workspace setting readWeakPages is on
 *   noise                              → never read
 *   a document (a PDF)                 → never skipped for its folder (datasheets live under /wp-content/uploads/):
 *                                        read in the broad read, weak only in a news section
 *   a section with no label yet        → not read (the next run's map step labels it)
 *
 * Pure: no database, no network.
 */

export const SECTION_LABELS = ["product", "pricing", "compare", "help", "release_notes", "api_docs", "news", "noise"] as const;
export type SectionLabel = (typeof SECTION_LABELS)[number];
export function isSectionLabel(v: unknown): v is SectionLabel {
  return typeof v === "string" && (SECTION_LABELS as readonly string[]).includes(v);
}

export interface LabelRule {
  /** The page kind its evidence ranks as (kinds.ts KIND_RANK); "other" for a label that is never read. */
  kind: string;
  tier: PageTier;
  /** all = every page in the broad read; index = index pages in the broad read, the rest deep; weak = with readWeakPages only; never = not read. */
  read: "all" | "index" | "weak" | "never";
}

/** Label → what is read and how its evidence ranks. Data: moving a label between rules is an edit of this table. */
export const LABEL_RULES: Record<SectionLabel, LabelRule> = {
  product: { kind: "product", tier: "strong", read: "all" },
  pricing: { kind: "pricing", tier: "strong", read: "all" },
  compare: { kind: "content", tier: "strong", read: "all" },
  help: { kind: "docs", tier: "strong", read: "index" },
  release_notes: { kind: "docs", tier: "strong", read: "index" },
  api_docs: { kind: "docs", tier: "strong", read: "index" },
  news: { kind: "news", tier: "weak", read: "weak" },
  noise: { kind: "other", tier: "skip", read: "never" },
};

/** A first-segment section with at least this many pages may be split one level deeper. */
export const SPLIT_MIN_PAGES = 40;
/** A sub-folder is sizable — it can become a section of its own — with at least this many pages. */
export const SPLIT_MIN_SUBFOLDER_PAGES = 5;
/** A big section is split only when it has at least this many sizable sub-folders. */
export const SPLIT_MIN_SUBFOLDERS = 2;
/** Sample titles and sample addresses shown to PMOS AI per section. */
export const SECTION_SAMPLES = 4;
/** An index page of a section is at most this many path segments below the section's prefix (0 = its root, 1 = a direct child). */
export const INDEX_DEPTH = 1;
/** The site's own description of its content, for the map call. Never a page of the plan. */
export const LLMS_TXT_PATH = "/llms.txt";

/** A stored page as the plan needs it. */
export interface PlanPage {
  id: string;
  url: string;
  /** SourcePage.state */
  state: string;
  /** SourcePage.kind (page | document | …) */
  kind: string;
  sourceId: string;
  sourceType: string;
  hasText: boolean;
  chars: number;
  title?: string | null;
}

/** The host of an address as sections name it: lower case, no leading "www.", with a non-default port. "" when the address is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isLlmsTxt(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase() === LLMS_TXT_PATH;
  } catch {
    return false;
  }
}

/** A section's address prefix: "acme.com/" (the root page), "acme.com/products", "acme.com/docs/api". */
export function prefixOf(host: string, segs: string[], depth: number): string {
  return `${host}/${segs.slice(0, depth).join("/")}`;
}

/** A section's identity inside one competitor. */
export function sectionKey(sourceId: string, prefix: string): string {
  return `${sourceId}|${prefix}`;
}

/** The path part of a prefix: "acme.com/docs/api" → "/docs/api". */
export function prefixPath(prefix: string): string {
  const i = prefix.indexOf("/");
  return i < 0 ? "/" : prefix.slice(i);
}

/**
 * Does the page take part in the plan? Every stored page that is there and has text, minus what code skips with
 * certainty (kinds.ts): jobs and events sources; careers, legal, account and listing folders; localized copies.
 * /llms.txt is the map's input, not a page.
 */
export function inPlan(p: Pick<PlanPage, "url" | "state" | "sourceType" | "hasText">): boolean {
  return p.state !== "removed" && p.hasText && !sourceSkip(p.sourceType) && !folderSkip(p.url) && !isLlmsTxt(p.url);
}

export interface Section {
  /** sectionKey(sourceId, prefix) */
  key: string;
  sourceId: string;
  sourceType: string;
  prefix: string;
  /** Path segments of the prefix: 0 = a root page, 1 = a first-segment section, 2 = a sub-folder split off. */
  depth: number;
  pages: number;
  chars: number;
  sampleTitles: string[];
  sampleUrls: string[];
  /** The home page of the competitor's website: its own section, always "product", labeled in code. */
  home: boolean;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The sections of a competitor's stored pages, sorted by prefix.
 *
 * 1. Pages are grouped by source, host and first path segment (after the English-prefix strip). A top-level page
 *    with nothing under it is a section of one page. The root page is a section of its own.
 * 2. A first-segment section with at least SPLIT_MIN_PAGES pages and at least SPLIT_MIN_SUBFOLDERS sub-folders of
 *    at least SPLIT_MIN_SUBFOLDER_PAGES pages each is split one level deeper: each such sub-folder is its own
 *    section, the rest (the section's root page, its direct pages, the small sub-folders) stays in the first-segment
 *    section. One level only.
 * 3. A sub-folder that already has a section of its own (`existing`: the keys saved by earlier runs) stays one,
 *    whatever its size today — a saved label is a decision and keeps its pages.
 *
 * `homeHost` is the host of the competitor's website (hostOf): the root page of a website source on that host is
 * the home page.
 */
export function buildSections<T extends PlanPage>(pages: T[], opts: { homeHost: string; existing?: Iterable<string> }): Section[] {
  const existing = new Set(opts.existing ?? []);
  interface Entry { p: T; segs: string[] }
  const groups = new Map<string, { sourceId: string; sourceType: string; host: string; first: string; entries: Entry[] }>();
  for (const p of pages) {
    if (!inPlan(p)) continue;
    const segs = segmentsOf(p.url);
    const host = hostOf(p.url);
    const first = segs[0] ?? "";
    const id = `${p.sourceId}|${host}|${first}`;
    const g = groups.get(id) ?? { sourceId: p.sourceId, sourceType: p.sourceType, host, first, entries: [] };
    g.entries.push({ p, segs });
    groups.set(id, g);
  }
  const out: Section[] = [];
  const emit = (g: { sourceId: string; sourceType: string; host: string }, depth: number, entries: Entry[]) => {
    if (!entries.length) return;
    const prefix = prefixOf(g.host, entries[0].segs, depth);
    // Samples: the shallowest pages first, then by address.
    const sorted = [...entries].sort((a, b) => a.segs.length - b.segs.length || cmp(a.p.url, b.p.url));
    const titles: string[] = [];
    for (const e of sorted) {
      const t = (e.p.title ?? "").replace(/\s+/g, " ").trim();
      if (t && !titles.includes(t)) titles.push(t);
      if (titles.length >= SECTION_SAMPLES) break;
    }
    out.push({
      key: sectionKey(g.sourceId, prefix),
      sourceId: g.sourceId,
      sourceType: g.sourceType,
      prefix,
      depth,
      pages: entries.length,
      chars: entries.reduce((n, e) => n + e.p.chars, 0),
      sampleTitles: titles,
      sampleUrls: sorted.slice(0, SECTION_SAMPLES).map((e) => e.p.url),
      home: depth === 0 && g.sourceType === "website" && g.host === opts.homeHost,
    });
  };
  for (const g of groups.values()) {
    if (g.first === "") {
      emit(g, 0, g.entries);
      continue;
    }
    const bySecond = new Map<string, Entry[]>();
    for (const e of g.entries) if (e.segs.length >= 2) bySecond.set(e.segs[1], [...(bySecond.get(e.segs[1]) ?? []), e]);
    const sizable = [...bySecond.entries()].filter(([, list]) => list.length >= SPLIT_MIN_SUBFOLDER_PAGES).map(([second]) => second);
    const split = g.entries.length >= SPLIT_MIN_PAGES && sizable.length >= SPLIT_MIN_SUBFOLDERS;
    const own = new Set<string>(split ? sizable : []);
    for (const second of bySecond.keys()) if (existing.has(sectionKey(g.sourceId, `${g.host}/${g.first}/${second}`))) own.add(second);
    for (const second of own) emit(g, 2, bySecond.get(second) ?? []);
    emit(g, 1, g.entries.filter((e) => !(e.segs.length >= 2 && own.has(e.segs[1]))));
  }
  return out.sort((a, b) => cmp(a.prefix, b.prefix) || cmp(a.sourceId, b.sourceId));
}

/** An index page of a section: its root or a direct child (INDEX_DEPTH). `pageSegments` and `sectionDepth` count path segments. */
export function isIndexPage(pageSegments: number, sectionDepth: number): boolean {
  return pageSegments - sectionDepth <= INDEX_DEPTH;
}

/** How one page is read. */
export interface PageRead {
  /** Its section's label; null = no section, or a page code decides without one (a skipped folder, a document there). */
  label: SectionLabel | null;
  /** The page kind its evidence ranks as (kinds.ts KIND_RANK). */
  kind: string;
  tier: PageTier;
  /** broad = in the broad read; deep = only when the run goes back for a gap; weak = in the broad read when readWeakPages is on; skip = never. */
  role: "broad" | "deep" | "weak" | "skip";
}

const SKIP = (kind: string, label: SectionLabel | null = null): PageRead => ({ label, kind, tier: "skip", role: "skip" });

/** A saved section of the plan (CompetitorSection). */
export interface PlannedSection {
  sourceId: string;
  prefix: string;
  label: string;
}

/** The saved plan of one competitor: which section a page belongs to and how the page is read. */
export class ReadingPlan {
  private readonly labels = new Map<string, SectionLabel>();

  constructor(sections: PlannedSection[]) {
    for (const s of sections) if (isSectionLabel(s.label)) this.labels.set(sectionKey(s.sourceId, s.prefix), s.label);
  }

  get size(): number {
    return this.labels.size;
  }

  /** The section the page belongs to: the deepest saved prefix that holds it. The root page belongs only to the root section. */
  sectionOf(page: { url: string; sourceId: string }): { prefix: string; depth: number; label: SectionLabel } | null {
    const segs = segmentsOf(page.url);
    const host = hostOf(page.url);
    for (let depth = Math.min(2, segs.length); depth >= Math.min(1, segs.length); depth--) {
      const prefix = prefixOf(host, segs, depth);
      const label = this.labels.get(sectionKey(page.sourceId, prefix));
      if (label) return { prefix, depth, label };
    }
    return null;
  }

  /** `kind` is SourcePage.kind (page | document | …). */
  read(page: { url: string; sourceId: string; sourceType: string; kind: string }): PageRead {
    if (sourceSkip(page.sourceType)) return SKIP("skipped");
    if (isLlmsTxt(page.url)) return SKIP("other");
    const document = page.kind === "document";
    // A document is never skipped for its folder: outside a section that is read whole it is a strong "docs" page.
    const asDocument = (label: SectionLabel | null): PageRead => ({ label, kind: "docs", tier: "strong", role: "broad" });
    const skipped = folderSkip(page.url);
    if (skipped) return document ? asDocument(null) : SKIP(skipped);
    const section = this.sectionOf(page);
    if (!section) return document ? asDocument(null) : SKIP("other");
    const rule = LABEL_RULES[section.label];
    if (rule.read === "weak") return { label: section.label, kind: rule.kind, tier: "weak", role: "weak" };
    if (rule.read === "all") return { label: section.label, kind: rule.kind, tier: "strong", role: "broad" };
    if (document) return asDocument(section.label);
    if (rule.read === "never") return SKIP(rule.kind, section.label);
    return { label: section.label, kind: rule.kind, tier: "strong", role: isIndexPage(segmentsOf(page.url).length, section.depth) ? "broad" : "deep" };
  }
}

/**
 * The pages the analysis may read, sorted by address, each with how it is read: broad and deep pages, plus weak
 * pages when the workspace reads them. Never: a page in state "removed", a page with no text, a skipped page.
 */
export function pickReadable<T extends Omit<PlanPage, "chars" | "title">>(pages: T[], plan: ReadingPlan, opts: { readWeak: boolean }): Array<T & { read: PageRead }> {
  const out: Array<T & { read: PageRead }> = [];
  for (const p of pages) {
    if (p.state === "removed" || !p.hasText) continue;
    const read = plan.read(p);
    if (read.role === "skip") continue;
    if (read.role === "weak" && !opts.readWeak) continue;
    out.push({ ...p, read });
  }
  return out.sort((a, b) => cmp(a.url, b.url));
}

/**
 * The reading order under a token budget: pricing, product, compare, then the help / release-notes / API-docs index
 * pages (and documents), then news, then deep pages. Lower reads first.
 */
export function readGroup(read: PageRead): number {
  if (read.role === "deep") return 5;
  if (read.role === "weak") return 4;
  if (read.kind === "pricing") return 0;
  if (read.kind === "product") return 1;
  if (read.kind === "content") return 2;
  return 3;
}

/** Pages in reading order: by group (readGroup), inside a group by address. */
export function sortForReading<T extends { url: string; read: PageRead }>(pages: T[]): T[] {
  return [...pages].sort((a, b) => readGroup(a.read) - readGroup(b.read) || cmp(a.url, b.url));
}
