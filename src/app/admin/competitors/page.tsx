import { requireAdminPage } from "@/lib/admin-auth";
import { getAdminOrg } from "@/lib/admin-org";
import {
  CLASSIFY_SYSTEM_PROMPT,
  CLASSIFY_TOOL,
  COMPETITORS_PROMPT_VERSION,
  FACTS_SYSTEM_PROMPT,
  FACTS_TOOL,
  getCompetitorsGeminiLocation,
  getCompetitorsModel,
  getCompetitorsProvider,
} from "@/lib/competitors/ai";
import { getCompetitorsVertexLocation } from "@/lib/competitors/vertex";
import { AdminShell } from "../AdminShell";
import { AdminScans } from "./AdminScans";
import { AdminScanning } from "./AdminScanning";

/**
 * Admin → Competitors: the PMOS AI prompts of the competitors feature
 * (read-only, with the structured answer each call must return) and every
 * organization's scan runs. Daniel's rule: any new AI logic is visible here.
 * The organization itself is never scanned (2026-10-26): its catalog, domain
 * definitions and own statuses are entered by its PMs.
 */
export default async function AdminCompetitorsPage() {
  const admin = await requireAdminPage("/admin/competitors");
  const org = await getAdminOrg(admin.organizationId);
  const prompts = [
    {
      id: "classify",
      title: `Capability statuses — one call per competitor scan (${COMPETITORS_PROMPT_VERSION})`,
      note: "Gets the catalog with each domain's definition text (cached prefix), the previous statuses and the pages that changed since the last scan. Returns has / partial / missing / unknown per capability with confidence, quote and URL, plus up to 8 capabilities the catalog lacks (suggestions). An 'unknown' answer never downgrades a status earlier pages established.",
      text: CLASSIFY_SYSTEM_PROMPT,
      tool: CLASSIFY_TOOL,
    },
    {
      id: "facts",
      title: `Profile facts — one call per competitor scan (${COMPETITORS_PROMPT_VERSION})`,
      note: "Reads the changed pages and returns the lean profile: tagline, products, pricing tiers, integrations, certifications, named customers, verticals — each with its URL.",
      text: FACTS_SYSTEM_PROMPT,
      tool: FACTS_TOOL,
    },
  ];

  return (
    <AdminShell
      user={admin}
      org={org}
      title="Competitors"
      description="The competitors feature's PMOS AI — model, region and the two prompts — the scanning switches (remote lane, retention, station keys, per-source frequency) and every organization's scans. Per-org setup (competitors, catalog, manual-rescan limit) is in each organization's Settings → Competitors."
    >
      <div className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">PMOS AI</h2>
          <dl className="mt-3 grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-500">Model</dt>
            <dd className="font-mono text-xs">{getCompetitorsModel()} <span className="font-sans text-slate-400">(COMPETITORS_MODEL → GEMINI_MODEL → gemini-4-argon; a gemini-* id runs on Gemini, anything else on Claude)</span></dd>
            <dt className="text-slate-500">Provider</dt>
            <dd className="font-mono text-xs">{getCompetitorsProvider()} <span className="font-sans text-slate-400">{getCompetitorsProvider() === "gemini" ? "— structured output through a response schema" : "— forced tool use through the Vertex Anthropic client"}</span></dd>
            <dt className="text-slate-500">Vertex region</dt>
            <dd className="font-mono text-xs">{getCompetitorsProvider() === "gemini" ? getCompetitorsGeminiLocation() : getCompetitorsVertexLocation()} <span className="font-sans text-slate-400">{getCompetitorsProvider() === "gemini" ? "(COMPETITORS_GEMINI_LOCATION → global; the newest Gemini models are served on the global endpoint only)" : "(COMPETITORS_VERTEX_LOCATION → IDEAS_VERTEX_LOCATION → eu)"}</span></dd>
            <dt className="text-slate-500">Prompt version</dt>
            <dd className="font-mono text-xs">{COMPETITORS_PROMPT_VERSION}</dd>
            <dt className="text-slate-500">Input</dt>
            <dd className="text-xs text-slate-600">Page text only (no HTML, no images), at most 6,000 characters per page and 90,000 per call; the catalog rides as a cached prefix.</dd>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold">AI prompts</h2>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">
            The system prompt of each of the two calls and the structured answer it is forced to return (a schema — Gemini's response schema or Claude's tool input; the model cannot answer in free text). Read-only; changing them is a code change and bumps the prompt version.
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
        <AdminScans />
      </div>
    </AdminShell>
  );
}
