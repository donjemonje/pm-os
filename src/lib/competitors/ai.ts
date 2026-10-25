import { FACT_KINDS, STATUS_VALUES, type FactKind, type StatusValue } from "./config";
import { getCompetitorsClient, prefixedUserMessage } from "./vertex";

/**
 * PMOS AI for competitors: three structured calls on the Vertex client the
 * Ideas stages use (forced tool use → validated JSON, never free text).
 *
 * 1. proposeCatalog — the org's OWN site → domains + capabilities to seed the catalog.
 * 2. classifyCapabilities — a competitor's changed pages × the catalog → status per capability
 *    with a quote + URL, plus capabilities the catalog lacks (suggestions).
 * 3. extractFacts — a competitor's pages → lean-profile facts (closed kinds), each with a URL.
 *
 * Pages are sent as text only. The shared prefix (instructions + catalog) is
 * cache-marked; the per-call tail is the page text.
 */

export const COMPETITORS_PROMPT_VERSION = "competitors-v1";

export function getCompetitorsModel(): string {
  return process.env.COMPETITORS_MODEL?.trim() || process.env.IDEAS_CATALOG_MODEL?.trim() || "claude-opus-5";
}

/** Keep each call well inside the context window; marketing pages are wordy. */
const MAX_PAGE_CHARS = 6000;
const MAX_TOTAL_CHARS = 90_000;

export interface PageText {
  url: string;
  title: string;
  text: string;
}

export function packPages(pages: PageText[]): string {
  let total = 0;
  const parts: string[] = [];
  for (const p of pages) {
    const body = p.text.length > MAX_PAGE_CHARS ? p.text.slice(0, MAX_PAGE_CHARS) + "\n[…]" : p.text;
    if (total + body.length > MAX_TOTAL_CHARS) break;
    total += body.length;
    parts.push(`### PAGE ${p.url}\nTitle: ${p.title}\n${body}`);
  }
  return parts.join("\n\n");
}

export interface AiResult<T> {
  value: T;
  usage: unknown;
}

async function callTool<T>(system: string, shared: string, tail: string, tool: Record<string, unknown>, maxTokens: number): Promise<AiResult<T>> {
  const message = await getCompetitorsClient().messages.create({
    model: getCompetitorsModel(),
    max_tokens: maxTokens,
    system,
    tools: [tool as never],
    tool_choice: { type: "tool", name: tool.name as string },
    messages: prefixedUserMessage(shared, tail),
  });
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("PMOS AI returned no structured answer");
  return { value: toolUse.input as T, usage: message.usage };
}

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown, max = 120): string[] =>
  arr(v).map((x) => str(x, max)).filter(Boolean);

// ————— 1. Catalog proposal from the org's own site —————

export const CATALOG_SYSTEM_PROMPT = `You help a product team describe its own product as a capability catalog for competitive analysis.

You read the text of the organization's own public website and return:
- domains: 3–7 problem/solution areas of the industry this product serves (e.g. for cyber threat intelligence: "Threat intelligence", "Exposure & response", "AI", "Integrations & buying"). Short noun phrases, title case first word only. Each with a one-sentence description.
- capabilities: 8–30 concrete things the product does, each in exactly one domain. A capability is something a buyer compares vendors on ("Dark web & closed-forum monitoring", "Takedown requests", "SIEM / SOAR integrations"), not a marketing claim ("industry-leading", "trusted by") and not a product name. Merge near-duplicates. Each with a one-line description and, when the site makes it clear, the product line(s) of the organization that deliver it, chosen ONLY from the product-line list provided (empty when unclear).
- For each capability, a short quote from the site (≤ 200 characters) and the page URL it came from.

Use only what the pages say. Never invent capabilities the site does not describe.`;

export const CATALOG_TOOL = {
  name: "propose_catalog",
  description: "Propose the domains and capabilities that describe this product.",
  input_schema: {
    type: "object" as const,
    properties: {
      domains: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, description: { type: "string" } },
          required: ["name", "description"],
        },
      },
      capabilities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            domain: { type: "string", description: "Exactly one of the proposed domain names." },
            description: { type: "string" },
            product_lines: { type: "array", items: { type: "string" } },
            quote: { type: "string" },
            url: { type: "string" },
          },
          required: ["name", "domain", "description", "product_lines", "quote", "url"],
        },
      },
    },
    required: ["domains", "capabilities"],
  },
};

export interface ProposedDomain { name: string; description: string }
export interface ProposedCapability {
  name: string;
  domain: string;
  description: string;
  productLines: string[];
  quote: string;
  url: string;
}
export interface CatalogProposal { domains: ProposedDomain[]; capabilities: ProposedCapability[] }

export async function proposeCatalog(orgName: string, productLines: string[], pages: PageText[]): Promise<AiResult<CatalogProposal>> {
  const shared = `ORGANIZATION: ${orgName}\nPRODUCT LINES (the only allowed values for product_lines): ${productLines.length ? productLines.join(" | ") : "(none defined)"}`;
  const tail = `WEBSITE PAGES:\n\n${packPages(pages)}`;
  const r = await callTool<Record<string, unknown>>(CATALOG_SYSTEM_PROMPT, shared, tail, CATALOG_TOOL, 6000);
  const lines = new Set(productLines.map((p) => p.toLowerCase()));
  const domains: ProposedDomain[] = arr(r.value.domains)
    .map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      return { name: str(o.name, 60), description: str(o.description, 300) };
    })
    .filter((d) => d.name);
  const domainNames = new Set(domains.map((d) => d.name.toLowerCase()));
  const capabilities: ProposedCapability[] = arr(r.value.capabilities)
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        name: str(o.name, 80),
        domain: str(o.domain, 60),
        description: str(o.description, 300),
        productLines: strs(o.product_lines).filter((p) => lines.has(p.toLowerCase())).map((p) => productLines.find((x) => x.toLowerCase() === p.toLowerCase())!),
        quote: str(o.quote, 240),
        url: str(o.url, 500),
      };
    })
    .filter((c) => c.name && c.domain && domainNames.has(c.domain.toLowerCase()));
  return { value: { domains, capabilities }, usage: r.usage };
}

// ————— 2. Status per capability for a competitor —————

export const CLASSIFY_SYSTEM_PROMPT = `You compare a competitor's public website against a fixed capability catalog for a product team.

For EVERY capability in the catalog, decide from the page text whether the competitor:
- "has" it — the site clearly describes offering this capability;
- "partial" — the site describes a limited, beta, add-on, services-only or narrower version of it;
- "missing" — the site describes the surrounding area but this capability is absent, or the site contradicts it;
- "unknown" — the pages give no evidence either way.
Give a confidence from 0 to 1, and for has/partial/missing the single strongest quote (≤ 200 characters, verbatim from the pages) and the URL of the page it is on. For unknown, quote and url are empty.

Also list capabilities the competitor clearly advertises that are NOT in the catalog but belong to the same industry (suggestions): name, the catalog domain it fits best, a quote and URL. At most 8; skip marketing claims and product names; skip anything that is a synonym of a catalog capability.

Judge only from the pages provided. The previous statuses are given for context: keep them when the new pages say nothing new about a capability (answer the previous value with its previous confidence), change them only on evidence.`;

export const CLASSIFY_TOOL = {
  name: "classify_capabilities",
  description: "Record the competitor's status on every catalog capability, plus suggested new capabilities.",
  input_schema: {
    type: "object" as const,
    properties: {
      statuses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            capability: { type: "string", description: "Exact catalog capability name." },
            value: { type: "string", enum: [...STATUS_VALUES] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            quote: { type: "string" },
            url: { type: "string" },
          },
          required: ["capability", "value", "confidence", "quote", "url"],
        },
      },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            domain: { type: "string" },
            quote: { type: "string" },
            url: { type: "string" },
          },
          required: ["name", "domain", "quote", "url"],
        },
      },
    },
    required: ["statuses", "suggestions"],
  },
};

export interface CatalogForAi {
  domains: { name: string; capabilities: { name: string; description: string }[] }[];
}
export interface PreviousStatus { capability: string; value: StatusValue; confidence: number | null }
export interface ClassifiedStatus { capability: string; value: StatusValue; confidence: number; quote: string; url: string }
export interface Suggestion { name: string; domain: string; quote: string; url: string }
export interface Classification { statuses: ClassifiedStatus[]; suggestions: Suggestion[] }

export function renderCatalog(c: CatalogForAi): string {
  return c.domains
    .map((d) => `DOMAIN: ${d.name}\n${d.capabilities.map((k) => `- ${k.name}${k.description ? ` — ${k.description}` : ""}`).join("\n")}`)
    .join("\n\n");
}

export async function classifyCapabilities(
  competitorName: string,
  catalog: CatalogForAi,
  previous: PreviousStatus[],
  pages: PageText[],
): Promise<AiResult<Classification>> {
  const shared = `CAPABILITY CATALOG:\n\n${renderCatalog(catalog)}`;
  const prev = previous.length
    ? `PREVIOUS STATUSES (from the last scan):\n${previous.map((p) => `- ${p.capability}: ${p.value}${p.confidence != null ? ` (${p.confidence.toFixed(2)})` : ""}`).join("\n")}\n\n`
    : "";
  const tail = `COMPETITOR: ${competitorName}\n\n${prev}WEBSITE PAGES:\n\n${packPages(pages)}`;
  const r = await callTool<Record<string, unknown>>(CLASSIFY_SYSTEM_PROMPT, shared, tail, CLASSIFY_TOOL, 8000);
  const names = new Map<string, string>();
  for (const d of catalog.domains) for (const k of d.capabilities) names.set(k.name.toLowerCase(), k.name);
  const domainNames = new Map(catalog.domains.map((d) => [d.name.toLowerCase(), d.name]));
  const statuses: ClassifiedStatus[] = [];
  const seen = new Set<string>();
  for (const s of arr(r.value.statuses)) {
    const o = (s ?? {}) as Record<string, unknown>;
    const name = names.get(str(o.capability, 120).toLowerCase());
    const value = str(o.value, 20) as StatusValue;
    if (!name || seen.has(name) || !(STATUS_VALUES as readonly string[]).includes(value)) continue;
    seen.add(name);
    const conf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0.5;
    statuses.push({ capability: name, value, confidence: conf, quote: value === "unknown" ? "" : str(o.quote, 240), url: value === "unknown" ? "" : str(o.url, 500) });
  }
  const suggestions: Suggestion[] = arr(r.value.suggestions)
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return { name: str(o.name, 80), domain: domainNames.get(str(o.domain, 60).toLowerCase()) ?? "", quote: str(o.quote, 240), url: str(o.url, 500) };
    })
    .filter((s) => s.name && s.domain && !names.has(s.name.toLowerCase()))
    .slice(0, 8);
  return { value: { statuses, suggestions }, usage: r.usage };
}

// ————— 3. Lean-profile facts —————

export const FACTS_SYSTEM_PROMPT = `You extract company facts from a competitor's public website for a product team's competitor profile.

Return facts of these kinds only:
- tagline: the one-line positioning statement (at most one).
- product: each named product, module or plan family the company sells.
- pricingTier: each named pricing tier or plan (names only, no prices).
- integration: each named third-party product it integrates with.
- certification: each named certification or compliance standard (SOC 2, ISO 27001, FedRAMP…).
- customer: each named customer company shown as a customer, logo or case study.
- vertical: each industry it says it serves.
Each fact is a short value (≤ 80 characters) and the URL of the page it came from. Only what the pages state; nothing inferred, no counts, no adjectives. Deduplicate.`;

export const FACTS_TOOL = {
  name: "extract_facts",
  description: "Record the company facts found on the pages.",
  input_schema: {
    type: "object" as const,
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...FACT_KINDS] },
            value: { type: "string" },
            url: { type: "string" },
          },
          required: ["kind", "value", "url"],
        },
      },
    },
    required: ["facts"],
  },
};

export interface ExtractedFact { kind: FactKind; value: string; url: string }

export async function extractFacts(competitorName: string, pages: PageText[]): Promise<AiResult<ExtractedFact[]>> {
  const shared = `Extract facts for the competitor profile.`;
  const tail = `COMPETITOR: ${competitorName}\n\nWEBSITE PAGES:\n\n${packPages(pages)}`;
  const r = await callTool<Record<string, unknown>>(FACTS_SYSTEM_PROMPT, shared, tail, FACTS_TOOL, 4000);
  const seen = new Set<string>();
  const facts: ExtractedFact[] = [];
  for (const f of arr(r.value.facts)) {
    const o = (f ?? {}) as Record<string, unknown>;
    const kind = str(o.kind, 20);
    const value = str(o.value, 80);
    if (!(FACT_KINDS as readonly string[]).includes(kind) || !value) continue;
    const key = `${kind}|${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ kind: kind as FactKind, value, url: str(o.url, 500) });
  }
  return { value: facts, usage: r.usage };
}
