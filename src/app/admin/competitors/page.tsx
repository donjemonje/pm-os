import { requireAdminPage } from "@/lib/admin-auth";
import { getAdminOrg } from "@/lib/admin-org";
import {
  FACTS_SYSTEM_PROMPT,
  FACTS_TOOL,
  FACTS_VERSION,
  getCompetitorsGeminiLocation,
} from "@/lib/competitors/ai";
import { ADDRESS_PICK_SYSTEM_PROMPT, ADDRESS_PICK_VERSION, addressPickTool, GUESS_NAMES, MAX_CANDIDATES } from "@/lib/competitors/addresses";
import { competitorsModels, MODEL_DEFAULTS, MODEL_ENV, MODEL_ROLES, PROMPT_ROLES, providerOf, type PromptId } from "@/lib/competitors/models";
import { DOMAINS_SYSTEM_PROMPT, DOMAINS_VERSION, domainsTool } from "@/lib/competitors/analysis/domains";
import {
  comparePageLine,
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
import { UNIFY_BATCH, UNIFY_REVIEW_SYSTEM_PROMPT, UNIFY_SYSTEM_PROMPT, UNIFY_VERSION, unifyReviewTool, unifyTool } from "@/lib/competitors/analysis/unify";
import { getCompetitorsVertexLocation } from "@/lib/competitors/vertex";
import { db } from "@/lib/db";
import { AdminShell } from "../AdminShell";
import { AdminImportAndScans, type ImportOrg } from "./AdminImport";
import { AdminReadingPlan } from "./AdminReadingPlan";
import { AdminSetupRuns } from "./AdminSetupRuns";
import { AdminScanning } from "./AdminScanning";

/**
 * Admin → Competitors: the PMOS AI prompts of the competitors feature
 * (read-only, with the structured answer each call must return), the scanning
 * switches and the analysis token budget, one competitor's reading plan and
 * analysis runs (read-only), every organization's setup runs (read-only), the
 * import of a collector's pages for one competitor, and every organization's
 * scan runs. Daniel's rule: any new AI logic is visible here.
 * An organization may have its own site stored like a competitor's (the own
 * source, lib/competitors/own.ts): the pickers here show it labeled "own site";
 * it can never be imported into.
 */
export default async function AdminCompetitorsPage() {
  const admin = await requireAdminPage("/admin/competitors");
  const org = await getAdminOrg(admin.organizationId);
  // Import pages and Reading plan: every organization with its competitors, read with the page so the pickers never wait for data.
  // The reading plan also lists the organization's own site (first, labeled); the import never does.
  const planOrgs: ImportOrg[] = (
    await db.organization.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, workspace: { select: { competitors: { where: { deletedAt: null }, orderBy: [{ isOwn: "desc" }, { position: "asc" }, { name: "asc" }], select: { id: true, name: true, host: true, isOwn: true } } } } },
    })
  ).map((o) => ({ id: o.id, name: o.name, competitors: o.workspace?.competitors ?? [] }));
  const importOrgs: ImportOrg[] = planOrgs.map((o) => ({ ...o, competitors: o.competitors.filter((c) => !c.isOwn) }));
  const models = competitorsModels();
  /** What each role is used for, next to its model. */
  const ROLE_USE: Record<string, string> = { read: "map, research (the broad read and the go-back), second look, facts", match: "merge, unify batches, match", judge: "unify review, domains" };
  /** The prompt of the list → its id in models.ts PROMPT_ROLES (the role decides the model). */
  const PROMPT_OF: Record<string, PromptId> = { map: "map", research: "research", merge: "merge", unify: "unify", "unify-review": "unify_review", domains: "domains", match: "match", look: "second_look", facts: "facts", addresses: "addresses" };
  const prompts: Array<{ id: string; title: string; note: string; text: string; tool: unknown; extra?: { label: string; text: string } }> = [
    {
      id: "map",
      title: `1 · Map — the sections of the site, one call per competitor (${MAP_VERSION})`,
      note: "Code cuts the stored pages into sections (source and first path segment; a big section with several sizable sub-folders is split one level deeper). PMOS AI gets each section's code, address prefix and page count, and skims a few sample pages of it — each with its address, its title and the first lines of its own text (about 300 characters, after the lines every page of the site shares: its menu, its footer) — plus the site's llms.txt when one is stored (the search for the company's other addresses stores it) — and labels it: product, pricing, compare, help, release notes, API docs, news or noise. The label decides what is read. A label is saved and kept: later runs ask only about new sections. A code or label outside the closed sets fails the run; there is no fallback.",
      text: MAP_SYSTEM_PROMPT,
      tool: mapTool(["S1", "S2", "…"]),
    },
    {
      id: "research",
      title: `2 · Research — one call per page (${RESEARCH_VERSION})`,
      note: "Gets one stored page, whole: no cut, no other page, not our capability list. Returns every capability the page says the company offers and the features under each, in the page's words, each with an exact quote, one sentence of reasoning and a one-sentence description of what it does (empty when the page does not say). A page of a \"compare\" section carries a COMPARISON PAGE line: only what it says the company itself offers is listed. The quote is then checked in code against the stored page text: no quote on the page, no finding.",
      text: RESEARCH_SYSTEM_PROMPT,
      tool: RESEARCH_TOOL,
      extra: { label: "Added to the page's header on a page of a \"compare\" section (the company is the one that owns the site)", text: comparePageLine("<the company>") },
    },
    {
      id: "merge",
      title: `3 · Merge — the competitor's own list (${MERGE_VERSION})`,
      note: "Runs only for wordings never seen before. Gets the competitor's capabilities (or the features under each capability) with the lists merged by earlier runs marked KNOWN. Returns the groups that are the same thing. Same normalized name is merged in code before this call.",
      text: MERGE_SYSTEM_PROMPT,
      tool: MERGE_TOOL,
    },
    {
      id: "unify",
      title: `4 · Unify — setup run only: every company's capabilities into rows, ${UNIFY_BATCH} entries per call (${UNIFY_VERSION})`,
      note: "The first run of an organization (the setup run) has no rows yet: this call makes them. Gets the rows made so far with codes and the next entries — each company's capability in its own words, with what it does — in a fixed order: the organization's own site first, then the competitors by position, entries by name. Returns, per entry, the row it belongs to: a row that exists, a row this answer creates (a name in the market's most common term and one sentence), or none — a commercial term or a marketing headline gets no row. Codes are closed sets: an entry code that was not asked, or a row code that is neither given nor created in the answer, makes the whole answer unusable and fails the run. A new row with the normalized name of an existing one is that row (decided in code). An item's row is saved once, like a match.",
      text: UNIFY_SYSTEM_PROMPT,
      tool: unifyTool(["I1", "I2", "…"], ["R1", "R2", "…"]),
    },
    {
      id: "unify-review",
      title: `5 · Unify review — setup run only: all rows together, once (${UNIFY_VERSION})`,
      note: "After every entry has its row. Gets every row with its code, name, description and what each company calls it. Returns the rows that are the same capability (merged into the first of them), the rows that are no capability (dropped: their entries get no row) and the rows whose name is not the market's term (renamed). The guard against near-duplicate rows and umbrella rows. A code that was not given fails the run. Made once per setup run; a run that continues does not review twice.",
      text: UNIFY_REVIEW_SYSTEM_PROMPT,
      tool: unifyReviewTool(["R1", "R2", "…"]),
    },
    {
      id: "domains",
      title: `6 · Domains — setup run only: one call over all rows (${DOMAINS_VERSION})`,
      note: "Gets every row (code, name, description, the companies that offer it, what the organization itself calls it) and the organization's product lines with their descriptions. Returns the domains — a name in market terms and a one-sentence definition — and the one domain of every row. No limit on the number of domains, no target, no \"other\" bucket. A row code or a domain code outside the closed sets, a row put in two domains, or a new domain without a name fails the run; rows an answer leaves out are asked again with the domains made so far. Then, in code and in one transaction: the domains and the rows are created as ordinary active catalog rows, in a stable order (domains by their first row; rows in the fixed order of the entries), and every entry's row is saved as its match.",
      text: DOMAINS_SYSTEM_PROMPT,
      tool: domainsTool(["R1", "R2", "…"]),
    },
    {
      id: "match",
      title: `7 · Match and place — their list against ours, 100 entries per call (${MATCH_VERSION})`,
      note: "In a setup run this call places only the features (the capabilities got their rows from Unify). Gets our domains with their definitions, our capabilities and features with codes (a closed set — the answer is one of our codes, never a free name), and their list. Returns, per entry: which of ours it is, or for none of ours a market name, a description, the domain of ours it belongs in or a new one, and the closest existing domain. A match is saved once and reused on later scans. Names are resolved in code first (name, alias, removed, dismissed).",
      text: MATCH_SYSTEM_PROMPT,
      tool: matchTool(["T1", "T2", "…"], { ours: new Map(), domains: new Map() }),
    },
    {
      id: "look",
      title: `8 · Second look — one call per capability of ours with no evidence (${LOOK_VERSION})`,
      note: "In a setup run: only for the capabilities the organization itself has. Never made on the organization's own site. Gets one capability of ours with its domain's definition and the pages most likely to mention it (picked in code, at most 4 pages / 80,000 characters). Returns found with a quote, the page and one sentence of reasoning, or not found. Only after it finds nothing does the cell say not found.",
      text: LOOK_SYSTEM_PROMPT,
      tool: lookTool(["https://…"]),
    },
    {
      id: "facts",
      title: `9 · Profile facts — the last step of the run, one call per chunk of pages (${FACTS_VERSION})`,
      note: "Never made for the organization's own site. Reads the pages whose text changed since the last facts read and returns the lean profile: tagline, products, pricing tiers, integrations, certifications, named customers, verticals — each with its URL. Pages are cut to 6,000 characters and packed into chunks for this prompt only.",
      text: FACTS_SYSTEM_PROMPT,
      tool: FACTS_TOOL,
    },
    {
      id: "addresses",
      title: `Other addresses — not part of a run: one call per search of a company's other addresses (${ADDRESS_PICK_VERSION})`,
      note: `Made when a competitor or the organization's own site is added, and after every scan of a main website that read a page. Code finds the candidates first: links on the home page that leave the site and look like help, docs, developers or release notes (by text or address); the addresses the site's llms.txt lists; and the names ${GUESS_NAMES.join(", ")} in front of the domain — a guess counts only when a made-up name on the same domain does not give the same answer and the page is not the main site again. Addresses the company already has, and addresses a PM removed, are left out. PMOS AI gets each remaining candidate (at most ${MAX_CANDIDATES}) with its code, address, how it was found, the link text, the page's title and first lines, and says what it is: help center, developer docs, release notes, or not worth scanning. Codes and kinds are closed sets: an answer that names a code that was not asked, or a kind outside the list, is unusable — the search records "could not decide" and adds nothing; it never fails the add of a competitor or a scan. Every address it names becomes a source and its first scan is queued at once.`,
      text: ADDRESS_PICK_SYSTEM_PROMPT,
      tool: addressPickTool(["A1", "A2", "…"]),
    },
  ];

  return (
    <AdminShell
      user={admin}
      org={org}
      title="Competitors"
      description="The competitors feature's PMOS AI — a model per role, region and the ten prompts — the scanning switches (remote lane, retention, station keys, per-source frequency) and the analysis token budget, each competitor's reading plan and analysis runs, every organization's setup runs, the import of a collector's pages and every organization's scans. Per-org setup (competitors, catalog, manual-rescan limit) is in each organization's Settings → Competitors."
    >
      <div className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">PMOS AI</h2>
          <dl className="mt-3 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-500">Models</dt>
            <dd className="text-xs">
              <div className="mb-1 text-slate-400">A model per role; every prompt below names its model. The old single COMPETITORS_MODEL decides nothing any more.</div>
              {MODEL_ROLES.map((role) => (
                <div key={role} className="font-mono" data-testid="admin-model-role">
                  {role}: {models[role]} <span className="font-sans text-slate-400">({MODEL_ENV[role]} → {MODEL_DEFAULTS[role]}; {providerOf(models[role]) === "gemini" ? "Gemini, structured output through a response schema" : "the Anthropic provider, forced tool use"}) — {ROLE_USE[role]}</span>
                </div>
              ))}
            </dd>
            <dt className="text-slate-500">Vertex region</dt>
            <dd className="font-mono text-xs">{getCompetitorsGeminiLocation()} <span className="font-sans text-slate-400">for gemini-* models (COMPETITORS_GEMINI_LOCATION → global; the newest Gemini models are served on the global endpoint only)</span> · {getCompetitorsVertexLocation()} <span className="font-sans text-slate-400">for any other model (COMPETITORS_VERTEX_LOCATION → IDEAS_VERTEX_LOCATION → eu)</span></dd>
            <dt className="text-slate-500">Prompt versions</dt>
            <dd className="font-mono text-xs">{[MAP_VERSION, RESEARCH_VERSION, MERGE_VERSION, UNIFY_VERSION, DOMAINS_VERSION, MATCH_VERSION, LOOK_VERSION, FACTS_VERSION].join(" · ")}</dd>
            <dt className="text-slate-500">Input</dt>
            <dd className="text-xs text-slate-600">Page text only (no HTML, no images). The map skims: section addresses and, for a few sample pages of each section, the title and the first lines (about 300 characters) — never a whole page. Research reads the full text of one page per call. Our capability list is sent only to the match call, as a shared prefix. Unify and Domains (a setup run only) see names, one-sentence descriptions and company names — never page text. PMOS AI never decides a table cell: cells are filled in code, by fixed rules, from quotes that were checked against the stored page.</dd>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">AI prompts</h2>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">
            The system prompt of each call of an analysis run and of a setup run, in the order they run, and the structured answer it is forced to return (a schema PMOS AI is held to; the model cannot answer in free text). Read-only; changing them is a code change and bumps the prompt version.
          </p>
          <div className="space-y-2">
            {prompts.map((p) => (
              <details key={p.id} className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium hover:bg-slate-50">{p.title}</summary>
                <div className="border-t border-slate-200 px-3 py-3">
                  <p className="mb-2 text-xs text-slate-500" data-testid="admin-prompt-model">Model: <span className="font-mono text-slate-700">{models[PROMPT_ROLES[PROMPT_OF[p.id]]]}</span> (role {PROMPT_ROLES[PROMPT_OF[p.id]]}, {MODEL_ENV[PROMPT_ROLES[PROMPT_OF[p.id]]]})</p>
                  <p className="mb-2 text-xs text-slate-500">{p.note}</p>
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">System prompt</div>
                  <pre className="mb-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">{p.text}</pre>
                  {p.extra && (
                    <>
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">{p.extra.label}</div>
                      <pre className="mb-3 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800" data-testid="admin-prompt-extra">{p.extra.text}</pre>
                    </>
                  )}
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Required answer (tool schema)</div>
                  <pre className="max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-800">{JSON.stringify(p.tool, null, 2)}</pre>
                </div>
              </details>
            ))}
          </div>
        </section>

        <AdminScanning />
        <AdminReadingPlan orgs={planOrgs} currentOrgId={org.current?.id ?? null} />
        <AdminSetupRuns orgs={planOrgs} currentOrgId={org.current?.id ?? null} />
        <AdminImportAndScans orgs={importOrgs} currentOrgId={org.current?.id ?? null} />
      </div>
    </AdminShell>
  );
}
