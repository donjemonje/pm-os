import { requireAdminPage } from "@/lib/admin-auth";
import { getAdminOrg } from "@/lib/admin-org";
import {
  FACTS_SYSTEM_PROMPT,
  FACTS_TOOL,
  FACTS_VERSION,
  getCompetitorsGeminiLocation,
  getCompetitorsModel,
  getCompetitorsProvider,
} from "@/lib/competitors/ai";
import {
  LOOK_SYSTEM_PROMPT,
  LOOK_VERSION,
  lookTool,
  MAP_SYSTEM_PROMPT,
  MAP_VERSION,
  mapTool,
  MATCH_SYSTEM_PROMPT,
  MATCH_VERSION,
  matchTool,
  MERGE_SYSTEM_PROMPT,
  MERGE_TOOL,
  MERGE_VERSION,
  RESEARCH_SYSTEM_PROMPT,
  RESEARCH_TOOL,
  RESEARCH_VERSION,
} from "@/lib/competitors/analysis/prompts";
import { getCompetitorsVertexLocation } from "@/lib/competitors/vertex";
import { db } from "@/lib/db";
import { AdminShell } from "../AdminShell";
import { AdminImportAndScans, type ImportOrg } from "./AdminImport";
import { AdminReadingPlan } from "./AdminReadingPlan";
import { AdminScanning } from "./AdminScanning";

/**
 * Admin → Competitors: the PMOS AI prompts of the competitors feature
 * (read-only, with the structured answer each call must return), the scanning
 * switches and the analysis token budget, one competitor's reading plan and
 * analysis runs (read-only), the import of a collector's pages for one
 * competitor, and every organization's scan runs. Daniel's rule: any new AI logic is visible here.
 * The organization itself is never scanned (2026-10-26): its catalog, domain
 * definitions and own statuses are entered by its PMs.
 */
export default async function AdminCompetitorsPage() {
  const admin = await requireAdminPage("/admin/competitors");
  const org = await getAdminOrg(admin.organizationId);
  // Import pages and Reading plan: every organization with its competitors, read with the page so the pickers never wait for data.
  const importOrgs: ImportOrg[] = (
    await db.organization.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, workspace: { select: { competitors: { where: { deletedAt: null }, orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, name: true, host: true } } } } },
    })
  ).map((o) => ({ id: o.id, name: o.name, competitors: o.workspace?.competitors ?? [] }));
  const prompts = [
    {
      id: "map",
      title: `1 · Map — the sections of the site, one call per competitor (${MAP_VERSION})`,
      note: "Code cuts the stored pages into sections (source and first path segment; a big section with several sizable sub-folders is split one level deeper). PMOS AI gets each section's code, address prefix, page count and a few sample titles and addresses — plus the site's llms.txt when one is stored — and labels it: product, pricing, compare, help, release notes, API docs, news or noise. The label decides what is read. A label is saved and kept: later runs ask only about new sections. A code or label outside the closed sets fails the run; there is no fallback.",
      text: MAP_SYSTEM_PROMPT,
      tool: mapTool(["S1", "S2", "…"]),
    },
    {
      id: "research",
      title: `2 · Research — one call per page (${RESEARCH_VERSION})`,
      note: "Gets one stored page, whole: no cut, no other page, not our capability list. Returns every capability the page says the company offers and the features under each, in the page's words, each with an exact quote, one sentence of reasoning and a one-sentence description of what it does (empty when the page does not say). A page of a \"compare\" section carries a COMPARISON PAGE line: only what it says the company itself offers is listed. The quote is then checked in code against the stored page text: no quote on the page, no finding.",
      text: RESEARCH_SYSTEM_PROMPT,
      tool: RESEARCH_TOOL,
    },
    {
      id: "merge",
      title: `3 · Merge — the competitor's own list (${MERGE_VERSION})`,
      note: "Runs only for wordings never seen before. Gets the competitor's capabilities (or the features under each capability) with the lists merged by earlier runs marked KNOWN. Returns the groups that are the same thing. Same normalized name is merged in code before this call.",
      text: MERGE_SYSTEM_PROMPT,
      tool: MERGE_TOOL,
    },
    {
      id: "match",
      title: `4 · Match and place — their list against ours, 100 entries per call (${MATCH_VERSION})`,
      note: "Gets our domains with their definitions, our capabilities and features with codes (a closed set — the answer is one of our codes, never a free name), and their list. Returns, per entry: which of ours it is, or for none of ours a market name, a description, the domain of ours it belongs in or a new one, and the closest existing domain. A match is saved once and reused on later scans. Names are resolved in code first (name, alias, removed, dismissed).",
      text: MATCH_SYSTEM_PROMPT,
      tool: matchTool(["T1", "T2", "…"], { ours: new Map(), domains: new Map() }),
    },
    {
      id: "look",
      title: `5 · Second look — one call per capability of ours with no evidence (${LOOK_VERSION})`,
      note: "Gets one capability of ours with its domain's definition and the pages most likely to mention it (picked in code, at most 4 pages / 80,000 characters). Returns found with a quote, the page and one sentence of reasoning, or not found. Only after it finds nothing does the cell say not found.",
      text: LOOK_SYSTEM_PROMPT,
      tool: lookTool(["https://…"]),
    },
    {
      id: "facts",
      title: `6 · Profile facts — the last step of the run, one call per chunk of pages (${FACTS_VERSION})`,
      note: "Reads the pages whose text changed since the last facts read and returns the lean profile: tagline, products, pricing tiers, integrations, certifications, named customers, verticals — each with its URL. Pages are cut to 6,000 characters and packed into chunks for this prompt only.",
      text: FACTS_SYSTEM_PROMPT,
      tool: FACTS_TOOL,
    },
  ];

  return (
    <AdminShell
      user={admin}
      org={org}
      title="Competitors"
      description="The competitors feature's PMOS AI — model, region and the six prompts — the scanning switches (remote lane, retention, station keys, per-source frequency) and the analysis token budget, each competitor's reading plan and analysis runs, the import of a collector's pages and every organization's scans. Per-org setup (competitors, catalog, manual-rescan limit) is in each organization's Settings → Competitors."
    >
      <div className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">PMOS AI</h2>
          <dl className="mt-3 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-500">Model</dt>
            <dd className="font-mono text-xs">{getCompetitorsModel()} <span className="font-sans text-slate-400">(COMPETITORS_MODEL → GEMINI_MODEL → gemini-4-argon; a gemini-* id runs on Gemini, anything else on the Anthropic provider)</span></dd>
            <dt className="text-slate-500">Provider</dt>
            <dd className="font-mono text-xs">{getCompetitorsProvider()} <span className="font-sans text-slate-400">{getCompetitorsProvider() === "gemini" ? "— structured output through a response schema" : "— forced tool use through the Vertex Anthropic provider"}</span></dd>
            <dt className="text-slate-500">Vertex region</dt>
            <dd className="font-mono text-xs">{getCompetitorsProvider() === "gemini" ? getCompetitorsGeminiLocation() : getCompetitorsVertexLocation()} <span className="font-sans text-slate-400">{getCompetitorsProvider() === "gemini" ? "(COMPETITORS_GEMINI_LOCATION → global; the newest Gemini models are served on the global endpoint only)" : "(COMPETITORS_VERTEX_LOCATION → IDEAS_VERTEX_LOCATION → eu)"}</span></dd>
            <dt className="text-slate-500">Prompt versions</dt>
            <dd className="font-mono text-xs">{[MAP_VERSION, RESEARCH_VERSION, MERGE_VERSION, MATCH_VERSION, LOOK_VERSION, FACTS_VERSION].join(" · ")}</dd>
            <dt className="text-slate-500">Input</dt>
            <dd className="text-xs text-slate-600">Page text only (no HTML, no images). The map sees section addresses and sample titles, never page text. Research reads the full text of one page per call. Our capability list is sent only to the match call, as a shared prefix. PMOS AI never decides a table cell: cells are filled in code, by fixed rules, from quotes that were checked against the stored page.</dd>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">AI prompts</h2>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">
            The system prompt of each call of an analysis run, in the order they run, and the structured answer it is forced to return (a schema PMOS AI is held to; the model cannot answer in free text). Read-only; changing them is a code change and bumps the prompt version.
          </p>
          <div className="space-y-2">
            {prompts.map((p) => (
              <details key={p.id} className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium hover:bg-slate-50">{p.title}</summary>
                <div className="border-t border-slate-200 px-3 py-3">
                  <p className="mb-2 text-xs text-slate-500">{p.note}</p>
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">System prompt</div>
                  <pre className="mb-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">{p.text}</pre>
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Required answer (tool schema)</div>
                  <pre className="max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-800">{JSON.stringify(p.tool, null, 2)}</pre>
                </div>
              </details>
            ))}
          </div>
        </section>

        <AdminScanning />
        <AdminReadingPlan orgs={importOrgs} currentOrgId={org.current?.id ?? null} />
        <AdminImportAndScans orgs={importOrgs} currentOrgId={org.current?.id ?? null} />
      </div>
    </AdminShell>
  );
}
