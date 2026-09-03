export type BrandedEmail = {
  /** Hidden preview line shown by inbox clients next to the subject. */
  preheader?: string;
  heading: string;
  /** Body paragraphs, plain text (escaped). */
  paragraphs: string[];
  cta?: { label: string; url: string };
  /** Small print under the button, plain text (escaped). */
  note?: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FONT =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const DARK = "#050A15";
const ACCENT = "#7aa7ff";

/**
 * Table-based, inline-styled HTML (what mail clients actually render) plus a
 * plain-text twin. Dark brand header with an HTML wordmark (no images — no
 * attachments, nothing for the client to block), light body card, one
 * button. The raw link is repeated under the button for clients that strip
 * buttons.
 */
export function renderBrandedEmail(input: BrandedEmail): {
  html: string;
  text: string;
} {
  const paragraphsHtml = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:#1f2433;">${escapeHtml(p)}</p>`
    )
    .join("");

  const ctaHtml = input.cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 8px;">
        <tr>
          <td style="border-radius:8px;background:${DARK};">
            <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:${ACCENT};text-decoration:none;border-radius:8px;">${escapeHtml(input.cta.label)}</a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-family:${FONT};font-size:12px;line-height:18px;color:#6b7280;">If the button doesn't work, copy this link into your browser:<br><a href="${escapeHtml(input.cta.url)}" style="color:#2f5bd6;word-break:break-all;">${escapeHtml(input.cta.url)}</a></p>`
    : "";

  const noteHtml = input.note
    ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:#6b7280;">${escapeHtml(input.note)}</p>`
    : "";

  const preheaderHtml = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>`
    : "";

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f7;">
${preheaderHtml}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eef1f7;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;">
        <tr>
          <td align="center" style="background:${DARK};border-radius:16px 16px 0 0;padding:28px 24px 22px;">
            <div style="font-family:${FONT};font-size:28px;line-height:32px;font-weight:700;letter-spacing:2px;color:${ACCENT};">PM-OS</div>
            <div style="font-family:${FONT};font-size:11px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;color:#aaa3c4;margin-top:4px;">Product Management Operating System</div>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px 32px 28px;">
            <h1 style="margin:0 0 20px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;color:${DARK};">${escapeHtml(input.heading)}</h1>
            ${paragraphsHtml}
            ${ctaHtml}
            ${noteHtml}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#8a92a6;">
            PM-OS · Product Management Operating System
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text =
    `${input.heading}\n\n` +
    input.paragraphs.join("\n\n") +
    (input.cta ? `\n\n${input.cta.label}: ${input.cta.url}` : "") +
    (input.note ? `\n\n${input.note}` : "") +
    `\n\n— PM-OS`;

  return { html, text };
}
