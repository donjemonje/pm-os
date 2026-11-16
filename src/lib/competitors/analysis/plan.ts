import { Prisma } from "@prisma/client";
import { db } from "../../db";
import { COMPETITORS_COPY as C } from "../copy";
import { OWN_MATERIAL_SOURCE_TYPE } from "../own";
import { syncProductLinesPage } from "../own-site";
import { looksForReleaseNotes } from "./reads";
import { AnalysisError, type RunContext } from "./engine";
import { estimateTokens, OUTPUT_RESERVE } from "./pacing";
import {
  injectedMapAnswer,
  injectedMapPagesAnswer,
  LLMS_TXT_MAX_CHARS,
  MAP_MAX_SECTIONS,
  MAP_MAX_TOKENS,
  MAP_PAGES_BATCH,
  MAP_PAGES_MAX_TOKENS,
  MAP_PAGES_SYSTEM_PROMPT,
  MAP_SYSTEM_PROMPT,
  MAP_VERSION,
  mapPagesTool,
  mapTool,
  parseMap,
  parseMapPages,
  renderMap,
  renderMapPages,
  type MapEntry,
  type MapPageEntry,
} from "./prompts";
import { buildSections, compareAddress, hostOf, inPlan, isLlmsTxt, MAP_SKIM_CHARS, PAGE_PICK_LABELS, READ_AS_NONE, READ_AS_RELEASE_NOTES, ReadingPlan, sampleOpenings, SECTION_LABELS, sectionKey, type SampleHead, type Section, type SectionLabel } from "./sections";

/**
 * The database side of the reading plan (Capability Analysis, "How the analysis runs"): the stored pages, the saved
 * sections (CompetitorSection) and the MAP step — the first step of an analysis run.
 *
 * The map step keeps no state of its own: every start builds the sections from the stored pages (sections.ts) and
 * asks PMOS AI only about the sections that have no saved label. It skims: each section is shown with a few sample
 * pages — address, title and the first lines of the page's own text — never a whole page. A label is saved in the same transaction as the
 * call's other labels, so a run that stopped asks only what is left. There is no fallback: a map call that fails,
 * or whose answer names a code or a label outside the closed sets, fails the run.
 *
 * Release notes inside a help center or a blog (Daniel 2026-11-16): after the sections are labeled, the pages of
 * the sections labeled help or news are looked at one by one — address and title, never the text — and PMOS AI
 * names the release-notes pages among them by code. The answer is kept on the page (SourcePage.readAs), so a page
 * is asked about once; a later run asks only about pages that are new. Such a page is read as release notes
 * whatever the switch of the place it sits in says (analysis/reads.ts).
 *
 * The organization's own source (own.ts): before its map, the organization's product lines are written as one
 * stored page of it (own-site.ts syncProductLinesPage); that page's section is labeled "product" in code, like the
 * home page — no map call is made for it.
 */

/** Tokens of instructions and schema a map call carries besides the section list. */
const MAP_OVERHEAD_TOKENS = 700;
/** Tokens one page takes in a page-pick call: its code, its address, its title. */
const MAP_PAGE_LINE_TOKENS = 45;

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
  /** The map's word on a page of a help-center or blog section (sections.ts): "release_notes" | "none" | null = not looked at. */
  readAs: string | null;
}

/** Every stored page of the competitor, all its sources, without the text. */
export async function loadPages(competitorId: string): Promise<StoredPage[]> {
  const rows = await db.sourcePage.findMany({
    where: { source: { competitorId } },
    select: { id: true, url: true, title: true, hash: true, chars: true, state: true, kind: true, sourceId: true, analyzedKey: true, readAs: true, source: { select: { type: true } } },
  });
  // "Has text" without loading it: a page that was read has characters; a page whose text was dropped has none.
  const textless = new Set((await db.sourcePage.findMany({ where: { source: { competitorId }, text: null }, select: { id: true } })).map((p) => p.id));
  return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, hash: r.hash, chars: r.chars, state: r.state, kind: r.kind, sourceId: r.sourceId, sourceType: r.source.type, hasText: !textless.has(r.id), analyzedKey: r.analyzedKey, readAs: r.readAs }));
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

/** The text of the site's /llms.txt when a stored page of the website has that path: the search for the company's other addresses stores it and refreshes it (address-search.ts storeLlmsTxt). */
async function llmsTxt(pages: StoredPage[]): Promise<string | null> {
  const page = pages.find((p) => p.sourceType === "website" && p.state !== "removed" && p.hasText && isLlmsTxt(p.url));
  if (!page) return null;
  return (await db.sourcePage.findUnique({ where: { id: page.id }, select: { text: true } }))?.text ?? null;
}

/** The first lines of every sample page of the sections (sections.ts sampleOpenings), from the start of each page's stored text — never the whole text. */
export async function sampleOpeningsOf(sections: Section[]): Promise<Map<string, string>> {
  const sampleOf = new Map(sections.flatMap((s) => s.samples.map((p) => [p.id, { sourceId: s.sourceId, title: p.title }] as const)));
  const ids = [...sampleOf.keys()];
  const heads: SampleHead[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db.$queryRaw<Array<{ id: string; head: string | null }>>`SELECT id, substr(text, 1, ${MAP_SKIM_CHARS}::int) AS head FROM "SourcePage" WHERE id IN (${Prisma.join(ids.slice(i, i + 1000))})`;
    for (const r of rows) heads.push({ id: r.id, sourceId: sampleOf.get(r.id)?.sourceId ?? "", title: sampleOf.get(r.id)?.title, head: r.head ?? "" });
  }
  return sampleOpenings(heads);
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
    // The map skims: every sample page carries the first lines of its own text. The site's frame (menu, banner) is
    // told apart by comparing the sample pages of ALL the source's sections, not only of the ones asked now.
    const openings = await sampleOpeningsOf(sections);
    while (left.length) {
      const batch = left.slice(0, MAP_MAX_SECTIONS);
      const entries: MapEntry[] = batch.map((s, n) => ({
        code: `S${n + 1}`,
        section: {
          prefix: s.prefix, pages: s.pages,
          samples: s.samples.map((p) => ({ url: p.url, title: p.title, opening: openings.get(p.id) ?? "" })),
          sourceLabel: s.sourceType === "website" ? null : C.profile.sourceTypes[s.sourceType] ?? s.sourceType,
        },
      }));
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
          const r = await ctx.call<Record<string, unknown>>(MAP_SYSTEM_PROMPT, "", t, mapTool(entries.map((e) => e.code)), { role: "read", maxTokens: MAP_MAX_TOKENS, injected });
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

  // 4. Release notes inside a help center or a blog: the pages of those sections the map has not looked at yet.
  await pickReleaseNotes(ctx, pages, ctx.plan);
  await ctx.flush();
}

/**
 * The page pick. To-do: the stored pages of sections labeled help or news that the map never looked at (readAs is
 * null), in address order, MAP_PAGES_BATCH per call. Every call is saved in one write per answer — the pages it
 * named are release notes, every other page of the call is not — so a run that stopped asks only what is left.
 *
 * Not asked at all while "Release notes" is off in "What the analysis reads": the answer would change nothing that
 * is read. The pages stay not looked at and are asked about the moment release notes are turned on.
 *
 * AN ANSWER THAT CANNOT BE USED DOES NOT STOP THE RUN HERE (decided after the first real run, 2026-11-16, where one
 * unparseable answer of 19 calls stopped a whole setup run). That is right for THIS call and only for it:
 *   - it is a closed-set question asked once per page, and nothing of an unusable answer is saved — neither a "yes"
 *     nor a "no": the pages of that call simply stay not looked at;
 *   - nothing later in the run needs them looked at: a page that was not looked at is what its section is (a help
 *     or a blog page), exactly as before this step existed;
 *   - the next run of the company finds those pages on this very to-do and asks about them again — the same
 *     mechanism that continues a stopped run, with no retry inside this run and nothing left to chance;
 *   - it is not silent: the case is kept on the run as an incident with the answer's text as it came (engine.ts),
 *     it is a line of the log, it is counted (mapPagesUnanswered), and the run sends its one email to support.
 * "Cannot be used" = the model boundary could not read it (invalid JSON, empty, cut off), or it named a page code
 * that was not asked. The section map above is different and still fails the run on either: every later step
 * reads by its labels.
 */
async function pickReleaseNotes(ctx: RunContext, pages: StoredPage[], plan: ReadingPlan): Promise<void> {
  const todo = pages
    .filter((p) => p.readAs == null && inPlan(p) && p.kind !== "document")
    .map((p) => ({ page: p, label: plan.sectionOf(p)?.label ?? null }))
    .filter((x): x is { page: StoredPage; label: SectionLabel } => x.label != null && PAGE_PICK_LABELS.includes(x.label))
    .sort((a, b) => compareAddress(a.page.url, b.page.url));
  const known = pages.filter((p) => p.readAs === READ_AS_RELEASE_NOTES && p.state !== "removed").length;
  if (todo.length && !looksForReleaseNotes(ctx.reads)) {
    ctx.log("info", `Map, page by page: not asked — "Release notes" is off in "What the analysis reads", so naming the release-notes pages among ${todo.length} help-center and blog page${todo.length === 1 ? "" : "s"} would change nothing that is read. They are looked at when it is turned on`);
    return;
  }
  if (!todo.length) {
    if (known) ctx.log("info", `Release notes inside help-center and blog sections: ${known} page${known === 1 ? "" : "s"} named by earlier runs — no new page to look at`);
    return;
  }
  const batches: Array<typeof todo> = [];
  for (let i = 0; i < todo.length; i += MAP_PAGES_BATCH) batches.push(todo.slice(i, i + MAP_PAGES_BATCH));
  ctx.log("info", `Map, page by page: ${todo.length} page${todo.length === 1 ? "" : "s"} of help-center and blog sections not looked at yet — asking PMOS AI which of them are release notes (address and title only), in ${batches.length} call${batches.length === 1 ? "" : "s"}`);
  let named = 0;
  let unanswered = 0;
  /** The pages of a call whose answer could not be used stay not looked at: nothing is saved for them, and the next run asks again. */
  const leave = (batch: (typeof batches)[number], why: string) => {
    unanswered += batch.length;
    ctx.counters.mapPagesUnanswered += batch.length;
    ctx.log("warn", `Map, page by page: the answer for ${batch.length} page${batch.length === 1 ? "" : "s"} (${batch[0].page.url} … ${batch[batch.length - 1].page.url}) could not be used — ${why}. Nothing of it is saved: these pages stay not looked at (each is read as what its section is) and the next run of ${ctx.competitor.name} asks about them again. The case is kept as an incident`);
  };
  await ctx.paced({
    items: batches,
    // The calls do not depend on each other: they go at the run's own speed. A run with injected answers makes them one at a time.
    concurrency: ctx.answers ? 1 : "self",
    estimate: (batch) => batch.length * MAP_PAGE_LINE_TOKENS + MAP_OVERHEAD_TOKENS + OUTPUT_RESERVE,
    work: async (batch) => {
      const entries: MapPageEntry[] = batch.map((x, n) => ({ code: `P${n + 1}`, url: x.page.url, title: (x.page.title ?? "").replace(/\s+/g, " ").trim(), label: x.label }));
      // TEST KNOB: the release-notes pages a test named by address; a page it does not name is not one.
      const injected = ctx.answers ? injectedMapPagesAnswer(ctx.answers.releaseNotes, entries) : undefined;
      const r = await ctx.call<Record<string, unknown>>(MAP_PAGES_SYSTEM_PROMPT, "", renderMapPages(ctx.competitor.name, entries), mapPagesTool(entries.map((e) => e.code)), { role: "read", maxTokens: MAP_PAGES_MAX_TOKENS, injected });
      ctx.counters.mapCalls++;
      const parsed = parseMapPages(r.value, entries.map((e) => e.code));
      // A closed set: a code that was not asked makes the answer unusable — nothing of it is saved, the case is kept.
      if (parsed.unknownCodes.length) {
        ctx.incident({ kind: "unknown_item", request: null, itemKind: "page", item: parsed.unknownCodes.slice(0, 10).join(", "), parent: null, quote: "", pageCode: "", pageUrl: null, pageId: null, pageHash: null, foundOn: null });
        leave(batch, `it named ${parsed.unknownCodes.length} page code${parsed.unknownCodes.length === 1 ? "" : "s"} that ${parsed.unknownCodes.length === 1 ? "was" : "were"} not asked (${parsed.unknownCodes.slice(0, 3).join(", ")})`);
        return r.tokens;
      }
      const yes = batch.filter((_, n) => parsed.releaseNotes.has(entries[n].code)).map((x) => x.page.id);
      const no = batch.filter((_, n) => !parsed.releaseNotes.has(entries[n].code)).map((x) => x.page.id);
      await db.$transaction([
        db.sourcePage.updateMany({ where: { id: { in: yes } }, data: { readAs: READ_AS_RELEASE_NOTES } }),
        db.sourcePage.updateMany({ where: { id: { in: no } }, data: { readAs: READ_AS_NONE } }),
      ]);
      // The plan the later steps use was read before this call: its pages carry the answer now.
      for (const x of batch) x.page.readAs = yes.includes(x.page.id) ? READ_AS_RELEASE_NOTES : READ_AS_NONE;
      named += yes.length;
      ctx.counters.mapPagesAsked += batch.length;
      ctx.counters.mapReleaseNotes += yes.length;
      return r.tokens;
    },
    // The model boundary could not read the answer (the engine kept its text as an incident): this call's pages stay not looked at, the others go on.
    onAnswerError: async (batch, e) => leave(batch, e.message),
  });
  ctx.log(unanswered ? "warn" : "info", `Map, page by page: ${named} of ${todo.length - unanswered} page${todo.length - unanswered === 1 ? " is" : "s are"} release notes${named ? " — read as release notes, whatever the switch of the help center or the blog says" : ""}${known ? ` (${known} named by earlier runs)` : ""}${unanswered ? ` — ${unanswered} page${unanswered === 1 ? " was" : "s were"} not looked at: the answer of ${unanswered === 1 ? "its" : "their"} call could not be used; the next run asks again` : ""}`);
}
