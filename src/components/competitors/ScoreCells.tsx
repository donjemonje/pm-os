"use client";

/**
 * The cells of the coverage model (Daniel 2026-11-22; rules in lib/competitors/scores.ts):
 *   - ScoreMeter / ScoreCell: a capability cell is a 0-5 strength meter. Its card (hover and click) shows only the
 *     reasoning — no evidence quote, no "why". From the click card a PM can change the score (it is then locked and
 *     marked as edited, and can be released) or add reasoning (PMOS AI re-evaluates the row with it).
 *   - DomainScore: a company's score of a domain, in the domain's header row.
 *   - MoreEvidence: under a feature cell's strongest quote, the other pieces of evidence with their links.
 *   - FeatureName / FeatureAdder: a PM renames, removes, adds and restores feature rows under a capability; every
 *     such change has the capability's row re-evaluated (the score must agree with the features).
 * Cards are drawn at the end of the page (a portal), so the table's scrolling box never cuts them.
 */
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Loader2, Lock, Pencil, Plus, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { track } from "@/lib/analytics/track";
import { COMPETITORS_COPY as C } from "@/lib/competitors/copy";
import { MAX_SCORE, REASONING_MAX, type EvidenceRef } from "@/lib/competitors/scores";
import { cn } from "@/lib/utils";

/** Five bars, the first `score` of them filled. 0 = an empty meter. */
export function ScoreMeter({ score, own = false, small = false }: { score: number; own?: boolean; small?: boolean }) {
  return (
    <span className="inline-flex items-end gap-[2px]" role="img" aria-label={C.score.of(score)} data-testid="cmp-score-meter" data-score={score}>
      {Array.from({ length: MAX_SCORE }, (_, i) => (
        <span key={i} className={cn("rounded-[1.5px]", small ? "w-[4px]" : "w-[6px]", i < score ? (own ? "bg-primary" : "bg-[#3f506b]") : "bg-[rgba(12,25,41,.13)]")} style={{ height: (small ? 4 : 6) + i * (small ? 1.5 : 2) }} />
      ))}
    </span>
  );
}

/** A company's domain score in the domain's header row: the number, one decimal. "—" when the domain has no scored capability. */
export function DomainScore({ score, company, own = false }: { score: number | null; company: string; own?: boolean }) {
  if (score === null) return <span className="text-[11px] text-fg-faint">—</span>;
  return (
    <span className={cn("font-mono text-[12.5px] font-bold", own ? "text-primary" : "text-[#1f2f47]")} title={C.score.domain(company, score)} data-testid="cmp-domain-score">
      {score.toFixed(1)}
    </span>
  );
}

/** A card under the element it was opened from (centred), above it when there is no room below, always inside the window; it follows scrolling and resizing. */
function AnchoredCard({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const host = anchor.current?.parentElement;
      const el = card.current;
      if (!host || !el) return;
      const r = host.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left + r.width / 2 - el.offsetWidth / 2, window.innerWidth - el.offsetWidth - 8));
      const below = r.bottom + 6;
      const top = below + el.offsetHeight > window.innerHeight - 8 && r.top - 6 - el.offsetHeight >= 8 ? r.top - 6 - el.offsetHeight : below;
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
    };
    place();
    const grown = new ResizeObserver(place);
    if (card.current) grown.observe(card.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { grown.disconnect(); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {createPortal(
        <div ref={card} {...rest} className={cn("fixed z-[60] rounded-inner border border-border bg-white text-left font-normal shadow-[0_18px_44px_-16px_rgba(10,22,40,.3)]", className)} style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}>{children}</div>,
        document.body,
      )}
    </>
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

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;

/**
 * A capability cell of the coverage model: the meter and the number. Hover shows the reasoning; a click opens the
 * card with the reasoning and, when `actions` is given, "Change the score" and "Add reasoning".
 * Enter confirms, Esc cancels (a textarea confirms with Cmd/Ctrl+Enter). In "Change the score" the number that has the
 * focus is the picked one, so Tab + Enter saves what the PM is on.
 */
export function ScoreCell({ rowId, rowName, columnId, company, own = false, score, reasoning, locked, lockedBy, pmReasoning, reevaluating, failed, isOpen, onOpen, onClose, actions }: {
  rowId: string;
  rowName: string;
  /** The competitor's id, or "own". */
  columnId: string;
  company: string;
  own?: boolean;
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
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fg-muted"><span className="truncate">{company}</span><ScoreMeter score={score} own={own} small /><span className="font-mono font-semibold text-fg-2">{C.score.of(score)}</span></div>
      </div>
      {isOpen && <button type="button" onClick={onClose} className="rounded-md p-1 text-fg-muted hover:bg-background" aria-label={C.score.cancel}><X size={14} /></button>}
    </div>
  );
  return (
    <span className="relative inline-flex items-center justify-center" onMouseEnter={() => hoverTo(true, HOVER_OPEN_MS)} onMouseLeave={() => hoverTo(false, HOVER_CLOSE_MS)}>
      <button type="button" onClick={() => { setHover(false); if (isOpen) onClose(); else onOpen(); }} aria-expanded={isOpen} aria-label={`${rowName} — ${company}: ${C.score.of(score)}`} title={C.score.meterHint(score)}
        className={cn("relative inline-flex h-9 min-w-[64px] items-center justify-center gap-1.5 rounded-[8px] px-1.5 hover:bg-white/80", isOpen && "bg-white shadow-[0_0_0_2px_var(--app-accent-soft)]")} data-testid="cmp-score-cell">
        {reevaluating ? <Loader2 size={13} className="animate-spin text-fg-muted" aria-label={C.score.reevaluating} /> : <ScoreMeter score={score} own={own} />}
        <span className={cn("font-mono text-[11.5px] font-bold", score === 0 ? "text-fg-faint" : own ? "text-primary" : "text-[#1f2f47]")}>{score}</span>
        {locked && <Lock size={9} className="absolute right-0.5 top-0.5 text-[#8a5a00]" aria-label={C.score.locked} />}
      </button>
      {hover && !isOpen && (
        <AnchoredCard role="tooltip" className="w-[320px] p-3" data-testid="cmp-score-hover" onMouseEnter={() => hoverTo(true, 0)} onMouseLeave={() => hoverTo(false, HOVER_CLOSE_MS)}>
          {head}
          {body}
        </AnchoredCard>
      )}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[59] cursor-default" onClick={onClose} />
          <AnchoredCard className="w-[340px] p-3.5" data-testid="cmp-score-card">
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
          </AnchoredCard>
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

/**
 * A feature row's name with its two actions, shown when the pointer is on the name (or a button has focus): rename
 * (an input in place; Enter confirms, Esc cancels) and remove (the row can be restored under its capability).
 */
export function FeatureName({ name, onRename, onRemove }: { name: string; onRename: (name: string) => Promise<boolean>; onRemove: () => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const next = value.trim().replace(/\s+/g, " ");
    if (!next || next === name) { setEditing(false); return; }
    setBusy(true);
    const ok = await onRename(next);
    setBusy(false);
    if (ok) setEditing(false);
  };
  if (editing) {
    return (
      <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus disabled={busy} aria-label={C.score.renameFeature} maxLength={160}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setValue(name); setEditing(false); } }}
        onBlur={() => { if (!busy) { setValue(name); setEditing(false); } }}
        className="h-7 w-full max-w-[420px] rounded-[6px] border border-primary/60 bg-white px-2 text-[12.5px] text-foreground outline-none" data-testid="cmp-feature-rename-input" />
    );
  }
  const tool = "rounded-[5px] p-1 text-fg-muted opacity-0 hover:bg-white hover:text-fg-2 focus:opacity-100 group-hover/fname:opacity-100 disabled:opacity-40";
  return (
    <span className="group/fname inline-flex items-center gap-1">
      {name}
      <button type="button" onClick={() => { setValue(name); setEditing(true); }} disabled={busy} className={tool} title={C.score.renameFeature} aria-label={`${C.score.renameFeature}: ${name}`} data-testid="cmp-feature-rename"><Pencil size={11} /></button>
      <button type="button" onClick={async () => { setBusy(true); await onRemove(); setBusy(false); }} disabled={busy} className={tool} title={`${C.score.removeFeature} — ${C.score.featureChangeHint}`} aria-label={`${C.score.removeFeature}: ${name}`} data-testid="cmp-feature-remove"><X size={12} /></button>
    </span>
  );
}

/**
 * The line under a capability's feature rows: "Add feature" (an input; Enter confirms, Esc cancels) and, when a PM
 * removed rows, "Removed features · n" with a Restore button on each.
 */
export function FeatureAdder({ colSpan, removed, onAdd, onRestore }: { colSpan: number; removed: { id: string; name: string }[]; onAdd: (name: string) => Promise<boolean>; onRestore: (id: string) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const add = async () => {
    const name = value.trim().replace(/\s+/g, " ");
    if (!name) return;
    setBusy(true);
    const ok = await onAdd(name);
    setBusy(false);
    if (ok) { setValue(""); setAdding(false); }
  };
  return (
    <tr className="border-b border-border bg-[rgba(255,255,255,.35)] last:border-b-0" data-testid="cmp-feature-adder">
      <td colSpan={colSpan} className="px-4 py-1.5 pl-[52px] text-[12px]">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {adding ? (
            <span className="inline-flex items-center gap-1.5">
              <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus disabled={busy} placeholder={C.score.addFeaturePlaceholder} aria-label={C.score.addFeature} maxLength={160}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } else if (e.key === "Escape") { e.preventDefault(); setValue(""); setAdding(false); } }}
                className="h-7 w-[320px] rounded-[6px] border border-primary/60 bg-white px-2 text-[12.5px] text-foreground outline-none" data-testid="cmp-feature-add-input" />
              <Button size="sm" variant="primary" onClick={() => void add()} disabled={busy || !value.trim()}>{C.score.save}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setValue(""); setAdding(false); }} disabled={busy}>{C.score.cancel}</Button>
            </span>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline" title={C.score.featureChangeHint} data-testid="cmp-feature-add"><Plus size={12} />{C.score.addFeature}</button>
          )}
          {removed.length > 0 && (
            <button type="button" onClick={() => setShowRemoved((v) => !v)} aria-expanded={showRemoved} className="text-fg-muted hover:text-fg-2 hover:underline" data-testid="cmp-feature-removed-toggle">{C.score.removedFeatures(removed.length)}</button>
          )}
        </span>
        {showRemoved && removed.length > 0 && (
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0" data-testid="cmp-feature-removed-list">
            {removed.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-fg-3">
                <span className="line-through decoration-[rgba(12,25,41,.3)]">{f.name}</span>
                <button type="button" disabled={busy} onClick={async () => { setBusy(true); await onRestore(f.id); setBusy(false); }} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-40" data-testid="cmp-feature-restore"><Undo2 size={11} />{C.score.restoreFeature}</button>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}
