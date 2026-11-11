import type { Prisma } from "@prisma/client";
import { db } from "../../db";
import { chunkBySize, dedupeFacts, factDateOf, FACTS_MAX_TOKENS, FACTS_SHARED, FACTS_SYSTEM_PROMPT, FACTS_TOOL, FACTS_VERSION, maxTotalChars, packedSize, parseFacts, renderFactsTail, type PageText } from "../ai";
import { COMPETITORS_COPY as C } from "../copy";
import { checkPii } from "../pii";
import type { RunContext } from "./engine";
import { estimateTokens, OUTPUT_RESERVE } from "./pacing";
import { loadPages } from "./steps";
import { carriedFactsBaseline, factsBaseline, factsTodo, readKey } from "./todo";

/**
 * The profile facts (tagline, products, pricing tiers, customers, funding …) — the last step of an analysis run.
 *
 * The same prompt, the same 6,000-character cut and chunking and the same upsert rules as before, when it ran
 * inside the scan. What changed is where it lives: one chunk at a time under the run's token budget, saved per
 * chunk, resumed from SourcePage.factsKey — and only while no other run is calling PMOS AI. It runs last, so the
 * table never waits for it; a failure here fails the run with the cells already applied.
 */
export async function factsStep(ctx: RunContext): Promise<void> {
  const competitorId = ctx.competitor.id;
  const workspaceId = ctx.run.workspaceId;
  const pages = await loadPages(competitorId);
  // Every stored page, whatever its kind: a press page says nothing about capabilities and a lot about the company.
  const todo = factsTodo(pages, FACTS_VERSION);
  if (!todo.length) return;

  // A source's first read is the baseline, not news. Decided once per run (a run that continues reads what it wrote),
  // and handed on: when the competitor's last run stopped inside this step, the sources it was reading for the first
  // time are still a first read — their remaining pages must not arrive as news in the feed and the email.
  let baseline = Array.isArray(ctx.run.cursor.factsBaselineSources) ? (ctx.run.cursor.factsBaselineSources as string[]) : null;
  if (!baseline) {
    const earlier = await db.competitorAnalysis.findMany({ where: { competitorId, id: { not: ctx.run.id } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { status: true, cursor: true } });
    baseline = factsBaseline([...new Set(pages.map((p) => p.sourceId))], pages, carriedFactsBaseline(earlier));
    await ctx.saveCursor({ factsBaselineSources: baseline });
  }
  const baselineSources = new Set(baseline);
  const chunks = chunkBySize(todo, (p) => packedSize(p.chars, p.url.length), maxTotalChars());
  const seen = new Set<string>();
  const scanId = ctx.run.scanId;
  let part = 0;
  let found = 0;
  let added = 0;
  ctx.log("info", `Profile facts: ${todo.length} page${todo.length === 1 ? "" : "s"} to read in ${chunks.length} call${chunks.length === 1 ? "" : "s"}`);
  await ctx.paced({
    items: chunks,
    // Each chunk is asked with the facts the chunks before it found.
    concurrency: 1,
    estimate: (chunk) => estimateTokens(chunk.reduce((n, p) => n + packedSize(p.chars, p.url.length), 0)) + 2_500 + OUTPUT_RESERVE,
    work: async (chunk) => {
      part++;
      // The text and its hash in one read: the key written below is the hash of the text that was read.
      const rows = await db.sourcePage.findMany({ where: { id: { in: chunk.map((p) => p.id) } }, select: { id: true, url: true, title: true, text: true, hash: true, kind: true } });
      const rowOf = new Map(rows.map((r) => [r.id, r]));
      const sourceOf = new Map(chunk.map((p) => [p.url, { id: p.sourceId, label: C.profile.sourceTypes[p.sourceType] ?? p.sourceType }]));
      const texts: PageText[] = [];
      for (const p of chunk) {
        const r = rowOf.get(p.id);
        if (r?.text != null) texts.push({ url: r.url, title: r.title ?? "", text: r.text, kind: r.kind, sourceLabel: sourceOf.get(p.url)?.label });
      }
      let tokens = 0;
      const writes: Array<(tx: Prisma.TransactionClient) => Promise<unknown>> = [];
      if (texts.length) {
        const known = await db.profileFact.findMany({ where: { competitorId, dismissedAt: null }, select: { kind: true, value: true }, orderBy: { createdAt: "asc" } });
        // TEST KNOB: every chunk gets this answer; none given = no fact.
        const injected = ctx.answers ? ctx.answers.facts ?? '{"facts": []}' : undefined;
        const r = await ctx.call<Record<string, unknown>>(FACTS_SYSTEM_PROMPT, FACTS_SHARED, renderFactsTail(ctx.competitor.name, known, texts, part, chunks.length), FACTS_TOOL, { maxTokens: FACTS_MAX_TOKENS, thinking: "low", injected });
        tokens = r.tokens;
        const facts = dedupeFacts(parseFacts(r.value), seen);
        found += facts.length;
        /** Rule 6: a snippet that names a person is dropped, never stored. */
        const clean = (text: string | null | undefined, what: string, url?: string): string | null => {
          const check = checkPii(text);
          if (!check.hit) return text || null;
          ctx.counters.piiHits++;
          ctx.log("warn", `PII check dropped a ${what} (${check.kind})`, url);
          return null;
        };
        const now = new Date();
        // A chunk whose sources were all never read before is the baseline; so is a fact on a page of such a source.
        const allBaseline = chunk.every((p) => baselineSources.has(p.sourceId));
        for (const f of facts) {
          if (!clean(f.value, `${f.kind} fact`, f.url)) continue;
          const factDate = factDateOf(f.date);
          const source = sourceOf.get(f.url);
          const sourceLabel = source?.label ?? sourceOf.get(chunk[0].url)?.label ?? null;
          const existing = await db.profileFact.findUnique({ where: { competitorId_kind_value: { competitorId, kind: f.kind, value: f.value } } });
          if (existing) {
            writes.push((tx) =>
              tx.profileFact.update({
                where: { id: existing.id },
                data: { ...(scanId ? { lastSeenScanId: scanId } : {}), unreachableAt: null, ...(existing.sourceUrl ? {} : { sourceUrl: f.url || null, sourceLabel }), ...(existing.factDate || !factDate ? {} : { factDate }) },
              }),
            );
            continue;
          }
          const headline = clean(f.headline, "fact headline", f.url);
          const summary = clean(f.summary, "fact summary", f.url);
          const isBaseline = source ? baselineSources.has(source.id) : allBaseline;
          writes.push((tx) =>
            tx.profileFact.create({
              data: { workspaceId, competitorId, kind: f.kind, value: f.value, sourceUrl: f.url || null, sourceLabel, factDate, scanId, lastSeenScanId: scanId, changedAt: isBaseline ? null : now, headline, summary, imageUrl: null },
            }),
          );
          added++;
          ctx.counters.factsNew++;
        }
      }
      // One transaction per chunk: its facts and the mark on its pages. A run that stops here continues with the next chunk.
      await db.$transaction(
        async (tx) => {
          for (const w of writes) await w(tx);
          for (const p of chunk) await tx.sourcePage.updateMany({ where: { id: p.id }, data: { factsKey: readKey(FACTS_VERSION, rowOf.get(p.id)?.hash ?? p.hash) } });
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
      if (chunks.length > 1) ctx.log("info", `Profile facts: part ${part} of ${chunks.length} done`);
      return tokens;
    },
  });
  ctx.log("info", `Profile facts: ${found} found, ${added} new`);
  await ctx.flush();
}
