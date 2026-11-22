import { db } from "../../db";
import { sendEmail } from "../../mailer";
import { recordCompetitorEvent } from "../analytics";
import { COMPETITORS_COPY as C } from "../copy";

/**
 * THE NEWS NOTIFICATION — one email per intake batch, sent as soon as the batch is read (News Feed & Notifications
 * PRD: "immediately"). For now it goes to PM-OS only (Daniel 2026-11-21: he reviews and passes on by hand); nothing
 * is sent to a customer's users. It reports all three verdicts, so every decision PMOS AI took can be checked:
 * new abilities (also in the feed), abilities the list already holds, and news that is not an ability.
 *
 * Plain on purpose: a bottom line per item, no reading task.
 */

/** The one recipient, for now. An environment setting, so a test or another operator can change it without code. */
export function newsRecipient(): string {
  return process.env.COMPETITORS_NEWS_NOTIFY_TO?.trim() || "daniel@pm-os.io";
}

export interface NewsEmailRow {
  verdict: string;
  otherType: string | null;
  size: string | null;
  name: string;
  what: string;
  problem: string | null;
  workflows: string | null;
  audience: string | null;
  quote: string | null;
  quoteOk: boolean;
  reason: string;
  coveredName: string | null;
  parentName: string | null;
  sourceUrl: string;
  sourceTitle: string;
}

export interface NewsEmail {
  orgName: string;
  competitorName: string;
  simulated: boolean;
  pages: number;
  failedPages: number;
  rows: NewsEmailRow[];
  appUrl: string;
  /** Extra plain-text lines under the news (a simulation's score, a dry run of the table step). */
  appendix?: string[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const INK = "#0c1929";
const MUTED = "#6b7b93";
const BORDER = "#c8d4e8";
const FONT = "Arial, Helvetica, sans-serif";

export function renderNewsEmail(n: NewsEmail): { subject: string; text: string; html: string } {
  const e = C.news;
  const fresh = n.rows.filter((r) => r.verdict === "new" && r.quoteOk);
  const held = n.rows.filter((r) => r.verdict === "new" && !r.quoteOk);
  const covered = n.rows.filter((r) => r.verdict === "covered");
  const other = n.rows.filter((r) => r.verdict === "other");
  const subject = `${n.simulated ? e.simulation : ""}${fresh.length ? e.subjectNew(n.competitorName, fresh.length) : e.subjectNone(n.competitorName)}`;
  const heading = e.heading(n.competitorName, n.orgName);
  const counts = e.counts(fresh.length, covered.length, other.length, n.pages);
  const sizeLabel = (r: NewsEmailRow) => (r.size === "feature" && r.parentName ? `${e.sizes.feature} · ${e.featureOf(r.parentName)}` : e.sizes[r.size ?? "capability"] ?? "");

  // ——— plain text ———
  const t: string[] = [heading, counts, ""];
  const newText = (r: NewsEmailRow, i: number) => {
    t.push(`${i + 1}. ${r.name} (${sizeLabel(r)})`, `   ${r.what}`);
    if (r.problem) t.push(`   ${e.problem}: ${r.problem}`);
    if (r.audience) t.push(`   ${e.audience}: ${r.audience}`);
    if (r.workflows) t.push(`   ${e.workflows}: ${r.workflows}`);
    if (r.quote) t.push(`   “${r.quote}”`);
    t.push(`   ${r.sourceUrl}`, "");
  };
  if (fresh.length) { t.push(`${e.newTitle.toUpperCase()} (${fresh.length}) — ${e.newHint}`, ""); fresh.forEach(newText); }
  if (held.length) { t.push(`${e.unproven} (${held.length})`, ""); held.forEach(newText); }
  if (covered.length) {
    t.push(`${e.coveredTitle.toUpperCase()} (${covered.length}) — ${e.coveredHint}`, "");
    for (const r of covered) t.push(`- ${r.name}: ${e.coveredBy(r.coveredName ?? "")}`, `  ${e.why}: ${r.reason}`, `  ${r.sourceUrl}`, "");
  }
  if (other.length) {
    t.push(`${e.otherTitle.toUpperCase()} (${other.length}) — ${e.otherHint}`, "");
    for (const r of other) t.push(`- ${e.otherTypes[r.otherType ?? "other"] ?? r.otherType}: ${r.name} — ${r.what}`, `  ${r.sourceUrl}`, "");
  }
  if (n.failedPages) t.push(e.failedPages(n.failedPages), "");
  if (n.appendix?.length) t.push(...n.appendix, "");
  t.push(`${e.openFeed}: ${n.appUrl}/competitors`, "", e.footer);

  // ——— html ———
  const section = (title: string, hint: string, count: number, body: string) =>
    `<tr><td style="padding:18px 20px 0;"><div style="font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:.05em;text-transform:uppercase;color:${INK};">${esc(title)} · ${count}</div><div style="font-family:${FONT};font-size:12px;color:${MUTED};margin:2px 0 10px;">${esc(hint)}</div>${body}</td></tr>`;
  const line = (label: string, value: string) => `<div style="font-family:${FONT};font-size:13px;line-height:1.5;color:${INK};margin-top:4px;"><span style="color:${MUTED};">${esc(label)}:</span> ${esc(value)}</div>`;
  const src = (r: NewsEmailRow) => `<div style="font-family:${FONT};font-size:12px;margin-top:6px;"><a href="${esc(r.sourceUrl)}" style="color:#2457f5;text-decoration:none;">${esc(r.sourceTitle || e.source)}</a></div>`;
  const newCard = (r: NewsEmailRow) =>
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 10px;"><tr><td style="border:1px solid ${BORDER};border-radius:10px;padding:12px 14px;">
      <div style="font-family:${FONT};font-size:11px;font-weight:bold;color:#0f7a47;">${esc(sizeLabel(r))}</div>
      <div style="font-family:${FONT};font-size:16px;font-weight:bold;color:${INK};margin-top:2px;">${esc(r.name)}</div>
      <div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${INK};margin-top:4px;">${esc(r.what)}</div>
      ${r.problem ? line(e.problem, r.problem) : ""}${r.audience ? line(e.audience, r.audience) : ""}${r.workflows ? line(e.workflows, r.workflows) : ""}
      ${r.quote ? `<div style="font-family:${FONT};font-size:13px;line-height:1.5;font-style:italic;color:#1f2f47;border-left:3px solid ${BORDER};padding-left:10px;margin-top:8px;">“${esc(r.quote)}”</div>` : ""}
      ${src(r)}
    </td></tr></table>`;
  const smallRow = (title: string, sub: string, r: NewsEmailRow) =>
    `<div style="border-bottom:1px solid rgba(200,212,232,.6);padding:8px 0;"><div style="font-family:${FONT};font-size:14px;color:${INK};"><b>${esc(title)}</b></div><div style="font-family:${FONT};font-size:13px;line-height:1.5;color:#1f2f47;margin-top:2px;">${esc(sub)}</div>${src(r)}</div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f8;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef1f8;"><tr><td align="center" style="padding:8px 0 24px;">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;">
  <tr><td style="background:#0b1430;padding:16px 20px;border-radius:12px 12px 0 0;">
    <div style="font-family:${FONT};font-size:18px;font-weight:bold;color:#ffffff;">${esc((n.simulated ? e.simulation : "") + heading)}</div>
    <div style="font-family:${FONT};font-size:12px;color:#aab4c8;margin-top:6px;">${esc(counts)}</div>
  </td></tr>
  ${fresh.length ? section(e.newTitle, e.newHint, fresh.length, fresh.map(newCard).join("")) : ""}
  ${held.length ? section(e.unproven, "", held.length, held.map(newCard).join("")) : ""}
  ${covered.length ? section(e.coveredTitle, e.coveredHint, covered.length, covered.map((r) => smallRow(r.name, `${e.coveredBy(r.coveredName ?? "")}. ${r.reason}`, r)).join("")) : ""}
  ${other.length ? section(e.otherTitle, e.otherHint, other.length, other.map((r) => smallRow(`${e.otherTypes[r.otherType ?? "other"] ?? r.otherType}: ${r.name}`, r.what, r)).join("")) : ""}
  ${n.failedPages ? `<tr><td style="padding:14px 20px 0;font-family:${FONT};font-size:13px;color:#c23767;">${esc(e.failedPages(n.failedPages))}</td></tr>` : ""}
  ${n.appendix?.length ? `<tr><td style="padding:18px 20px 0;"><pre style="font-family:Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:${INK};white-space:pre-wrap;margin:0;background:#f5f7fb;border:1px solid ${BORDER};border-radius:8px;padding:10px 12px;">${esc(n.appendix.join("\n"))}</pre></td></tr>` : ""}
  <tr><td style="padding:18px 20px 16px;"><a href="${esc(n.appUrl)}/competitors" style="display:inline-block;background:#2457f5;border-radius:8px;padding:10px 16px;font-family:${FONT};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(e.openFeed)}</a>
    <div style="font-family:${FONT};font-size:12px;color:${MUTED};margin-top:12px;">${esc(e.footer)}</div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text: t.join("\n"), html };
}

/** Send the batch's one email and mark its rows notified. Returns whether it was handed to the mail server. */
export async function notifyNewsBatch(batchId: string, extra: { pages: number; failedPages: number; appendix?: string[] }): Promise<{ sent: boolean; to: string; subject: string }> {
  const rows = await db.competitorNews.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });
  const to = newsRecipient();
  if (rows.length === 0 && !extra.failedPages) return { sent: false, to, subject: "" };
  const first = rows[0];
  const competitor = first ? await db.competitor.findUnique({ where: { id: first.competitorId }, select: { name: true, workspaceId: true } }) : null;
  const workspace = competitor ? await db.workspace.findUnique({ where: { id: competitor.workspaceId }, select: { organization: { select: { name: true } } } }) : null;
  const mail = renderNewsEmail({
    orgName: workspace?.organization.name ?? "",
    competitorName: competitor?.name ?? "",
    simulated: rows.some((r) => r.simulated),
    pages: extra.pages,
    failedPages: extra.failedPages,
    rows,
    appUrl: (process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
    appendix: extra.appendix,
  });
  const { delivered } = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html });
  if (delivered) await db.competitorNews.updateMany({ where: { batchId }, data: { notifiedAt: new Date() } });
  if (competitor) {
    await recordCompetitorEvent(competitor.workspaceId, null, "cmp_news_notified", {
      batchId,
      delivered,
      new: rows.filter((r) => r.verdict === "new").length,
      covered: rows.filter((r) => r.verdict === "covered").length,
      other: rows.filter((r) => r.verdict === "other").length,
    });
  }
  return { sent: delivered, to, subject: mail.subject };
}
