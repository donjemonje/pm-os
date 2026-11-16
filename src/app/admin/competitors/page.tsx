import { requireAdminPage } from "@/lib/admin-auth";
import { getAdminOrg } from "@/lib/admin-org";
import {
  FACTS_SYSTEM_PROMPT,
  FACTS_TOOL,
  FACTS_VERSION,
  getCompetitorsGeminiLocation,
} from "@/lib/competitors/ai";
import { ADDRESS_PICK_SYSTEM_PROMPT, ADDRESS_PICK_VERSION, addressPickTool, GUESS_NAMES, MAX_CANDIDATES } from "@/lib/competitors/addresses";
import { competitorsModels, competitorsThinking, MODEL_DEFAULTS, MODEL_ENV, MODEL_ROLES, PROMPT_ROLES, providerOf, retiredThinkingOverride, THINKING_DEFAULTS, THINKING_ENV, THINKING_ENV_ALL, type PromptId } from "@/lib/competitors/models";
import { CHUNK_MAX_TOKENS } from "@/lib/competitors/analysis/chunks";
import { DOMAINS_SYSTEM_PROMPT, DOMAINS_VERSION, domainsTool } from "@/lib/competitors/analysis/domains";
import { LOOK_SYSTEM_PROMPT, LOOK_VERSION, lookTool, MAP_PAGES_BATCH, MAP_PAGES_SYSTEM_PROMPT, MAP_PAGES_VERSION, MAP_SYSTEM_PROMPT, MAP_VERSION, mapPagesTool, mapTool, MATCH_SYSTEM_PROMPT, MATCH_VERSION, matchTool } from "@/lib/competitors/analysis/prompts";
import { READ_CHANGES_RULES, READ_SYSTEM_PROMPT, READ_TOOL, READ_VERSION, readChangesTool, WHERE_A_PM_LOOKS } from "@/lib/competitors/analysis/reading";
import { UNIFY_CAPABILITIES_PROMPT, UNIFY_CAPABILITY_BATCH, UNIFY_FEATURE_BATCH, UNIFY_FEATURES_PROMPT, UNIFY_MOVED_FEATURES_PROMPT, UNIFY_REVIEW_PROMPT, UNIFY_VERSION, unifyCapabilitiesTool, unifyFeaturesTool, unifyReviewTool } from "@/lib/competitors/analysis/unify";
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
 * switches and the analysis token budget, one competitor's reading plan, its
 * reading (the chunks, the incidents, the labels seen but not explained) and its
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
  const thinking = competitorsThinking();
  const retiredThinking = retiredThinkingOverride();
  /** What each role is used for, next to its model. */
  const ROLE_USE: Record<string, string> = { read: "map, the reading (a company in chunks), second look, facts, other addresses", match: "match (after setup: a company's new items against the rows that exist)", judge: "unify (capabilities, the review, features), domains" };
  /** The prompt of the list → its id in models.ts PROMPT_ROLES (the role decides the model). */
  const PROMPT_OF: Record<string, PromptId> = { map: "map", guide: "reading", reading: "reading", unify: "unify", "unify-review": "unify_review", "unify-features": "unify_features", domains: "domains", match: "match", look: "second_look", facts: "facts", addresses: "addresses" };
  const prompts: Array<{ id: string; title: string; note: string; text: string; tool: unknown; extra?: { label: string; text: string; tool?: unknown } }> = [
    {
      id: "map",
      title: `1 · Map — the sections of the site, one call per company (${MAP_VERSION})`,
      note: "Code cuts the stored pages into sections (source and first path segment; a big section with several sizable sub-folders is split one level deeper). PMOS AI gets each section's code, address prefix and page count, and skims a few sample pages of it — each with its address, its title and the first lines of its own text (about 300 characters, after the lines every page of the site shares: its menu, its footer) — plus the site's llms.txt when one is stored — and labels it: product, pricing, compare, help, release notes, API docs, news or noise. The label is the section's kind; which kinds are read is the setting \"What the analysis reads\" below (noise is never read). A label is saved and kept: later runs ask only about new sections. A code or label outside the closed sets fails the run; there is no fallback.",
      text: MAP_SYSTEM_PROMPT,
      tool: mapTool(["S1", "S2", "…"]),
      extra: {
        label: `Map, page by page (${MAP_PAGES_VERSION}) — release notes inside a help center or a blog: for the sections labeled help or news, the pages are shown one by one (address and title only, ${MAP_PAGES_BATCH} per call) and PMOS AI names the release-notes pages by code. Such a page is read as release notes, whatever the switch of the help center or the blog says. A page is asked about once; a code that was not asked fails the run`,
        text: MAP_PAGES_SYSTEM_PROMPT,
        tool: mapPagesTool(["P1", "P2", "…"]),
      },
    },
    {
      id: "guide",
      title: "Where a PM looks — the guide inside the reading and the second-look prompts",
      note: "A short, explicit order of where the truth about a product is, strongest first. It is part of the two prompts below, and the same order decides the order a company's chunks are read in (so its list is built from the strongest sources and weaker pages only add). Improve it here, run by run: it is one text in the code (analysis/reading.ts WHERE_A_PM_LOOKS), with the reading order next to it (analysis/sections.ts READ_ORDER).",
      text: WHERE_A_PM_LOOKS,
      tool: { note: "No answer of its own: it is part of the reading prompt and of the second-look prompt." },
    },
    {
      id: "reading",
      title: `2 · Reading — a company in a few large chunks of related pages (${READ_VERSION})`,
      note: `Replaces the old reading that asked about every page separately. A company's pages of the kinds that are on in "What the analysis reads" — over all its sources: website, help centers, release notes, developer docs — are put in the "where a PM looks" order and packed into requests of at most ${CHUNK_MAX_TOKENS.toLocaleString("en-US")} tokens; related pages stay together (a page and its inner pages, one site after the other), and a site that fits is ONE request. Lines a site repeats on most of its pages (its menu, its table of contents) are shown once per request instead of on every page; nothing else is cut. The first request returns the company's list: its capabilities and the features under each, each once, with a one-sentence description, an exact quote and the page it is on — and the labels that are seen but not explained. A later request gets the list so far (with codes) and answers only with what its pages change: new capabilities, new features, corrections, removals. Every quote is checked in code against the stored text of the page it names: a quote that is not there is an INCIDENT — the finding does not reach the table and the case is kept on the run. After setup a scan sends only the pages that are new or changed.`,
      text: READ_SYSTEM_PROMPT,
      tool: READ_TOOL,
      extra: { label: "Added to the system prompt of every request after the first of a company — and the answer such a request must return", text: READ_CHANGES_RULES, tool: readChangesTool(["K1", "K2", "…"], ["K1", "K1.1", "…"]) },
    },
    {
      id: "unify",
      title: `3 · Unify, capabilities — setup run only: every company's capabilities into rows, ${UNIFY_CAPABILITY_BATCH} per call (${UNIFY_VERSION})`,
      note: "The first run of an organization (the setup run) has no rows yet: this call makes them. Gets the rows made so far with codes and the next capabilities — each with the company, its own name for it, what it does and some of its features — in a fixed order: the organization's own site first, then the competitors by position, a company's capabilities in its list's order. Returns the rows, each with the capabilities on it: a row that exists (its code) or a new one (a name in the market's term and one sentence). Codes are closed sets: a capability code that was not given, or a row code that is neither given nor \"new\", makes the whole answer unusable and fails the run; a code used twice keeps its first row; a code the answer leaves out is asked again. So every capability is on exactly one row.",
      text: UNIFY_CAPABILITIES_PROMPT,
      tool: unifyCapabilitiesTool(["A1", "A2", "B1", "…"], ["R1", "R2", "…"]),
    },
    {
      id: "unify-review",
      title: `4 · Unify, review — setup run only, and only when the capabilities took more than one call (${UNIFY_VERSION})`,
      note: "All rows together, once, with what each company calls each: the rows that are the same capability and were made in different calls are merged into the first of them. Not made when one call saw every capability. A code that was not given fails the run.",
      text: UNIFY_REVIEW_PROMPT,
      tool: unifyReviewTool(["R1", "R2", "…"]),
    },
    {
      id: "unify-features",
      title: `5 · Unify, features — setup run only: the feature rows under each row, ${UNIFY_FEATURE_BATCH} features per call (${UNIFY_VERSION})`,
      note: "Per batch of rows (whole rows, in table order): the features the companies have under those rows become feature rows — the same feature at two companies is one feature row. A feature that clearly belongs to another row is put there when that row is in the same call, or handed over (\"moved\") when it is not; moved features are placed in a second round against the feature rows their new row already has, and are not moved again. Every feature code is used exactly once: a code that was not given fails the run, a code used twice keeps its first place, a code left out is asked again. The calls of a round do not depend on each other and run at the run's own speed.",
      text: UNIFY_FEATURES_PROMPT,
      tool: unifyFeaturesTool(["A1.1", "A1.2", "B3.1", "…"], ["R1", "R2"], ["R3", "…"], true),
      extra: { label: "The second round — the features another call moved to these rows (they stay)", text: UNIFY_MOVED_FEATURES_PROMPT, tool: unifyFeaturesTool(["A1.4", "…"], ["R7"], [], false) },
    },
    {
      id: "domains",
      title: `6 · Domains — setup run only: one call over all rows (${DOMAINS_VERSION})`,
      note: "Gets every row (code, name, description, the companies that offer it, what the organization itself calls it, some of its features) and the organization's product lines with their descriptions. Returns the domains — a name in market terms and a one-sentence definition — and the one domain of every row. No limit on the number of domains, no target, no catch-all. A row code or a domain code outside the closed sets, a row put in two domains, or a new domain without a name fails the run; rows an answer leaves out are asked again with the domains made so far. Then, in code and in one transaction: the domains, the rows and the feature rows are created as ordinary active catalog rows, in a stable order, and every item's row is saved as its match.",
      text: DOMAINS_SYSTEM_PROMPT,
      tool: domainsTool(["R1", "R2", "…"]),
    },
    {
      id: "match",
      title: `7 · Match — after setup: a company's new items against the rows that exist, 100 entries per call (${MATCH_VERSION})`,
      note: "Not made in a setup run (unify gives every item its row). After setup a scan reads only the pages that are new or changed; what that adds to the company's list is matched here. Gets our domains with their definitions, our capabilities and features with codes (a closed set — the answer is one of our codes, never a free name), and their entries with what each does. Returns, per entry: which of ours it is, or for none of ours a market name, a description and — for a capability — the EXISTING domain it belongs in: it becomes a new row there. No new domain is proposed. A match is saved once and reused on later scans. Names are resolved in code first (name, alias, removed, dismissed).",
      text: MATCH_SYSTEM_PROMPT,
      tool: matchTool(["T1", "T2", "…"], { ours: new Map(), domains: new Map() }),
    },
    {
      id: "look",
      title: `8 · Second look, in bulk — once per chunk of a company's pages (${LOOK_VERSION})`,
      note: "The parity question: only for the rows the organization itself has and a competitor has no item for. Never made on the organization's own site. Each chunk of the competitor's pages (the reading's own chunks) is asked once: which of these capabilities do the pages show? — the rows as a closed set of codes, each answer with a quote and its page. A row a chunk shows is not asked about in the chunks after it. Only after every chunk found nothing does the cell say not found; the row is then not asked again until its name, description or domain changes. A quote that is not on its page, or a code that was not given, is an incident.",
      text: LOOK_SYSTEM_PROMPT,
      tool: lookTool(["R1", "R2", "…"]),
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
      description="The competitors feature's PMOS AI — a model per role, region and the prompts of a run — the scanning switches (remote lane, retention, station keys, per-source frequency) and the analysis token budget, each competitor's reading plan and analysis runs, every organization's setup runs, the import of a collector's pages and every organization's scans. Per-org setup (competitors, catalog, manual-rescan limit) is in each organization's Settings → Competitors."
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
            <dt className="text-slate-500">Thinking</dt>
            <dd className="text-xs">
              <div className="mb-1 text-slate-400">How much a model thinks before it answers is a setting per role. Thinking is billed as output; each run records it apart from the answer. {THINKING_ENV_ALL} (one value for every role) is retired and decides nothing.</div>
              {retiredThinking && (
                <div className="mb-1 text-amber-700" data-testid="admin-thinking-retired">{THINKING_ENV_ALL} is set to &quot;{retiredThinking}&quot; in this environment and is ignored: each role uses its own setting below.</div>
              )}
              {MODEL_ROLES.map((role) => (
                <div key={role} className="font-mono" data-testid="admin-thinking-role">
                  {role}: {thinking[role]} <span className="font-sans text-slate-400">({THINKING_ENV[role]} → {THINKING_DEFAULTS[role]})</span>
                </div>
              ))}
            </dd>
            <dt className="text-slate-500">Vertex region</dt>
            <dd className="font-mono text-xs">{getCompetitorsGeminiLocation()} <span className="font-sans text-slate-400">for gemini-* models (COMPETITORS_GEMINI_LOCATION → global; the newest Gemini models are served on the global endpoint only)</span> · {getCompetitorsVertexLocation()} <span className="font-sans text-slate-400">for any other model (COMPETITORS_VERTEX_LOCATION → IDEAS_VERTEX_LOCATION → eu)</span></dd>
            <dt className="text-slate-500">Prompt versions</dt>
            <dd className="font-mono text-xs">{[MAP_VERSION, MAP_PAGES_VERSION, READ_VERSION, UNIFY_VERSION, DOMAINS_VERSION, MATCH_VERSION, LOOK_VERSION, FACTS_VERSION].join(" · ")}</dd>
            <dt className="text-slate-500">Input</dt>
            <dd className="text-xs text-slate-600">Page text only (no HTML, no images). The map skims: section addresses and, for a few sample pages of each section, the title and the first lines (about 300 characters) — never a whole page. The reading sends whole pages, many at once: a chunk of related pages per request, nothing trimmed (lines a site repeats on most of its pages are shown once per request). The second look sends the same chunks with the rows it asks about. Our table is sent only to the match call, as a shared prefix. Unify and Domains (a setup run only) see names, one-sentence descriptions and company names — never page text. PMOS AI never decides a table cell: cells are filled in code, by fixed rules, from quotes that were checked against the stored page. Every call streams its answer, so a long answer is not cut by a timeout.</dd>
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
                  <p className="mb-2 text-xs text-slate-500" data-testid="admin-prompt-model">Model: <span className="font-mono text-slate-700">{models[PROMPT_ROLES[PROMPT_OF[p.id]]]}</span> (role {PROMPT_ROLES[PROMPT_OF[p.id]]}, {MODEL_ENV[PROMPT_ROLES[PROMPT_OF[p.id]]]}) · thinking: <span className="font-mono text-slate-700">{thinking[PROMPT_ROLES[PROMPT_OF[p.id]]]}</span></p>
                  <p className="mb-2 text-xs text-slate-500">{p.note}</p>
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">System prompt</div>
                  <pre className="mb-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">{p.text}</pre>
                  {p.extra && (
                    <>
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">{p.extra.label}</div>
                      <pre className="mb-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800" data-testid="admin-prompt-extra">{p.extra.text}</pre>
                      {p.extra.tool !== undefined && <pre className="mb-3 max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-800">{JSON.stringify(p.extra.tool, null, 2)}</pre>}
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
