import { db } from "../../db";
import { sendEmail } from "../../mailer";
import { recordCompetitorEvent } from "../analytics";
import { COMPETITORS_COPY as C } from "../copy";
import { abilityPhrase } from "./intake";

/**
 * THE NEWS NOTIFICATION — one email per intake batch, sent as soon as the batch is read (News Feed & Notifications
 * PRD: "immediately"). For now it goes to PM-OS only (Daniel 2026-11-21: he reviews and passes on by hand); nothing
 * is sent to a customer's users.
 *
 * The email lists EVERY item the intake stored, each under its result (Daniel 2026-11-22: "notify me for everything
 * new and the result: exist, not related, new"), in three groups, in this order:
 *   New abilities  — one section per ability: its name, one phrase with no label (the problem it solves and how it
 *                    solves it), the evidence and the link;
 *   Already exists — its name, the item of the company's list that holds it, and the link;
 *   Not related    — its label, what kind of thing it is in plain words, and the link. A new ability whose evidence
 *                    is not on its page is listed here too, with that reason: it is not reported as new.
 * A group with nothing in it is left out. No counts line, no "shown in the news feed" line, no sizes (capability or
 * feature belongs to the table). A batch that stored nothing sends no email.
 */

/** The one recipient, for now. An environment setting, so a test or another operator can change it without code. */
export function newsRecipient(): string {
  return process.env.COMPETITORS_NEWS_NOTIFY_TO?.trim() || "daniel@pm-os.io";
}

export interface NewsEmailEvidence {
  quote: string;
  url: string;
  title: string;
}

export interface NewsEmailRow {
  /** "new" | "covered" | "other" */
  verdict: string;
  name: string;
  /** A new ability: how it works. */
  what: string;
  /** A new ability: the problem it solves ("Without it, …"). */
  problem: string | null;
  quote: string | null;
  quoteOk: boolean;
  /** Every proven quote, the strongest first (the stored evidence column); empty = only `quote` + `sourceUrl`. */
  evidence?: unknown;
  /** verdict "covered": the name of the list item that holds it. */
  coveredName?: string | null;
  /** verdict "other": what kind of thing it is (hr, finance, …, integration, not_understood). */
  otherType?: string | null;
  sourceUrl: string;
  sourceTitle: string;
}

export interface NewsEmail {
  competitorName: string;
  simulated: boolean;
  rows: NewsEmailRow[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const INK = "#0c1929";
const MUTED = "#6b7b93";
const BORDER = "#c8d4e8";
const FONT = "Arial, Helvetica, sans-serif";
/** An ability shows at most this many pieces of evidence. */
const EMAIL_MAX_EVIDENCE = 3;

/**
 * The three groups of an email, each in the order the rows came:
 * new = a new ability whose quote is on its page; exists = already on the company's list;
 * notRelated = not an ability, and a "new" ability with no evidence on its page.
 */
export function emailGroups<T extends { verdict: string; quoteOk: boolean }>(rows: T[]): { fresh: T[]; exists: T[]; notRelated: T[] } {
  const fresh = rows.filter((r) => r.verdict === "new" && r.quoteOk);
  const exists = rows.filter((r) => r.verdict === "covered");
  const notRelated = rows.filter((r) => r.verdict !== "covered" && !(r.verdict === "new" && r.quoteOk));
  return { fresh, exists, notRelated };
}

function evidenceOf(r: NewsEmailRow): NewsEmailEvidence[] {
  const stored = Array.isArray(r.evidence) ? (r.evidence as Array<Record<string, unknown>>) : [];
  const list = stored
    .map((e) => ({ quote: typeof e.quote === "string" ? e.quote : "", url: typeof e.url === "string" ? e.url : "", title: typeof e.title === "string" ? e.title : "" }))
    .filter((e) => e.quote && e.url);
  if (list.length) return list.slice(0, EMAIL_MAX_EVIDENCE);
  return r.quote ? [{ quote: r.quote, url: r.sourceUrl, title: r.sourceTitle }] : [];
}

/** What a "not related" item is, in plain words. */
function notRelatedType(r: NewsEmailRow): string {
  const e = C.news;
  if (r.verdict === "new") return e.unproven;
  return e.notRelatedTypes[r.otherType ?? "other"] ?? e.notRelatedTypes.other;
}

export function renderNewsEmail(n: NewsEmail): { subject: string; text: string; html: string } {
  const e = C.news;
  const { fresh, exists, notRelated } = emailGroups(n.rows);
  const title = e.title(n.competitorName);
  const subject = `${n.simulated ? e.simulation : ""}${title}`;
  const existsLine = (r: NewsEmailRow) => (r.coveredName ? e.existsAs(r.name, r.coveredName) : r.name);
  const notRelatedLine = (r: NewsEmailRow) => `${r.name} — ${notRelatedType(r)}`;

  // ——— plain text ———
  const t: string[] = [title, ""];
  if (fresh.length) {
    t.push(e.groups.fresh.toUpperCase(), "");
    for (const r of fresh) {
      t.push(r.name, abilityPhrase(r), "", e.evidence);
      for (const ev of evidenceOf(r)) t.push(`“${ev.quote}”`, ev.url);
      t.push("", "");
    }
  }
  if (exists.length) {
    t.push(e.groups.exists.toUpperCase(), "");
    for (const r of exists) t.push(existsLine(r), r.sourceUrl, "");
    t.push("");
  }
  if (notRelated.length) {
    t.push(e.groups.notRelated.toUpperCase(), "");
    for (const r of notRelated) t.push(notRelatedLine(r), r.sourceUrl, "");
    t.push("");
  }

  // ——— html ———
  const heading = (text: string) =>
    `<tr><td style="padding:20px 20px 0;"><div style="font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:.05em;text-transform:uppercase;color:${INK};">${esc(text)}</div></td></tr>`;
  const card = (r: NewsEmailRow) =>
    `<tr><td style="padding:12px 20px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border:1px solid ${BORDER};border-radius:10px;padding:14px 16px;">
      <div style="font-family:${FONT};font-size:16px;font-weight:bold;color:${INK};">${esc(r.name)}</div>
      <div style="font-family:${FONT};font-size:14px;line-height:1.55;color:${INK};margin-top:6px;">${esc(abilityPhrase(r))}</div>
      <div style="font-family:${FONT};font-size:11px;font-weight:bold;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};margin-top:12px;">${esc(e.evidence)}</div>
      ${evidenceOf(r).map((ev) => `<div style="font-family:${FONT};font-size:13px;line-height:1.5;font-style:italic;color:#1f2f47;border-left:3px solid ${BORDER};padding-left:10px;margin-top:6px;">“${esc(ev.quote)}”</div><div style="font-family:${FONT};font-size:12px;margin-top:4px;"><a href="${esc(ev.url)}" style="color:#2457f5;text-decoration:none;">${esc(ev.title || ev.url)}</a></div>`).join("")}
    </td></tr></table></td></tr>`;
  const line = (text: string, r: NewsEmailRow) =>
    `<tr><td style="padding:8px 20px 0;"><div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${INK};">${esc(text)}</div><div style="font-family:${FONT};font-size:12px;margin-top:2px;"><a href="${esc(r.sourceUrl)}" style="color:#2457f5;text-decoration:none;">${esc(r.sourceTitle || r.sourceUrl)}</a></div></td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f8;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef1f8;"><tr><td align="center" style="padding:8px 0 24px;">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;">
  <tr><td style="background:#0b1430;padding:16px 20px;border-radius:12px 12px 0 0;"><div style="font-family:${FONT};font-size:18px;font-weight:bold;color:#ffffff;">${esc(subject)}</div></td></tr>
  ${fresh.length ? heading(e.groups.fresh) + fresh.map(card).join("") : ""}
  ${exists.length ? heading(e.groups.exists) + exists.map((r) => line(existsLine(r), r)).join("") : ""}
  ${notRelated.length ? heading(e.groups.notRelated) + notRelated.map((r) => line(notRelatedLine(r), r)).join("") : ""}
  <tr><td style="padding:0 0 16px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text: t.join("\n").trimEnd() + "\n", html };
}

/**
 * Send the batch's one email — every item the batch stored, under its result — and mark the items notified.
 * A batch that stored nothing sends nothing. `abilities` = the new abilities in the email; `items` = everything in it.
 */
export async function notifyNewsBatch(batchId: string): Promise<{ sent: boolean; to: string; subject: string; abilities: number; items: number }> {
  const rows = await db.competitorNews.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });
  const to = newsRecipient();
  if (rows.length === 0) return { sent: false, to, subject: "", abilities: 0, items: 0 };
  const { fresh, exists, notRelated } = emailGroups(rows);
  const competitor = await db.competitor.findUnique({ where: { id: rows[0].competitorId }, select: { name: true, workspaceId: true } });
  const mail = renderNewsEmail({ competitorName: competitor?.name ?? "", simulated: rows.some((r) => r.simulated), rows });
  const { delivered } = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html });
  if (delivered) await db.competitorNews.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { notifiedAt: new Date() } });
  if (competitor) await recordCompetitorEvent(competitor.workspaceId, null, "cmp_news_notified", { batchId, delivered, new: fresh.length, exists: exists.length, notRelated: notRelated.length });
  return { sent: delivered, to, subject: mail.subject, abilities: fresh.length, items: rows.length };
}
