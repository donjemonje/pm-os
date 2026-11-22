/**
 * The news feed — news about what happened at the competitors, and nothing else.
 *
 * An item is a NEW ABILITY: something the news intake (news/intake.ts) found on a new or changed page of a
 * competitor that was not on the company's list before. One CompetitorNews row with verdict "new" whose evidence is
 * on its page is one item. No sizes here: capability or feature belongs to the table. News that is already on the
 * list, and news that is not an ability (people, money, deals, prices), is stored and never shown here.
 *
 * The feed is not an audit log of the table (Daniel 2026-11-22: showing table changes here was a bug). It no longer
 * reports a status that moved in the table, a capability a scan suggested or a dated fact; the code that derived
 * those items is gone, not switched off.
 *
 * Items found before the workspace's `baselineUntil` are history, not news. Read state is per user
 * (CompetitorFeedRead).
 */
import { db } from "../db";
import { NOT_OWN } from "./own";
import { abilityPhrase } from "./news/intake";

/** The one kind of item the feed holds. */
export type FeedKind = "ability";
export type FeedImpact = "High" | "Medium" | "Low";

export interface FeedItem {
  /** news:<CompetitorNews id> — the read-state key. */
  key: string;
  kind: FeedKind;
  impact: FeedImpact;
  /** When the intake found it. */
  at: string;
  competitorId: string;
  competitorName: string;
  /** The ability's name. */
  title: string;
  /** The date the page states, when it states one. */
  publishedAt: string | null;
  /** One phrase, no label: the problem it solves, then how it solves it. */
  summary: string | null;
  /** The evidence: the passage of the page that shows it, and the page. */
  quote: string | null;
  sourceUrl: string | null;
  /** The source type of the page it was on (changelog, helpcenter, press, …), when known. */
  sourceType: string | null;
  /** How PMOS AI understood it: the problem it solves (also the first part of `summary`), the workflows it is part of, who it is for. */
  problem: string | null;
  workflows: string | null;
  audience: string | null;
  read: boolean;
}

/** The feed's source-type label for the kind of page a piece of news was on (copy: profile.sourceTypes). */
const NEWS_SOURCE_TYPE: Record<string, string> = { release_notes: "changelog", help: "helpcenter", api_docs: "apidocs", news: "press", blog: "blog", product: "website" };

export const FEED_LIMIT = 500;

const IMPACT_RANK: Record<FeedImpact, number> = { High: 0, Medium: 1, Low: 2 };

/** The date an item is about: the page's own date when it states one, else when the intake found it. */
export function newsDate(item: Pick<FeedItem, "at" | "publishedAt">): string {
  return item.publishedAt ?? item.at;
}

/** Feed order: high impact first, then newest news first (by the item's own date, not the time it was found). */
export function compareFeed(a: Pick<FeedItem, "at" | "publishedAt" | "impact">, b: Pick<FeedItem, "at" | "publishedAt" | "impact">): number {
  return IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || newsDate(b).localeCompare(newsDate(a)) || b.at.localeCompare(a.at);
}

/** Every news item of the workspace since the baseline, newest first, with the user's read marks. */
export async function collectFeed(workspaceId: string, baselineUntil: string | null, userId: string | null): Promise<FeedItem[]> {
  const since = baselineUntil ? new Date(baselineUntil) : null;
  const [competitors, reads, news] = await Promise.all([
    // Never the organization's own site (own.ts): the feed is news about competitors.
    db.competitor.findMany({ where: { workspaceId, ...NOT_OWN }, select: { id: true, name: true } }),
    userId ? db.competitorFeedRead.findMany({ where: { workspaceId, userId }, select: { key: true } }) : [],
    // A new ability whose quote is on its page.
    db.competitorNews.findMany({
      where: { workspaceId, verdict: "new", quoteOk: true, competitor: NOT_OWN, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "desc" },
      take: FEED_LIMIT,
    }),
  ]);
  const nameOf = new Map(competitors.map((c) => [c.id, c.name]));
  const readKeys = new Set(reads.map((r) => r.key));

  const items: FeedItem[] = news.map((n) => {
    const key = `news:${n.id}`;
    return {
      key,
      kind: "ability",
      // Every new ability weighs the same for now: the intake does not rank them.
      impact: "High",
      at: n.createdAt.toISOString(),
      competitorId: n.competitorId,
      competitorName: nameOf.get(n.competitorId) ?? "",
      title: n.name,
      publishedAt: n.publishedAt?.toISOString() ?? null,
      summary: abilityPhrase(n),
      quote: n.quote,
      sourceUrl: n.sourceUrl,
      sourceType: NEWS_SOURCE_TYPE[n.sourceKind] ?? null,
      problem: n.problem,
      workflows: n.workflows,
      audience: n.audience,
      read: readKeys.has(key),
    };
  });
  items.sort(compareFeed);
  return items;
}
