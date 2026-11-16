import { createHash } from "node:crypto";

/**
 * CHUNKS — what one reading request holds (Capability Analysis, "How the analysis runs"; Daniel 2026-11-16).
 *
 * The reading works on chunks of text, not on pages. A person collects notes across pages and then makes sense of
 * it all; PMOS AI can hold far more at once — so a company's pages are packed, in the "where a PM looks" order
 * (sections.ts READ_ORDER), into as few requests as a size cap allows, and each request gets one short answer.
 * A site whose readable pages fit under the cap is ONE request.
 *
 * The rules of packing (packChunks):
 *   1. Pages are taken in the order given and never reordered, so related pages — a page and its inner pages, one
 *      site after the other — stay neighbours.
 *   2. A chunk holds at most CHUNK_MAX_TOKENS of text (estimated: characters / 4). A page that does not fit starts
 *      the next chunk. A page larger than the cap goes alone.
 *   3. A section (the pages under one address prefix, sections.ts) that would fit in a chunk of its own is not cut
 *      in two just to fill a request: when it does not fit in what is left of the current chunk and that chunk is
 *      at least half full, the section starts the next chunk.
 *   4. The boundaries are reproducible and "prefix-stable": packing the pages that are left after the first chunks
 *      were read gives exactly the chunks that were left. A run that stopped continues with the same requests.
 *
 * THE SITE'S FRAME, ONCE. Many help centers repeat their whole table of contents on every page (measured
 * 2026-11-16: 5,546 help pages of one company, ~80,000 characters each, ~75,000 of them the same menu — 113M tokens
 * as stored, ~7M of own text). Nothing is trimmed: the lines that repeat on most pages of a source are shown ONCE
 * per request, in a block of their own, and left out of the pages under it. Only whole runs of such lines are
 * moved (FRAME_MIN_RUN), so a heading inside an article that happens to equal a menu entry stays where it is.
 * SHOW_SITE_FRAME_ONCE = false sends every page exactly as stored.
 *
 * Pure: no database, no network.
 */

/**
 * The size cap of one reading request, in tokens of page text (characters / 4 — an estimate that runs ~15% above
 * what the provider counts). The list so far and the instructions ride on top (a few percent). Quality may drop
 * near the model's 1M context: do NOT go above 700,000 without a measurement (Daniel 2026-11-16).
 */
export const CHUNK_MAX_TOKENS = 500_000;
/** A section starts the next chunk rather than being cut only when the current chunk is at least this full (rule 3). */
export const CHUNK_SECTION_BREAK_SHARE = 0.5;
/** Tokens a page's header line takes in a request, besides its text. */
export const PAGE_HEADER_TOKENS = 40;

/** Show the lines a source repeats on most of its pages once per request instead of on every page. */
export const SHOW_SITE_FRAME_ONCE = true;
/** The frame of a source is read off a sample of its pages: at most this many, evenly spaced in address order. */
export const FRAME_SAMPLE_PAGES = 200;
/** A source with fewer readable pages than this has no frame: there is too little to compare. */
export const FRAME_MIN_PAGES = 20;
/** A line belongs to the frame when it shows on at least this share of the sample pages. */
export const FRAME_LINE_SHARE = 0.5;
/** Only a run of at least this many frame lines in a row is moved out of a page. */
export const FRAME_MIN_RUN = 5;

export function tokensOf(chars: number): number {
  return Math.ceil(chars / 4);
}

// ————— The frame of a source —————

const lineKey = (line: string) => line.replace(/\s+/g, " ").trim();

/** `n` items of the list, evenly spaced, the first always among them — the same items for the same list. */
export function sampleEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]);
  return out;
}

export interface SiteFrame {
  /** The frame lines (whitespace collapsed). Empty = the source has no frame. */
  lines: Set<string>;
  /** The lines as one block, in the order of the sample page that holds the most of them. "" when there is none. */
  text: string;
}

export const NO_FRAME: SiteFrame = { lines: new Set(), text: "" };

/**
 * The frame of a source, from the texts of a sample of its pages: the lines that show on at least FRAME_LINE_SHARE
 * of them. Fewer than FRAME_MIN_PAGES texts → no frame.
 */
export function siteFrame(sampleTexts: string[], opts: { minPages?: number; share?: number } = {}): SiteFrame {
  const minPages = opts.minPages ?? FRAME_MIN_PAGES;
  if (sampleTexts.length < minPages) return NO_FRAME;
  const shown = new Map<string, number>();
  const perPage = sampleTexts.map((t) => t.split("\n").map(lineKey).filter(Boolean));
  for (const lines of perPage) for (const line of new Set(lines)) shown.set(line, (shown.get(line) ?? 0) + 1);
  const at = Math.ceil(sampleTexts.length * (opts.share ?? FRAME_LINE_SHARE));
  const lines = new Set([...shown.entries()].filter(([, n]) => n >= at).map(([line]) => line));
  if (!lines.size) return NO_FRAME;
  // The block is shown in a page's own order: the sample page that holds the most frame lines (the first such).
  let best: string[] = [];
  for (const page of perPage) {
    const own = [...new Set(page.filter((l) => lines.has(l)))];
    if (own.length > best.length) best = own;
  }
  const rest = [...lines].filter((l) => !best.includes(l)).sort();
  return { lines, text: [...best, ...rest].join("\n") };
}

/**
 * A page's text without the frame: every run of at least FRAME_MIN_RUN frame lines in a row is left out (blank
 * lines inside a run belong to it). Everything else stays exactly as stored, in place. With no frame the text is
 * returned untouched.
 */
export function withoutFrame(text: string, frame: SiteFrame, minRun: number = FRAME_MIN_RUN): string {
  if (!frame.lines.size) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let run: string[] = [];
  let frameLines = 0;
  const flush = () => {
    if (frameLines < minRun) out.push(...run);
    run = [];
    frameLines = 0;
  };
  for (const line of lines) {
    const key = lineKey(line);
    if (key === "") {
      // A blank line neither starts nor ends a run.
      if (run.length) run.push(line);
      else out.push(line);
      continue;
    }
    if (frame.lines.has(key)) {
      run.push(line);
      frameLines++;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}

// ————— Packing —————

/** A page as the packing sees it: where it is, and how many tokens its own text takes. */
export interface ChunkPage {
  id: string;
  sourceId: string;
  /** Its section in the reading plan (sections.ts sectionKey); "" when it has none. */
  section: string;
  /** Tokens of the page's text as it is sent (without the frame when the frame is shown once). */
  tokens: number;
}

export interface PackOptions {
  maxTokens?: number;
  /** Tokens of each source's frame block: it is in every chunk that holds a page of that source, once. */
  frameTokens?: ReadonlyMap<string, number>;
}

const pageSize = (p: ChunkPage) => p.tokens + PAGE_HEADER_TOKENS;

/** Pages in their order, packed into chunks by the four rules at the top of this file. No page is dropped. */
export function packChunks<T extends ChunkPage>(pages: T[], opts: PackOptions = {}): T[][] {
  const max = opts.maxTokens ?? CHUNK_MAX_TOKENS;
  const frame = (sourceId: string) => opts.frameTokens?.get(sourceId) ?? 0;
  // The size of each run of pages that share a section, from each page to the end of its run (the frame of its source included once).
  const restOfSection: number[] = new Array(pages.length).fill(0);
  for (let i = pages.length - 1; i >= 0; i--) {
    const sameRun = i + 1 < pages.length && pages[i + 1].section === pages[i].section && pages[i + 1].sourceId === pages[i].sourceId;
    restOfSection[i] = pageSize(pages[i]) + (sameRun ? restOfSection[i + 1] : 0);
  }
  const chunks: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  let sources = new Set<string>();
  const close = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    size = 0;
    sources = new Set();
  };
  pages.forEach((p, i) => {
    const extra = sources.has(p.sourceId) ? 0 : frame(p.sourceId);
    const need = pageSize(p) + extra;
    if (cur.length) {
      const startsSection = pages[i - 1].section !== p.section || pages[i - 1].sourceId !== p.sourceId;
      const sectionSize = restOfSection[i] + extra;
      // Rule 2: the page does not fit. Rule 3: the section would fit in a chunk of its own, not in what is left, and the chunk is half full.
      if (size + need > max || (startsSection && sectionSize <= max && size + sectionSize > max && size >= max * CHUNK_SECTION_BREAK_SHARE)) close();
    }
    if (!sources.has(p.sourceId)) {
      size += frame(p.sourceId);
      sources.add(p.sourceId);
    }
    cur.push(p);
    size += pageSize(p);
  });
  close();
  return chunks;
}

/** The estimated tokens of one chunk: its pages, their headers, and the frame of each source in it once. */
export function chunkTokens(chunk: ChunkPage[], frameTokens?: ReadonlyMap<string, number>): number {
  const sources = new Set(chunk.map((p) => p.sourceId));
  return chunk.reduce((n, p) => n + pageSize(p), 0) + [...sources].reduce((n, s) => n + (frameTokens?.get(s) ?? 0), 0);
}

/** What identifies the content of a chunk: its pages and the text each had (its hash) — the same pages with the same texts give the same key. */
export function chunkKey(pages: Array<{ id: string; hash: string }>): string {
  return createHash("sha256").update(pages.map((p) => `${p.id}:${p.hash}`).join("|")).digest("hex").slice(0, 32);
}

// ————— Rendering —————

export interface RenderPage {
  /** "P1" … in the order of the request. */
  code: string;
  url: string;
  /** What kind of page it is, as the guide names it: release_notes | help | api_docs | pricing | product | compare | news | document. */
  kind: string;
  title: string;
  /** The text as sent (the frame left out when it is shown once). */
  text: string;
}

export interface RenderFrame {
  /** What the source is ("Website", "Help center") and its address. */
  label: string;
  text: string;
}

/** One page of a request: a header line with its code, address, kind and title, then its text, whole. */
export function renderPage(p: RenderPage): string {
  return `=== PAGE ${p.code} | ${p.url} | kind: ${p.kind} | title: ${p.title.replace(/\s+/g, " ").trim()}\n${p.text}`;
}

/** The frame blocks and the pages of one request. */
export function renderChunk(frames: RenderFrame[], pages: RenderPage[]): string {
  const blocks = frames.filter((f) => f.text).map((f) => `=== SITE FRAME | ${f.label} — the lines below (menu, table of contents, footer) repeat on most pages of this site. They are shown here once and left out of the pages.\n${f.text}`);
  return [...blocks, ...pages.map(renderPage)].join("\n\n");
}
