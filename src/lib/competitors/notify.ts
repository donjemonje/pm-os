/**
 * The scan notification — one email per scan run, sent when the run's last
 * scan finishes, only about what that run changed: statuses that moved (a gap
 * opened when the org lacks the capability), first entries into a domain, new
 * dated facts, and new catalog suggestions. Nothing unchanged is listed; a run
 * that changed nothing sends nothing. Recipients: the users picked in
 * Settings → Competitors → Notifications. Rendered as table-based HTML with a
 * plain-text twin, through the shared mailer.
 */
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { sendEmail } from "../mailer";
import { recordCompetitorEvent } from "./analytics";
import { COMPETITORS_COPY as C } from "./copy";
import type { OwnStatus, StatusValue } from "./config";
import { getCompetitorsConfig } from "./store";

const RANK: Record<StatusValue, number> = { has: 3, partial: 2, missing: 1, unknown: 0 };

export type ChangeKind = "gap" | "raised" | "lowered";

/** How a cell's move reads for the org: a gap when they now offer what the org lacks, else raised or lowered. */
export function classifyChange(from: StatusValue, to: StatusValue, own: OwnStatus): ChangeKind | null {
  if (RANK[to] === RANK[from]) return null;
  if (RANK[to] < RANK[from]) return "lowered";
  return own === "missing" && (to === "has" || to === "partial") ? "gap" : "raised";
}

/** A domain entrance: every cell of the domain was missing/unknown before and at least one is has/partial now. */
export function isDomainEntrance(before: StatusValue[], after: StatusValue[]): boolean {
  if (before.length === 0) return false;
  const had = before.some((v) => v === "has" || v === "partial");
  const has = after.some((v) => v === "has" || v === "partial");
  return !had && has;
}

export interface StatusChangeItem {
  capability: string;
  domain: string;
  from: StatusValue;
  to: StatusValue;
  own: OwnStatus;
  kind: ChangeKind;
  quote: string | null;
  sourceUrl: string | null;
  product: string | null;
}
export interface FactItem {
  kind: string;
  value: string;
  sourceUrl: string | null;
  factDate: string | null;
}
export interface SuggestionItem {
  name: string;
  domain: string;
}
export interface CompetitorChanges {
  competitorId: string;
  name: string;
  pagesRead: number;
  pagesChanged: number;
  changes: StatusChangeItem[];
  /** Domains the competitor entered in this run, with the capabilities now present. */
  domainEntrances: { domain: string; capabilities: string[] }[];
  facts: FactItem[];
  suggestions: SuggestionItem[];
}
export interface RunNotification {
  orgName: string;
  startedBy: string | null;
  trigger: string;
  startedAt: Date;
  sitesScanned: number;
  competitors: CompetitorChanges[];
  /** Scanned in this run with nothing to report. */
  unchanged: string[];
  appUrl: string;
}

export function hasChanges(c: CompetitorChanges): boolean {
  return c.changes.length > 0 || c.facts.length > 0 || c.suggestions.length > 0;
}

export interface RunSummary {
  competitors: number;
  gaps: number;
  raised: number;
  lowered: number;
  domains: number;
  facts: number;
  suggestions: number;
  recipients: number;
  skipped?: { name: string; reason: string }[];
}

export function summarize(n: RunNotification, recipients: number): RunSummary {
  const all = n.competitors.flatMap((c) => c.changes);
  return {
    competitors: n.competitors.length,
    gaps: all.filter((x) => x.kind === "gap").length,
    raised: all.filter((x) => x.kind === "raised").length,
    lowered: all.filter((x) => x.kind === "lowered").length,
    domains: n.competitors.reduce((s, c) => s + c.domainEntrances.length, 0),
    facts: n.competitors.reduce((s, c) => s + c.facts.length, 0),
    suggestions: n.competitors.reduce((s, c) => s + c.suggestions.length, 0),
    recipients,
  };
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** What a finished run changed, per competitor — from the pipeline's own rows (statuses, history, facts, suggestions). */
export async function collectRunChanges(runId: string): Promise<RunNotification | null> {
  const run = await db.competitorScanRun.findUnique({ where: { id: runId } });
  if (!run) return null;
  const [workspace, scans, starter] = await Promise.all([
    db.workspace.findUnique({ where: { id: run.workspaceId }, select: { organization: { select: { name: true } } } }),
    db.competitorScan.findMany({
      where: { runId, status: { in: ["ok", "partial"] } },
      orderBy: { startedAt: "asc" },
      select: { id: true, pagesFetched: true, pagesChanged: true, source: { select: { competitor: { select: { id: true, name: true, position: true } } } } },
    }),
    run.startedById ? db.user.findUnique({ where: { id: run.startedById }, select: { name: true, email: true } }) : null,
  ]);
  const scanIds = scans.map((s) => s.id);
  const byCompetitor = new Map<string, CompetitorChanges & { position: number }>();
  for (const s of scans) {
    const c = s.source.competitor;
    const row = byCompetitor.get(c.id) ?? { competitorId: c.id, name: c.name, position: c.position, pagesRead: 0, pagesChanged: 0, changes: [], domainEntrances: [], facts: [], suggestions: [] };
    row.pagesRead += s.pagesFetched;
    row.pagesChanged += s.pagesChanged;
    byCompetitor.set(c.id, row);
  }
  const competitorIds = [...byCompetitor.keys()];
  if (competitorIds.length === 0) return null;

  const [moved, facts, suggestions] = await Promise.all([
    db.capabilityStatus.findMany({
      where: { scanId: { in: scanIds }, changedAt: { gte: run.startedAt } },
      include: {
        capability: { select: { name: true, ourStatus: true, domainId: true, domain: { select: { name: true } } } },
        history: { where: { at: { gte: run.startedAt } }, orderBy: { at: "asc" }, take: 1 },
      },
    }),
    db.profileFact.findMany({
      where: { scanId: { in: scanIds }, changedAt: { not: null }, dismissedAt: null },
      orderBy: [{ factDate: "desc" }, { createdAt: "asc" }],
      select: { competitorId: true, kind: true, value: true, sourceUrl: true, factDate: true },
    }),
    db.capability.findMany({
      where: { workspaceId: run.workspaceId, origin: "ai", state: "suggested", suggestedById: { in: competitorIds }, createdAt: { gte: run.startedAt } },
      orderBy: { createdAt: "asc" },
      select: { name: true, suggestedById: true, domain: { select: { name: true } } },
    }),
  ]);

  for (const m of moved) {
    const row = byCompetitor.get(m.competitorId);
    const before = m.history[0];
    if (!row || !before) continue;
    const own = (m.capability.ourStatus === "partial" || m.capability.ourStatus === "missing" ? m.capability.ourStatus : "has") as OwnStatus;
    const kind = classifyChange(before.value as StatusValue, m.value as StatusValue, own);
    if (!kind) continue;
    row.changes.push({ capability: m.capability.name, domain: m.capability.domain.name, from: before.value as StatusValue, to: m.value as StatusValue, own, kind, quote: m.quote, sourceUrl: m.sourceUrl, product: m.product });
  }
  // Domain entrances: per competitor and domain touched by a change, compare the domain's cells before and after the run.
  const touched = new Map<string, Set<string>>();
  for (const m of moved) {
    if (!byCompetitor.has(m.competitorId) || !m.history[0]) continue;
    const set = touched.get(m.competitorId) ?? new Set<string>();
    set.add(m.capability.domainId);
    touched.set(m.competitorId, set);
  }
  for (const [competitorId, domainIds] of touched) {
    const cells = await db.capabilityStatus.findMany({
      where: { competitorId, capability: { domainId: { in: [...domainIds] }, state: "active" } },
      select: { id: true, value: true, capability: { select: { name: true, domainId: true, domain: { select: { name: true } } } } },
    });
    const movedById = new Map(moved.filter((m) => m.competitorId === competitorId && m.history[0]).map((m) => [m.id, m.history[0].value as StatusValue]));
    for (const domainId of domainIds) {
      const inDomain = cells.filter((c) => c.capability.domainId === domainId);
      const before = inDomain.map((c) => movedById.get(c.id) ?? (c.value as StatusValue));
      const after = inDomain.map((c) => c.value as StatusValue);
      if (isDomainEntrance(before, after)) {
        byCompetitor.get(competitorId)!.domainEntrances.push({
          domain: inDomain[0].capability.domain.name,
          capabilities: inDomain.filter((c) => c.value === "has" || c.value === "partial").map((c) => c.capability.name),
        });
      }
    }
  }
  for (const f of facts) byCompetitor.get(f.competitorId)?.facts.push({ kind: f.kind, value: f.value, sourceUrl: f.sourceUrl, factDate: f.factDate?.toISOString() ?? null });
  for (const s of suggestions) if (s.suggestedById) byCompetitor.get(s.suggestedById)?.suggestions.push({ name: s.name, domain: s.domain.name });

  const ordered = [...byCompetitor.values()].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  return {
    orgName: workspace?.organization.name ?? "",
    startedBy: starter ? starter.name || starter.email : null,
    trigger: run.trigger,
    startedAt: run.startedAt,
    sitesScanned: ordered.length,
    competitors: ordered.filter(hasChanges).map(({ position: _p, ...c }) => c),
    unchanged: ordered.filter((c) => !hasChanges(c)).map((c) => c.name),
    appUrl: appUrl(),
  };
}

// ————— Rendering —————

const TITLE = "'DM Sans', Arial, sans-serif";
const BODY = "'IBM Plex Sans', Arial, sans-serif";
const INK = "#0c1929";
const INK3 = "#4a5b74";
const MUTED = "#7a8aa3";
const BORDER = "#c8d4e8";
const ACCENT = "#2457f5";
const BARS = ["#0b1430", "#c23767", "#189179", "#7f5be0", "#2a5fd0", "#8a5a00"];
const TONE: Record<ChangeKind, { fg: string; bg: string; border: string }> = {
  gap: { fg: "#c23767", bg: "rgba(239,90,138,0.06)", border: "rgba(239,90,138,0.35)" },
  raised: { fg: "#2a5fd0", bg: "#ffffff", border: BORDER },
  lowered: { fg: "#8a5a00", bg: "#ffffff", border: BORDER },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function short(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
}
function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || name.slice(0, 2).toUpperCase();
}
function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function chip(text: string, fg: string, bg: string, size = 12): string {
  return `<span style="display:inline-block;font-family:${TITLE};font-weight:600;font-size:${size}px;line-height:${size + 6}px;color:${fg};background:${bg};border-radius:10px;padding:2px 10px;margin:0 6px 6px 0;">${esc(text)}</span>`;
}
function eyebrow(text: string, color: string): string {
  return `<div style="font-family:${TITLE};font-weight:600;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${color};margin:0 0 8px;">${esc(text)}</div>`;
}
function link(url: string, text: string, color = ACCENT): string {
  return `<a href="${esc(url)}" style="color:${color};text-decoration:none;">${esc(text)}</a>`;
}

function changeCard(x: StatusChangeItem, org: string): string {
  const t = TONE[x.kind];
  const move = `${C.values[x.from]} → ${C.values[x.to]} · ${C.notify.email.ownStatus(org, C.values[x.own].toLowerCase())}`;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 8px;"><tr><td style="border:1px solid ${t.border};background:${t.bg};border-radius:10px;padding:12px 16px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
      <td style="font-family:${TITLE};font-weight:600;font-size:15px;color:${INK};">${esc(x.capability)}</td>
      <td align="right" style="font-family:${TITLE};font-weight:600;font-size:12px;color:${t.fg};white-space:nowrap;padding-left:12px;">${esc(move)}</td>
    </tr></table>
    ${x.quote ? `<div style="font-family:${BODY};font-size:13px;line-height:1.5;color:#1f2f47;font-style:italic;margin-top:5px;">“${esc(x.quote)}”</div>` : ""}
    <div style="font-family:${BODY};font-size:12px;color:${MUTED};margin-top:5px;">${x.product ? `${esc(x.product)} · ` : ""}${x.sourceUrl ? link(x.sourceUrl, short(x.sourceUrl)) : esc(x.domain)}</div>
  </td></tr></table>`;
}

function factRow(f: FactItem, last: boolean): string {
  const label = C.notify.email.factKinds[f.kind] ?? f.kind;
  const when = dateLabel(f.factDate);
  return `<tr><td style="padding:10px 16px;${last ? "" : `border-bottom:1px solid rgba(200,212,232,0.5);`}">
    ${chip(label, INK3, "#eef1f8", 11)}<span style="font-family:${BODY};font-size:14px;line-height:1.45;color:${INK};font-weight:500;">${f.sourceUrl ? link(f.sourceUrl, f.value, INK) : esc(f.value)}</span>${when ? `<span style="font-family:${BODY};font-size:13px;color:${MUTED};"> · ${esc(when)}</span>` : ""}
  </td></tr>`;
}

function competitorBlock(c: CompetitorChanges, i: number, n: RunNotification, single: boolean): string {
  const bar = BARS[i % BARS.length];
  const groups: ChangeKind[] = ["gap", "raised", "lowered"];
  const labels: Record<ChangeKind, string> = { gap: C.notify.email.gapOpened, raised: C.notify.email.raised, lowered: C.notify.email.lowered };
  let html = "";
  if (!single) {
    html += `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 14px;"><tr>
      <td style="width:30px;"><span id="c-${esc(c.competitorId)}" style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;background:${bar};color:#fff;font-family:${TITLE};font-weight:700;font-size:12px;">${esc(initials(c.name))}</span></td>
      <td style="padding-left:10px;font-family:${TITLE};font-weight:700;font-size:19px;letter-spacing:-.01em;color:${INK};">${esc(c.name)}</td>
      <td align="right" style="font-family:${TITLE};font-weight:600;font-size:12px;white-space:nowrap;">${link(`${n.appUrl}/competitors`, C.notify.email.openProfile)}</td>
    </tr></table>`;
  }
  for (const g of groups) {
    const items = c.changes.filter((x) => x.kind === g);
    if (!items.length) continue;
    html += `<div style="margin:0 0 14px;">${eyebrow(labels[g], TONE[g].fg)}${items.map((x) => changeCard(x, n.orgName)).join("")}</div>`;
  }
  for (const d of c.domainEntrances) {
    html += `<div style="margin:0 0 14px;">${eyebrow(C.notify.email.domainEntrance(d.domain), "#0f7a47")}
      <div style="border:1px solid ${BORDER};border-radius:10px;padding:12px 16px;font-family:${BODY};font-size:13px;line-height:1.5;color:#1f2f47;">${esc(d.capabilities.join(", "))}</div></div>`;
  }
  if (c.facts.length) {
    html += `<div style="margin:0 0 14px;">${eyebrow(C.notify.email.alsoNew, INK3)}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${BORDER};border-radius:10px;border-collapse:separate;overflow:hidden;">${c.facts.map((f, k) => factRow(f, k === c.facts.length - 1)).join("")}</table></div>`;
  }
  return `<tr><td style="padding:${single ? "18px" : "14px"} 32px 6px;${single ? "" : `border-top:4px solid ${bar};`}">${html}</td></tr>`;
}

/** The email, or null when the run changed nothing. */
export function renderRunEmail(n: RunNotification): { subject: string; html: string; text: string } | null {
  if (n.competitors.length === 0) return null;
  const e = C.notify.email;
  const single = n.competitors.length === 1;
  const s = summarize(n, 0);
  const subject = single ? e.subjectOne(n.competitors[0].name) : e.subjectMany(n.competitors.length);
  const heading = single ? e.headingOne(n.competitors[0].name, n.orgName) : e.headingMany(n.competitors.length, n.orgName);
  const when = n.startedAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const preheader = [s.gaps && e.chipGap(s.gaps), s.raised && e.chipRaised(s.raised), s.lowered && e.chipLowered(s.lowered), s.domains && e.chipDomain(s.domains), s.facts && e.chipFacts(s.facts), s.suggestions && e.chipSuggestions(s.suggestions)].filter(Boolean).join(", ");

  const headChips = [
    single ? e.pages(n.competitors[0].pagesRead, n.competitors[0].pagesChanged) : e.sites(n.sitesScanned, n.competitors.length),
    when,
    n.trigger === "scheduled" ? e.scheduled : n.startedBy ? e.startedBy(n.startedBy) : null,
  ].filter((x): x is string => Boolean(x));
  const summaryChips = [
    s.gaps ? chip(e.chipGap(s.gaps), "#c23767", "rgba(239,90,138,0.15)") : "",
    s.raised ? chip(e.chipRaised(s.raised), "#2a5fd0", "rgba(59,124,246,0.15)") : "",
    s.lowered ? chip(e.chipLowered(s.lowered), "#8a5a00", "#fff7e0") : "",
    s.domains ? chip(e.chipDomain(s.domains), "#0f7a47", "rgba(23,178,106,0.14)") : "",
    s.facts || s.suggestions ? chip([s.facts && e.chipFacts(s.facts), s.suggestions && e.chipSuggestions(s.suggestions)].filter(Boolean).join(" · "), INK3, "#eef1f8") : "",
  ].join("");

  const glance = single ? "" : `<tr><td style="padding:18px 32px 0;">${eyebrow(e.glance, INK3)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${BORDER};border-radius:10px;border-collapse:separate;overflow:hidden;">
    ${n.competitors.map((c, i) => {
      const cs = summarize({ ...n, competitors: [c] }, 0);
      const chips = [cs.gaps ? chip(e.chipGap(cs.gaps), "#c23767", "rgba(239,90,138,0.15)", 11) : "", cs.raised ? chip(e.chipRaised(cs.raised), "#2a5fd0", "rgba(59,124,246,0.15)", 11) : "", cs.lowered ? chip(e.chipLowered(cs.lowered), "#8a5a00", "#fff7e0", 11) : "", cs.domains ? chip(e.chipDomain(cs.domains), "#0f7a47", "rgba(23,178,106,0.14)", 11) : "", cs.facts ? chip(e.chipFacts(cs.facts), INK3, "#eef1f8", 11) : "", cs.suggestions ? chip(e.chipSuggestions(cs.suggestions), INK3, "#eef1f8", 11) : ""].join("");
      return `<tr><td style="padding:10px 16px;${i === n.competitors.length - 1 ? "" : `border-bottom:1px solid rgba(200,212,232,0.5);`}">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="width:26px;"><span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;border-radius:7px;background:${BARS[i % BARS.length]};color:#fff;font-family:${TITLE};font-weight:700;font-size:11px;">${esc(initials(c.name))}</span></td>
          <td style="padding-left:10px;font-family:${TITLE};font-weight:600;font-size:14px;color:${INK};">${esc(c.name)} <span style="font-family:${BODY};font-weight:400;font-size:12px;color:${MUTED};">${esc(e.pages(c.pagesRead, c.pagesChanged))}</span></td>
          <td align="right" style="white-space:nowrap;">${chips}</td>
        </tr></table></td></tr>`;
    }).join("")}
    </table>
    ${n.unchanged.length ? `<div style="font-family:${BODY};font-size:12px;color:${MUTED};margin-top:8px;">${esc(e.unchanged(n.unchanged))}</div>` : ""}
  </td></tr>`;

  const allSuggestions = n.competitors.flatMap((c) => c.suggestions.map((sg) => ({ ...sg, competitor: c.name })));
  const suggestions = allSuggestions.length
    ? `<tr><td style="padding:18px 32px 0;${single ? "" : `border-top:1px solid rgba(200,212,232,0.5);`}">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td>${eyebrow(`${e.suggestions} · ${allSuggestions.length}`, INK3)}</td><td align="right" style="font-family:${BODY};font-size:12px;color:${MUTED};padding-bottom:8px;">${esc(e.suggestionsHint)}</td></tr></table>
        ${allSuggestions.map((sg) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 8px;"><tr><td style="border:1px dashed rgba(59,124,246,0.55);border-radius:10px;padding:9px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td style="font-family:${BODY};font-size:14px;color:${INK};"><span style="font-weight:500;">${esc(sg.name)}</span> <span style="color:${MUTED};">· ${esc(sg.domain)}${single ? "" : ` · ${esc(sg.competitor)}`}</span></td>
            <td align="right" style="font-family:${TITLE};font-weight:600;font-size:12px;white-space:nowrap;">${link(`${n.appUrl}/settings/competitors`, e.review)}</td>
          </tr></table></td></tr></table>`).join("")}
      </td></tr>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef1f8;"><tr><td align="center" style="padding:24px 16px 40px;">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;border-collapse:separate;overflow:hidden;">
  <tr><td style="background:#0b1430;padding:24px 32px 22px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
      <td style="font-family:${TITLE};font-weight:700;font-size:17px;letter-spacing:-.01em;"><span style="color:#f3f1fb;">PM</span><span style="color:#7aa7ff;">-OS</span></td>
      <td align="right" style="font-family:${TITLE};font-weight:600;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#aaa3c4;">${esc(e.eyebrow)}</td>
    </tr></table>
    <h1 style="margin:12px 0 12px;font-family:${TITLE};font-weight:700;font-size:26px;line-height:1.2;letter-spacing:-.02em;color:#ffffff;">${esc(heading)}</h1>
    <div>${headChips.map((t) => chip(t, "#f3f1fb", "rgba(255,255,255,0.1)")).join("")}</div>
  </td></tr>
  <tr><td style="padding:18px 32px 0;">${summaryChips}</td></tr>
  ${glance}
  ${n.competitors.map((c, i) => competitorBlock(c, i, n, single)).join("")}
  ${suggestions}
  <tr><td style="padding:18px 32px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
      <td style="border-radius:8px;background:${ACCENT};"><a href="${esc(n.appUrl)}/competitors" style="display:inline-block;padding:10px 16px;font-family:${TITLE};font-weight:600;font-size:14px;color:#ffffff;text-decoration:none;">${esc(e.openMatrix)}</a></td>
      <td style="padding-left:10px;"><a href="${esc(n.appUrl)}/settings/competitors" style="display:inline-block;padding:9px 16px;border:1px solid ${BORDER};border-radius:8px;font-family:${TITLE};font-weight:600;font-size:14px;color:${ACCENT};text-decoration:none;">${esc(e.openLog)}</a></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 32px 18px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid rgba(200,212,232,0.5);"><tr>
      <td style="padding-top:14px;font-family:${BODY};font-size:12px;color:${MUTED};">${link(`${n.appUrl}/settings/competitors`, e.settings, MUTED)}</td>
      <td align="right" style="padding-top:14px;font-family:${BODY};font-size:12px;color:${MUTED};">${esc(single ? e.footer : e.footerMany)}</td>
    </tr></table>
  </td></tr>
</table>
<div style="font-family:${BODY};font-size:11px;color:#9aa8be;text-align:center;padding-top:14px;">${esc(e.fine)}</div>
</td></tr></table>
</body></html>`;

  const lines: string[] = [heading, "", headChips.join(" · "), preheader, ""];
  for (const c of n.competitors) {
    if (!single) lines.push(`== ${c.name} (${e.pages(c.pagesRead, c.pagesChanged)}) ==`);
    for (const g of ["gap", "raised", "lowered"] as ChangeKind[]) {
      const items = c.changes.filter((x) => x.kind === g);
      if (!items.length) continue;
      lines.push(g === "gap" ? e.gapOpened : g === "raised" ? e.raised : e.lowered);
      for (const x of items) lines.push(`- ${x.capability}: ${C.values[x.from]} → ${C.values[x.to]} (${e.ownStatus(n.orgName, C.values[x.own].toLowerCase())})${x.quote ? ` — “${x.quote}”` : ""}${x.sourceUrl ? ` ${x.sourceUrl}` : ""}`);
    }
    for (const d of c.domainEntrances) lines.push(`${e.domainEntrance(d.domain)}: ${d.capabilities.join(", ")}`);
    if (c.facts.length) {
      lines.push(e.alsoNew);
      for (const f of c.facts) lines.push(`- ${C.notify.email.factKinds[f.kind] ?? f.kind}: ${f.value}${f.factDate ? ` · ${dateLabel(f.factDate)}` : ""}${f.sourceUrl ? ` ${f.sourceUrl}` : ""}`);
    }
    lines.push("");
  }
  if (n.unchanged.length) lines.push(e.unchanged(n.unchanged), "");
  if (allSuggestions.length) {
    lines.push(`${e.suggestions} (${allSuggestions.length})`);
    for (const sg of allSuggestions) lines.push(`- ${sg.name} · ${sg.domain}${single ? "" : ` · ${sg.competitor}`}`);
    lines.push("");
  }
  lines.push(`${e.openMatrix}: ${n.appUrl}/competitors`, `${e.openLog}: ${n.appUrl}/settings/competitors`, "", single ? e.footer : e.footerMany);
  return { subject, html, text: lines.join("\n") };
}

/** Send the run's notification to the picked users and record what was sent on the run. */
export async function notifyRun(runId: string): Promise<RunSummary | null> {
  const run = await db.competitorScanRun.findUnique({ where: { id: runId }, select: { workspaceId: true, startedById: true, summary: true } });
  if (!run) return null;
  const n = await collectRunChanges(runId);
  const keep = run.summary && typeof run.summary === "object" && !Array.isArray(run.summary) ? (run.summary as Record<string, unknown>) : {};
  const save = (summary: RunSummary, notifiedAt: Date | null) =>
    db.competitorScanRun.update({ where: { id: runId }, data: { summary: { ...keep, ...summary } as unknown as Prisma.InputJsonValue, ...(notifiedAt ? { notifiedAt } : {}) } });
  if (!n) {
    const empty = summarize({ orgName: "", startedBy: null, trigger: "manual", startedAt: new Date(), sitesScanned: 0, competitors: [], unchanged: [], appUrl: "" }, 0);
    await save(empty, null);
    return empty;
  }
  const mail = renderRunEmail(n);
  const config = await getCompetitorsConfig(run.workspaceId);
  const workspace = await db.workspace.findUnique({ where: { id: run.workspaceId }, select: { organizationId: true } });
  const recipients = mail && config.notifyUserIds.length && workspace
    ? await db.user.findMany({ where: { id: { in: config.notifyUserIds }, organizationId: workspace.organizationId, deactivatedAt: null }, select: { email: true } })
    : [];
  let sent = 0;
  if (mail) {
    for (const r of recipients) {
      try {
        await sendEmail({ to: r.email, subject: mail.subject, text: mail.text, html: mail.html });
        sent++;
      } catch (e) {
        console.error("[competitors] notification not sent", r.email, e instanceof Error ? e.message : e);
      }
    }
  }
  const summary = summarize(n, sent);
  await save(summary, sent ? new Date() : null);
  await recordCompetitorEvent(run.workspaceId, run.startedById, "cmp_notification_sent", { runId, competitors: summary.competitors, gaps: summary.gaps, raised: summary.raised, lowered: summary.lowered, facts: summary.facts, suggestions: summary.suggestions, recipients: sent, picked: config.notifyUserIds.length });
  return summary;
}
