import { requireAdminPage } from "@/lib/admin-auth";
import { getAdminOrg } from "@/lib/admin-org";
import {
  CATALOG_SYSTEM_PROMPT,
  CATALOG_TOOL,
  CLASSIFY_SYSTEM_PROMPT,
  CLASSIFY_TOOL,
  COMPETITORS_PROMPT_VERSION,
  FACTS_SYSTEM_PROMPT,
  FACTS_TOOL,
  getCompetitorsModel,
} from "@/lib/competitors/ai";
import { getCompetitorsVertexLocation } from "@/lib/competitors/vertex";
import { AdminShell } from "../AdminShell";
import { AdminScans } from "./AdminScans";

/**
 * Admin → Competitors: the PMOS AI prompts of the competitors feature
 * (read-only, with the structured answer each call must return) and every
 * organization's scan runs. Daniel's rule: any new AI logic is visible here.
 */
export default async function AdminCompetitorsPage() {
  const admin = await requireAdminPage("/admin/competitors");
  const org = await getAdminOrg(admin.organizationId);
  const prompts = [
    {
      id: "catalog",
      title: `Catalog proposal — the organization's own website (${COMPETITORS_PROMPT_VERSION})`,
      note: "Runs once, when the own site is scanned and the catalog is empty: proposes domains and capabilities from the pages, each with a quote and URL. Rows arrive as suggestions for the customer admin to accept, rename, move or dismiss.",
      text: CATALOG_SYSTEM_PROMPT,
      tool: CATALOG_TOOL,
    },
    {
      id: "classify",
      title: `Capability statuses — one call per competitor scan (${COMPETITORS_PROMPT_VERSION})`,
      note: "Gets the catalog (cached prefix), the previous statuses and the pages that changed since the last scan. Returns has / partial / missing / unknown per capability with confidence, quote and URL, plus up to 8 capabilities the catalog lacks (suggestions). An 'unknown' answer never downgrades a status earlier pages established.",
      text: CLASSIFY_SYSTEM_PROMPT,
      tool: CLASSIFY_TOOL,
    },
    {
      id: "facts",
      title: `Profile facts — one call per competitor scan (${COMPETITORS_PROMPT_VERSION})`,
      note: "Reads the changed pages and returns the lean profile: tagline, products, pricing tiers, integrations, certifications, named customers, verticals — each with its URL. Never runs for the organization's own site.",
      text: FACTS_SYSTEM_PROMPT,
      tool: FACTS_TOOL,
    },
  ];

  return (
    <AdminShell
      user={admin}
      org={org}
      title="Competitors"
      description="The competitors feature's PMOS AI — model, region and the three prompts — and the scanner's runs across every organization. Per-org setup (competitors, catalog, schedule) is in each organization's Settings → Competitors."
    >
      <div className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">PMOS AI</h2>
          <dl className="mt-3 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-500">Model</dt>
            <dd className="font-mono text-xs">{getCompetitorsModel()} <span className="font-sans text-slate-400">(COMPETITORS_MODEL → IDEAS_CATALOG_MODEL → claude-opus-5)</span></dd>
            <dt className="text-slate-500">Vertex region</dt>
            <dd className="font-mono text-xs">{getCompetitorsVertexLocation()} <span className="font-sans text-slate-400">(COMPETITORS_VERTEX_LOCATION → IDEAS_VERTEX_LOCATION → eu)</span></dd>
            <dt className="text-slate-500">Prompt version</dt>
            <dd className="font-mono text-xs">{COMPETITORS_PROMPT_VERSION}</dd>
            <dt className="text-slate-500">Input</dt>
            <dd className="text-xs text-slate-600">Page text only (no HTML, no images), at most 6,000 characters per page and 90,000 per call; the catalog rides as a cached prefix.</dd>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">AI prompts</h2>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">
            The system prompt of each call and the structured answer it is forced to return (a tool schema — the model cannot answer in free text). Read-only; changing them is a code change and bumps the prompt version.
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

        <AdminScans />
      </div>
    </AdminShell>
  );
}
