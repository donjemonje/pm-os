"use client";

/**
 * The cells of the coverage model (Daniel 2026-11-22; rules in lib/competitors/scores.ts and table-view.ts):
 *   - ScoreMark / ScoreCell: a capability cell is the score's number, coloured from gray (0) to green (5), with a small
 *     upright bar filled in proportion to it, both centred in the cell. Its card (hover and click) shows only the
 *     reasoning — no evidence quote, no "why". From the click card a PM can change the score (it is then locked and
 *     marked as edited, and can be released) or add reasoning (PMOS AI re-evaluates the row with it).
 *   - DomainScore: a company's score of a domain, in the domain's header row.
 *   - MoreEvidence: under a feature cell's strongest quote, its hint and the other pieces of evidence with their links.
 * Cards float above everything (Floating.tsx); a card opened by a click catches scrolling while it is open.
 */
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { track } from "@/lib/analytics/track";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { MAX_SCORE, REASONING_MAX, type EvidenceRef } from "@/lib/competitors/scores";
import { scoreColor } from "@/lib/competitors/table-view";
import { cn } from "@/lib/utils";
import { Floating } from "./Floating";

/**
 * A score as the table shows it: the number 0-5, coloured from gray (0) to green (5), and next to it one small upright
 * bar filled in proportion to the score (the row's coverage bar, turned upright).
 */
export function ScoreMark({ score, small = false }: { score: number; small?: boolean }) {
  const color = scoreColor(score);
  return (
    <span className="inline-flex items-center justify-center gap-1.5" role="img" aria-label={C.score.of(score)} data-testid="cmp-score-mark" data-score={score}>
      <span className={cn("font-mono font-bold leading-none", small ? "text-[12px]" : "text-[14px]")} style={{ color }}>{score}</span>
      <span className={cn("relative inline-flex w-1 overflow-hidden rounded-full bg-[rgba(12,25,41,.08)]", small ? "h-[14px]" : "h-[22px]")}>
        <span className="absolute inset-x-0 bottom-0 block rounded-full" style={{ height: `${(Math.max(0, Math.min(MAX_SCORE, score)) / MAX_SCORE) * 100}%`, background: color }} />
      </span>
    </span>
  );
}

/** A company's domain score in the domain's header row: the number, one decimal, in the colour of its nearest step. "—" when the domain has no scored capability. */
export function DomainScore({ score, company }: { score: number | null; company: string }) {
  if (score === null) return <span className="text-[11px] text-fg-faint">—</span>;
  return (
    <span className="font-mono text-[12.5px] font-bold" style={{ color: scoreColor(score) }} title={C.score.domain(company, score)} data-testid="cmp-domain-score">
      {score.toFixed(1)}
    </span>
  );
}

/** What a PM can do on a capability cell. Each answers true when it was saved. Absent = the cell is read-only. */
export interface ScoreActions {
  setScore: (score: number) => Promise<boolean>;
  release: () => Promise<boolean>;
  addReasoning: (text: string) => Promise<boolean>;
  /** "Try again" after a re-evaluation of the row that did not finish. */
  retry: () => Promise<boolean>;
}

/** The look of a card of the coverage model. */
const CARD = "rounded-inner border border-border bg-white text-left font-normal shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]";
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;

/**
 * A capability cell of the coverage model: the number and its bar, centred. Hover shows the reasoning; a click opens the
 * card with the reasoning and, when `actions` is given, "Change the score" and "Add reasoning".
 * Enter confirms, Esc cancels (a textarea confirms with Cmd/Ctrl+Enter). In "Change the score" the number that has the
 * focus is the picked one, so Tab + Enter saves what the PM is on.
 */
export function ScoreCell({ rowId, rowName, columnId, company, score, reasoning, locked, lockedBy, pmReasoning, reevaluating, failed, isOpen, onOpen, onClose, actions }: {
  rowId: string;
  rowName: string;
  /** The competitor's id, or "own". */
  columnId: string;
  company: string;
  score: number;
  reasoning: string | null;
  locked: boolean;
  lockedBy: string | null;
  pmReasoning: string | null;
  /** PMOS AI is re-evaluating the row right now. */
  reevaluating: boolean;
  /** The row's last re-evaluation did not finish. */
  failed: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  actions?: ScoreActions | null;
}) {
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTo = (next: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(next), ms);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const [mode, setMode] = useState<"view" | "score" | "reasoning">("view");
  const [pick, setPick] = useState(score);
  const [text, setText] = useState(pmReasoning ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setMode("view"); setPick(score); setText(pmReasoning ?? "");
      track("cmp_capability_score_opened", { columnId, capabilityId: rowId, score, locked });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen && !hover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isOpen && mode !== "view") setMode("view");
      else if (isOpen) onClose();
      else setHover(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, hover, mode, onClose]);

  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await work();
    setBusy(false);
    if (ok) setMode("view");
  };
  const body = (
    <>
      <p className="m-0 text-[12.5px] leading-relaxed text-foreground" data-testid="cmp-score-reasoning">{reasoning || (score === 0 ? C.score.none : C.score.reasoningEmpty)}</p>
      {locked && <p className="m-0 mt-1.5 flex items-center gap-1 text-[11.5px] text-[#8a5a00]"><Lock size={11} className="shrink-0" />{C.score.lockedBy(lockedBy)}</p>}
      {pmReasoning && mode !== "reasoning" && (
        <p className="m-0 mt-1.5 text-[12px] leading-snug text-fg-2"><span className="font-mono text-[10px] font-medium tracking-[0.04em] text-fg-muted">{C.score.teamReasoning} </span>{pmReasoning}</p>
      )}
      {reevaluating && <p className="m-0 mt-1.5 flex items-center gap-1.5 text-[12px] text-fg-muted" role="status"><Loader2 size={12} className="animate-spin" />{C.score.reevaluating}</p>}
      {!reevaluating && failed && (
        <p className="m-0 mt-1.5 text-[12px] text-[#c94266]" role="alert" data-testid="cmp-score-failed">
          {C.score.reevaluateFailed}
          {isOpen && actions && <button type="button" onClick={() => void run(actions.retry)} disabled={busy} className="ml-1.5 font-semibold underline disabled:opacity-40" data-testid="cmp-score-retry">{C.score.retry}</button>}
        </p>
      )}
    </>
  );
  const head = (
    <div className="mb-1.5 flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold">{rowName}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fg-muted"><span className="truncate">{company}</span><ScoreMark score={score} small /><span className="font-mono font-semibold text-fg-2">{C.score.of(score)}</span></div>
      </div>
      {isOpen && <button type="button" onClick={onClose} className="rounded-md p-1 text-fg-muted hover:bg-background" aria-label={C.score.cancel}><X size={14} /></button>}
    </div>
  );
  return (
    <span className="relative inline-flex items-center justify-center" onMouseEnter={() => hoverTo(true, HOVER_OPEN_MS)} onMouseLeave={() => hoverTo(false, HOVER_CLOSE_MS)}>
      <button type="button" onClick={() => { setHover(false); if (isOpen) onClose(); else onOpen(); }} aria-expanded={isOpen} aria-label={`${rowName} — ${company}: ${C.score.of(score)}`} title={C.score.scoreHint(score)}
        className={cn("relative inline-flex h-9 min-w-[48px] items-center justify-center rounded-[8px] px-2 hover:bg-white/80", isOpen && "bg-white shadow-[0_0_0_2px_var(--app-accent-soft)]")} data-testid="cmp-score-cell">
        {reevaluating ? <Loader2 size={13} className="animate-spin text-fg-muted" aria-label={C.score.reevaluating} /> : <ScoreMark score={score} />}
        {locked && <Lock size={9} className="absolute right-0.5 top-0.5 text-[#8a5a00]" aria-label={C.score.locked} />}
      </button>
      {hover && !isOpen && (
        <Floating align="center" role="tooltip" className={cn(CARD, "w-[320px] p-3")} data-testid="cmp-score-hover" onMouseEnter={() => hoverTo(true, 0)} onMouseLeave={() => hoverTo(false, HOVER_CLOSE_MS)}>
          {head}
          {body}
        </Floating>
      )}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[59] cursor-default" onClick={onClose} />
          <Floating lock align="center" className={cn(CARD, "w-[340px] p-3.5")} data-testid="cmp-score-card">
            {head}
            {body}
            {actions && mode === "view" && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
                <Button size="sm" variant="secondary" onClick={() => { setPick(score); setMode("score"); }} disabled={busy} data-testid="cmp-score-change">{C.score.change}</Button>
                <Button size="sm" variant="secondary" onClick={() => { setText(pmReasoning ?? ""); setMode("reasoning"); }} disabled={busy || reevaluating} data-testid="cmp-score-add-reasoning">{pmReasoning ? C.score.editReasoning : C.score.addReasoning}</Button>
                {locked && <Button size="sm" variant="ghost" onClick={() => void run(actions.release)} disabled={busy} data-testid="cmp-score-release">{C.score.release}</Button>}
              </div>
            )}
            {actions && mode === "score" && (
              <div className="mt-2.5 border-t border-border pt-2.5" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(() => actions.setScore(pick)); } }}>
                <div className="flex items-center gap-1.5" role="radiogroup" aria-label={C.score.change}>
                  {Array.from({ length: MAX_SCORE + 1 }, (_, n) => (
                    <button key={n} type="button" role="radio" aria-checked={pick === n} autoFocus={pick === n} onClick={() => setPick(n)} onFocus={() => setPick(n)} className={cn("flex h-7 w-7 items-center justify-center rounded-full border font-mono text-[12px] font-bold", pick === n ? "border-transparent bg-primary text-white" : "border-border bg-white text-fg-2 hover:border-primary/55")} data-testid={`cmp-score-pick-${n}`}>{n}</button>
                  ))}
                </div>
                <p className="m-0 mt-1.5 text-[11.5px] text-fg-muted">{C.score.changeHint}</p>
                <div className="mt-2 flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => void run(() => actions.setScore(pick))} disabled={busy}>{C.score.save}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>{C.score.cancel}</Button>
                </div>
              </div>
            )}
            {actions && mode === "reasoning" && (
              <div className="mt-2.5 border-t border-border pt-2.5">
                <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, REASONING_MAX))} maxLength={REASONING_MAX} rows={4} autoFocus placeholder={C.score.reasoningPlaceholder} aria-label={C.score.addReasoning}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); void run(() => actions.addReasoning(text.trim())); } }}
                  className="w-full resize-none rounded-[8px] border border-border bg-white px-2.5 py-2 text-[12.5px] leading-snug text-foreground outline-none focus:border-primary/60" data-testid="cmp-score-reasoning-input" />
                <div className="mt-0.5 flex items-start justify-between gap-2 text-[11.5px] text-fg-muted"><span>{C.score.reasoningHint}</span><span className="shrink-0 font-mono">{text.length}/{REASONING_MAX}</span></div>
                <div className="mt-2 flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => void run(() => actions.addReasoning(text.trim()))} disabled={busy || !text.trim()}>{C.score.save}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy}>{C.score.cancel}</Button>
                </div>
              </div>
            )}
          </Floating>
        </>
      )}
    </span>
  );
}

/** "acme.com/pricing" — the page, without the scheme and the www. */
function pageLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

/**
 * Under a feature cell's strongest quote: the hint of that quote (the kind of page and how much the page says) and
 * "Show more evidence · n" — the other pieces of evidence, the strongest first, each with its link and its hint.
 * `evidence` is the whole list; its first entry is the one the card already shows.
 */
export function MoreEvidence({ evidence, rowId, columnId }: { evidence: EvidenceRef[]; rowId: string; columnId: string }) {
  const [open, setOpen] = useState(false);
  if (evidence.length === 0) return null;
  const rest = evidence.slice(1);
  // The hint of a piece of evidence: the kind of page and how much it says.
  const hint = (e: EvidenceRef) => [e.pageKind, C.score.strength(e.strength), e.checked ? "" : C.score.notChecked].filter(Boolean).join(" · ");
  return (
    <div className="mt-1.5">
      {hint(evidence[0]) && <div className="text-[11.5px] text-fg-muted" data-testid="cmp-evidence-hint">{hint(evidence[0])}</div>}
      {rest.length > 0 && (
        <button type="button" onClick={() => { if (!open) track("cmp_feature_more_evidence_opened", { columnId, featureId: rowId, count: rest.length }); setOpen((v) => !v); }} aria-expanded={open} className="mt-1 text-[12px] font-semibold text-primary hover:underline" data-testid="cmp-more-evidence">
          {open ? C.score.lessEvidence : C.score.moreEvidence(rest.length)}
        </button>
      )}
      {open && rest.length > 0 && (
        <ul className="m-0 mt-2 flex max-h-[220px] list-none flex-col gap-2 overflow-y-auto border-t border-border p-0 pt-2" data-testid="cmp-more-evidence-list">
          {rest.map((e, i) => (
            <li key={i} className="text-[12px] leading-snug">
              <span className="italic text-[#1f2f47]">“{e.quote}”</span>
              <span className="mt-0.5 flex max-w-full flex-wrap items-center gap-x-2 text-[11.5px] text-fg-muted">
                {e.url && /^https?:\/\//.test(e.url) && (
                  <a href={e.url} target="_blank" rel="noreferrer" title={e.url} className="flex min-w-0 max-w-full items-center gap-1 text-primary hover:underline"><ExternalLink size={10} className="shrink-0" /><span className="min-w-0 truncate">{pageLabel(e.url)}</span></a>
                )}
                <span>{hint(e)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
