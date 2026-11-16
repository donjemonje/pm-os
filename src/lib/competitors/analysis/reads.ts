import type { PageRead, SectionLabel } from "./sections";

/**
 * WHAT THE ANALYSIS READS — a setting of the installation (Administration → Competitors; Daniel 2026-11-16).
 *
 * One switch per kind of content the map labels: product pages, pricing, compare pages, release notes, developer /
 * API docs, help center, blog and news. The reading asks this setting and nothing else: no kind is read or left
 * out because the code says so. (The "noise" label is not a kind of content: it marks what says nothing about the
 * product, and is never read.)
 *
 * Why it exists: one company's help center was 5,546 pages — 113 million tokens as stored, more than everything
 * else of six companies together. Help centers are OFF by default for now; release notes and developer docs stay
 * ON. Release notes win over where they sit: a release-notes page inside a help center or a blog is read as
 * release notes when release notes are ON, whatever the switch of the place it sits in says (the map names those
 * pages: analysis/plan.ts, SourcePage.readAs).
 *
 * It is a configuration, not a cap: a kind that is OFF leaves no cap record and sends no email. Every run records
 * which kinds were ON when it ran, says so in its log, and counts per company how many pages of each OFF kind it
 * left out. Turning a kind OFF deletes nothing — what was read stays, with its proofs; turning it ON makes its
 * pages due: the next run reads them as new chunks, with the list so far.
 *
 * The blog-and-news switch replaces the per-organization setting readWeakPages (one source of truth): a stored
 * value of that old setting is ignored.
 *
 * Room for later: a company may get its own override (effectiveReads takes one). No screen sets it today.
 *
 * Pure: no database, no network.
 */

/** The kinds, in the order the setting lists them. */
export const READ_KINDS = ["product", "pricing", "compare", "release_notes", "api_docs", "help", "news"] as const satisfies readonly SectionLabel[];
export type ReadKind = (typeof READ_KINDS)[number];
export type ReadSetting = Record<ReadKind, boolean>;

export function isReadKind(v: unknown): v is ReadKind {
  return typeof v === "string" && (READ_KINDS as readonly string[]).includes(v);
}

/** Help center OFF, blog and news OFF, everything else ON. */
export const READ_DEFAULTS: ReadSetting = { product: true, pricing: true, compare: true, release_notes: true, api_docs: true, help: false, news: false };

/** The setting as Administration shows it: the label of each switch, one line of help, and the short name a log line uses. */
export const READ_KIND_TEXT: Record<ReadKind, { label: string; help: string; short: string }> = {
  product: { label: "Product pages", help: "Pages that describe what the company sells: products, features, solutions, integrations.", short: "product" },
  pricing: { label: "Pricing", help: "The pricing page and its plan table.", short: "pricing" },
  compare: { label: "Compare pages", help: "Pages where the company compares itself with another company. Only what it says about itself is taken.", short: "compare" },
  release_notes: { label: "Release notes", help: "Release notes and changelogs — also the ones that sit inside a help center or a blog.", short: "release notes" },
  api_docs: { label: "Developer / API docs", help: "Developer documentation and API reference.", short: "developer docs" },
  help: { label: "Help center", help: "User guides, how-to and knowledge-base articles. Off by default: a help center can be larger than everything else of a company together.", short: "help center" },
  news: { label: "Blog and news", help: "Blog posts, news and press releases. Off by default. What is found only there shows as low confidence.", short: "blog and news" },
};

/** The stored setting ({ kinds: { help: true, … } }), kind by kind: a kind that is not stored as true or false keeps its default. */
export function readSettingOf(stored: unknown): ReadSetting {
  const out = { ...READ_DEFAULTS };
  const kinds = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>).kinds : null;
  if (kinds && typeof kinds === "object" && !Array.isArray(kinds)) {
    for (const k of READ_KINDS) {
      const v = (kinds as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

/** What an admin sent: some kinds, each true or false — or what is wrong with it. */
export function checkReadSetting(v: unknown): { value: Partial<ReadSetting> } | { error: string } {
  const names = READ_KINDS.join(", ");
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `"What the analysis reads" must be an object of kind → true or false (${names}).` };
  const value: Partial<ReadSetting> = {};
  for (const [k, on] of Object.entries(v as Record<string, unknown>)) {
    if (!isReadKind(k)) return { error: `"${k}" is not a kind of content. The kinds are: ${names}.` };
    if (typeof on !== "boolean") return { error: `"${k}" must be true or false.` };
    value[k] = on;
  }
  if (!Object.keys(value).length) return { error: `Name at least one kind (${names}).` };
  return { value };
}

/** What is stored for a setting. */
export function storedReadSetting(setting: ReadSetting): { kinds: ReadSetting } {
  return { kinds: { ...setting } };
}

/** The setting one company is read with: the installation's, with the company's own override on top when it has one (none has today). */
export function effectiveReads(installation: ReadSetting, company?: Partial<ReadSetting> | null): ReadSetting {
  const out = { ...installation };
  if (company) for (const k of READ_KINDS) if (typeof company[k] === "boolean") out[k] = company[k];
  return out;
}

/** The kind a page is read as: its label (a release-notes page inside a help center is "release_notes"); a document outside every section is read with the product pages. */
export function readKindOf(read: Pick<PageRead, "label">): ReadKind {
  return isReadKind(read.label) ? read.label : "product";
}

/** "Reading: product, pricing, compare, release notes, developer docs — not read: help center, blog and news" — one line for the run's log and for Administration. */
export function readsLine(setting: ReadSetting): string {
  const on = READ_KINDS.filter((k) => setting[k]).map((k) => READ_KIND_TEXT[k].short);
  const off = READ_KINDS.filter((k) => !setting[k]).map((k) => READ_KIND_TEXT[k].short);
  return `Reading: ${on.join(", ") || "nothing"}${off.length ? ` — not read: ${off.join(", ")}` : ""}`;
}

/** What a company has of a kind that is OFF. */
export interface NotRead {
  pages: number;
  /** Tokens of those pages as stored (characters / 4). */
  tokens: number;
}
export type NotReadByKind = Partial<Record<ReadKind, NotRead>>;

/**
 * A company's pages that the reading plan reads at all, split by the setting: the ones whose kind is ON, and — per
 * kind that is OFF — how many pages and tokens were left out. Nothing is dropped: a page left out stays stored and
 * is due the moment its kind is turned on.
 */
export function splitByReads<T extends { chars: number; read: Pick<PageRead, "label"> }>(pages: T[], setting: ReadSetting): { read: T[]; notRead: NotReadByKind } {
  const read: T[] = [];
  const notRead: NotReadByKind = {};
  for (const p of pages) {
    const kind = readKindOf(p.read);
    if (setting[kind]) {
      read.push(p);
      continue;
    }
    const n = notRead[kind] ?? { pages: 0, tokens: 0 };
    n.pages++;
    n.tokens += Math.ceil(p.chars / 4);
    notRead[kind] = n;
  }
  return { read, notRead };
}

/** The stored record of what was left out (a Json value), checked kind by kind. */
export function readNotRead(raw: unknown): NotReadByKind {
  const out: NotReadByKind = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  for (const k of READ_KINDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (!v || typeof v !== "object") continue;
    const pages = num((v as Record<string, unknown>).pages);
    if (pages) out[k] = { pages, tokens: num((v as Record<string, unknown>).tokens) };
  }
  return out;
}

/** "5,546 help center pages (~113,109k tokens as stored), 2,800 blog and news pages (~6,132k tokens as stored)" — "" when nothing was left out. */
export function notReadLine(notRead: NotReadByKind): string {
  return READ_KINDS.filter((k) => notRead[k]?.pages)
    .map((k) => `${notRead[k]!.pages.toLocaleString("en-US")} ${READ_KIND_TEXT[k].short} page${notRead[k]!.pages === 1 ? "" : "s"} (~${Math.round(notRead[k]!.tokens / 1000).toLocaleString("en-US")}k tokens as stored)`)
    .join(", ");
}

/** What a run records about the setting (CompetitorAnalysis.reads): the kinds that were on, and — for a run of one company — what it left out. */
export interface RunReads {
  kinds: ReadSetting;
  notRead: NotReadByKind;
}

/** A run's record, read back; null for a run from before the setting existed. */
export function readRunReads(raw: unknown): RunReads | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !(raw as Record<string, unknown>).kinds) return null;
  return { kinds: readSettingOf(raw), notRead: readNotRead((raw as Record<string, unknown>).notRead) };
}
