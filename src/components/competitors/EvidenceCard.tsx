"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { track } from "@/lib/analytics/track";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";

/** "acme.com/pricing" — the page, without the scheme and the www. */
function pageLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

/**
 * The evidence behind a cell: the quote from the competitor's page, why it means they offer it, the competitor's
 * own name for it, and the page. Read-only; shared by the cell's hover card, its popover and the profile.
 */
export function EvidenceCard({ quote, url, reasoning, wording, count, empty }: {
  quote: string | null;
  url: string | null;
  reasoning: string | null;
  wording: string | null;
  /** Distinct pages that carry evidence. */
  count: number;
  /** What to say when there is no quote. */
  empty: string;
}) {
  if (!quote) return <div className="text-[12.5px] text-fg-faint" data-testid="cmp-evidence-empty">{empty}</div>;
  return (
    <div className="flex flex-col gap-1.5 text-[12.5px] text-fg-2" data-testid="cmp-evidence-card">
      <blockquote className="m-0 border-l-2 border-border pl-2.5 italic leading-relaxed text-[#1f2f47]">“{quote}”</blockquote>
      {reasoning && (
        <div className="leading-snug">
          <span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.cell.why} </span>
          {reasoning}
        </div>
      )}
      {wording && <div className="text-[12px] text-fg-muted">{C.cell.theirName(wording)}</div>}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" title={url} className="flex max-w-full items-center gap-1 text-[12px] text-primary hover:underline" data-testid="cmp-evidence-link">
          <ExternalLink size={11} className="shrink-0" /> <span className="min-w-0 truncate">{pageLabel(url)}</span>
        </a>
      )}
      {count > 1 && <div className="text-[11.5px] text-fg-muted">{C.cell.evidenceMore(count - 1)}</div>}
    </div>
  );
}

interface EvidenceEntry {
  quote: string;
  url: string;
  title: string | null;
  reasoning: string;
  wording: string;
  tier: string;
}

/**
 * "All evidence · n" under a cell's evidence: loads every page that carries it (best first) on demand, with an
 * explicit loading line and an error line.
 */
export function EvidenceList({ cellId, kind, competitorId, rowId, count }: { cellId: string; kind: "capability" | "feature"; competitorId: string; rowId: string; count: number }) {
  const [state, setState] = useState<{ status: "closed" } | { status: "loading" } | { status: "failed" } | { status: "open"; evidence: EvidenceEntry[] }>({ status: "closed" });
  async function load() {
    setState({ status: "loading" });
    track("cmp_evidence_list_opened", { competitorId, rowKind: kind, rowId, count });
    try {
      const res = await fetch(`/api/competitors/statuses/${cellId}/evidence${kind === "feature" ? "?kind=feature" : ""}`);
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.evidence)) throw new Error();
      setState({ status: "open", evidence: data.evidence as EvidenceEntry[] });
    } catch {
      setState({ status: "failed" });
    }
  }
  if (state.status === "closed") {
    return <button type="button" onClick={() => void load()} className="mt-1.5 text-[12px] font-semibold text-primary hover:underline" data-testid="cmp-evidence-all">{C.cell.allEvidence(count)}</button>;
  }
  if (state.status === "loading") {
    return <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-fg-muted" role="status"><Loader2 size={12} className="animate-spin" />{C.cell.evidenceLoading}</div>;
  }
  if (state.status === "failed") {
    return (
      <div className="mt-1.5 text-[12px] text-[#c94266]" role="alert">
        {C.cell.evidenceFailed} <button type="button" onClick={() => void load()} className="font-semibold underline">{C.cell.allEvidence(count)}</button>
      </div>
    );
  }
  if (state.evidence.length === 0) return <div className="mt-1.5 text-[12px] text-fg-faint">{C.cell.evidenceEmpty}</div>;
  return (
    <ul className="m-0 mt-2 flex max-h-[240px] list-none flex-col gap-2 overflow-y-auto border-t border-border p-0 pt-2" data-testid="cmp-evidence-list">
      {state.evidence.map((e, i) => (
        <li key={i} className="text-[12px] leading-snug">
          <span className="italic text-[#1f2f47]">“{e.quote}”</span>
          <a href={e.url} target="_blank" rel="noreferrer" title={e.url} className="mt-0.5 flex max-w-full items-center gap-1 text-[11.5px] text-primary hover:underline">
            <ExternalLink size={10} className="shrink-0" /> <span className="min-w-0 truncate">{e.title || pageLabel(e.url)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
