import { db } from "../../db";
import { COMPETITORS_COPY as C } from "../copy";
import { OWN_MATERIAL_SOURCE_TYPE } from "../own";
import { syncProductLinesPage } from "../own-site";
import { AnalysisError, type RunContext } from "./engine";
import { estimateTokens, OUTPUT_RESERVE } from "./pacing";
import { injectedMapAnswer, LLMS_TXT_MAX_CHARS, MAP_MAX_SECTIONS, MAP_MAX_TOKENS, MAP_SYSTEM_PROMPT, MAP_VERSION, mapTool, parseMap, renderMap, type MapEntry } from "./prompts";
import { buildSections, hostOf, isLlmsTxt, ReadingPlan, SECTION_LABELS, sectionKey, type Section, type SectionLabel } from "./sections";

/**
 * The database side of the reading plan (Capability Analysis, "Map, read, go back"): the stored pages, the saved
 * sections (CompetitorSection) and the MAP step — the first step of an analysis run.
 *
 * The map step keeps no state of its own: every start builds the sections from the stored pages (sections.ts) and
 * asks PMOS AI only about the sections that have no saved label. A label is saved in the same transaction as the
 * call's other labels, so a run that stopped asks only what is left. There is no fallback: a map call that fails,
 * or whose answer names a code or a label outside the closed sets, fails the run.
 *
 * The organization's own source (own.ts): before its map, the organization's product lines are written as one
 * stored page of it (own-site.ts syncProductLinesPage); that page's section is labeled "product" in code, like the
 * home page — no map call is made for it.
 */

/** Tokens of instructions and schema a map call carries besides the section list. */
const MAP_OVERHEAD_TOKENS = 700;

export interface StoredPage {
  id: string;
  url: string;
  title: string | null;
  hash: string;
  chars: number;
  state: string;
  kind: string;
  sourceId: string;
  sourceType: string;
  hasText: boolean;
  analyzedKey: string | null;
  factsKey: string | null;
}

/** Every stored page of the competitor, all its sources, without the text. */
export async function loadPages(competitorId: string): Promise<StoredPage[]> {
  const rows = await db.sourcePage.findMany({
    where: { source: { competitorId } },
    select: { id: true, url: true, title: true, hash: true, chars: true, state: true, kind: true, sourceId: true, analyzedKey: true, factsKey: true, source: { select: { type: true } } },
  });
  // "Has text" without loading it: a page that was read has characters; a page whose text was dropped has none.
  const textless = new Set((await db.sourcePage.findMany({ where: { source: { competitorId }, text: null }, select: { id: true } })).map((p) => p.id));
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, hash: r.hash, chars: r.chars, state: r.state, kind: r.kind, sourceId: r.sourceId, sourceType: r.source.type, hasText: !textless.has(r.id), analyzedKey: r.analyzedKey, factsKey: r.factsKey }));
}

/** The competitor's saved reading plan. Empty before its first map step: nothing is read without a label. */
export async function loadReadingPlan(competitorId: string): Promise<ReadingPlan> {
  return new ReadingPlan(await db.competitorSection.findMany({ where: { competitorId }, select: { sourceId: true, prefix: true, label: true } }));
}

/** The plan of the run's competitor: read once per run, after the map step saved it. */
export async function planOf(ctx: RunContext): Promise<ReadingPlan> {
  ctx.plan ??= await loadReadingPlan(ctx.competitor.id);
  return ctx.plan;
}

/** The text of the site's /llms.txt when a stored page of the website has that path (nothing stores it yet; a later scanning change will). */
async function llmsTxt(pages: StoredPage[]): Promise<string | null> {
  const page = pages.find((p) => p.sourceType === "website" && p.state !== "removed" && p.hasText && isLlmsTxt(p.url));
  if (!page) return null;
  return (await db.sourcePage.findUnique({ where: { id: page.id }, select: { text: true } }))?.text ?? null;
}

const labelCounts = (rows: Array<{ label: string; pages: number }>): string =>
  SECTION_LABELS.map((l) => ({ l, n: rows.filter((r) => r.label === l).length })).filter((x) => x.n > 0).map((x) => `${x.n} ${x.l.replace("_", " ")}`).join(", ");

export async function mapStep(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  if (ctx.competitor.isOwn) {
    // The product lines are part of the own material: one stored page, due again whenever a product line changes.
    const synced = await syncProductLinesPage(workspaceId, competitorId);
    if (synced === "written") ctx.log("info", "Product lines written as a page of the own source (new or changed since they were last read)");
    else if (synced === "removed") ctx.log("info", "The organization has no product line any more: their page was removed from the own source");
  }
  const [pages, saved] = await Promise.all([
    loadPages(competitorId),
    db.competitorSection.findMany({ where: { competitorId }, select: { id: true, sourceId: true, prefix: true, pages: true, chars: true } }),
  ]);
  const savedKeys = new Set(saved.map((s) => sectionKey(s.sourceId, s.prefix)));
  const sections = buildSections(pages, { homeHost: hostOf(ctx.competitor.websiteUrl), existing: savedKeys });
  const built = new Map(sections.map((s) => [s.key, s]));

  // 1. Sizes: what each saved section holds today (0 pages when its folder is gone — the label stays, a decision).
  for (const s of saved) {
    const now = built.get(sectionKey(s.sourceId, s.prefix));
    const size = { pages: now?.pages ?? 0, chars: now?.chars ?? 0 };
    if (s.pages !== size.pages || s.chars !== size.chars) await db.competitorSection.update({ where: { id: s.id }, data: size });
  }

  // 2. The home page: its own section, always "product" — labeled in code, never asked.
  const fresh = sections.filter((s) => !savedKeys.has(s.key));
  const row = (s: Section, label: SectionLabel, by: "ai" | "code") => ({
    workspaceId, competitorId, sourceId: s.sourceId, prefix: s.prefix, label, pages: s.pages, chars: s.chars, labeledBy: by, mapVersion: by === "ai" ? MAP_VERSION : null, analysisId: ctx.run.id,
  });
  // So is the own material that is not on the website (the product-lines page of the organization's own source).
  const byCode = (s: Section) => s.home || s.sourceType === OWN_MATERIAL_SOURCE_TYPE;
  const home = fresh.filter(byCode);
  if (home.length) await db.competitorSection.createMany({ data: home.map((s) => row(s, "product", "code")), skipDuplicates: true });

  // 3. PMOS AI: only the sections with no label yet. No new section → no call.
  let left = fresh.filter((s) => !byCode(s));
  const asked = left.length;
  if (left.length) {
    const llms = await llmsTxt(pages);
    // The map sees the start of a long llms.txt only: a cap, recorded like any other.
    if (llms && llms.trim().length > LLMS_TXT_MAX_CHARS) ctx.cap("llms_txt_chars", { limit: LLMS_TXT_MAX_CHARS, undone: llms.trim().length - LLMS_TXT_MAX_CHARS });
    ctx.log("info", `Map: ${left.length} section${left.length === 1 ? "" : "s"} of the site ${left.length === 1 ? "has" : "have"} no label yet — asking PMOS AI${llms ? " (with the site's llms.txt)" : ""}`);
    while (left.length) {
      const batch = left.slice(0, MAP_MAX_SECTIONS);
      const entries: MapEntry[] = batch.map((s, n) => ({ code: `S${n + 1}`, section: { ...s, sourceLabel: s.sourceType === "website" ? null : C.profile.sourceTypes[s.sourceType] ?? s.sourceType } }));
      const sectionOf = new Map(entries.map((e, n) => [e.code, batch[n]]));
      const tail = renderMap({ name: ctx.competitor.name, site: ctx.competitor.websiteUrl }, entries, llms);
      const labeled = new Set<string>();
      await ctx.paced({
        items: [tail],
        concurrency: 1,
        estimate: (t) => estimateTokens(t.length) + MAP_OVERHEAD_TOKENS + OUTPUT_RESERVE,
        work: async (t) => {
          // TEST KNOB: the labels a test gave by section address; a section it does not name is "product".
          const injected = ctx.answers ? injectedMapAnswer(ctx.answers.map, entries) : undefined;
          const r = await ctx.call<Record<string, unknown>>(MAP_SYSTEM_PROMPT, "", t, mapTool(entries.map((e) => e.code)), { role: "read", maxTokens: MAP_MAX_TOKENS, thinking: "low", injected });
          ctx.counters.mapCalls++;
          const parsed = parseMap(r.value, entries.map((e) => e.code));
          // Closed sets: a code that was not asked or a label that does not exist is an unusable answer — nothing of it is saved.
          if (parsed.unknownCodes.length) throw new AnalysisError("answer", `PMOS AI's map answer named ${parsed.unknownCodes.length} section code${parsed.unknownCodes.length === 1 ? "" : "s"} that ${parsed.unknownCodes.length === 1 ? "was" : "were"} not asked (${parsed.unknownCodes.slice(0, 3).join(", ")})`);
          if (parsed.unknownLabels.length) throw new AnalysisError("answer", `PMOS AI's map answer used ${parsed.unknownLabels.length} label${parsed.unknownLabels.length === 1 ? "" : "s"} outside the list (${parsed.unknownLabels.slice(0, 3).join(", ")})`);
          const rows = [...parsed.labels.entries()].map(([code, label]) => row(sectionOf.get(code)!, label, "ai"));
          if (rows.length) await db.competitorSection.createMany({ data: rows, skipDuplicates: true });
          for (const code of parsed.labels.keys()) labeled.add(sectionOf.get(code)!.key);
          ctx.counters.mapLabeled += rows.length;
          return r.tokens;
        },
      });
      // No loop that could spin: a call that labels nothing fails the run. Sections the answer left out are asked in the next call.
      if (labeled.size === 0) throw new AnalysisError("answer", `PMOS AI labeled none of the ${batch.length} sections of a map call`);
      left = left.filter((s) => !labeled.has(s.key));
    }
  }

  ctx.plan = await loadReadingPlan(competitorId);
  const plan = await db.competitorSection.findMany({ where: { competitorId, pages: { gt: 0 } }, select: { label: true, pages: true } });
  ctx.counters.mapSections = plan.length;
  ctx.log("info", `Reading plan: ${plan.length} section${plan.length === 1 ? "" : "s"} (${labelCounts(plan) || "none"})${asked ? ` — ${asked} labeled in this run` : " — no new section, PMOS AI not asked"}`);
  await ctx.flush();
}
