import { createHash } from "node:crypto";

/**
 * HTML → the text PMOS AI reads, plus link and title extraction. Deliberately
 * dependency-free: marketing pages are simple and this runs inside the
 * scanner job as well as the app.
 */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * Strip what is not readable text (scripts, styles, drawings, frames, form controls) and flatten to text with line
 * breaks at block ends. <header>, <footer> and <nav> are KEPT (Daniel 2026-11-12): dropping them was a guess about how
 * a site is built — Bagel AI puts a page's whole hero (headline, intro, sample report) inside a <header>, and its menu
 * in neither tag, so the rule lost the content and kept the menu. Everything a person reads on the page is stored.
 * A form's controls go (select options, buttons, inputs), its text stays: marketing sites put real copy inside
 * forms — ZeroFox's pricing page describes each use case in a checkbox label (round-2 check, 2026-11-10).
 * Scripts go, except the page's hover hints (hintsOf), which are appended after the text.
 */
const HINT_KEY = "(?:tool-?tip|tooltip_?text|hint|hint_?text|help_?text|helper_?text|info_?text)";
const HINT_ATTR = /<(?!a\b|img\b|iframe\b|link\b|meta\b|input\b|svg\b|path\b)[a-z0-9]+\b[^>]*?\s(?:data-tooltip|data-tip|data-tippy-content|data-bs-title|data-original-title|aria-description|title)\s*=\s*(?:"([^"]{15,600})"|'([^']{15,600})')/gi;

/** A JSON string value as written in a script, plain ("…") or escaped inside another string (\"…\"), back to text. */
function unescapeJson(v: string): string {
  return v
    .replace(/\\+u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\+[nrt]/g, " ")
    .replace(/\\+(["'\/])/g, "$1")
    .replace(/\\{2,}/g, "\\");
}

/**
 * The hints of a page (Daniel 2026-11-12): the text a person sees when hovering an "i" icon. A pricing page explains
 * each feature row this way (Productboard: 93 hints, none in the visible HTML), so they matter for comparing
 * capabilities. Only hints are read — never scripts or page data in general: a value under a hint-named key
 * ("tooltip", "hint", "helpText"…) in the page's embedded data, with the name of the row it belongs to when the same
 * object carries one, and hint attributes on elements (data-tooltip, title on non-link elements…). One line each.
 */
export function hintsOf(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string, hint: string) => {
    const h = decodeEntities(hint.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    // A hint is a sentence: an id, a class name or a one-word label is not one.
    if (h.length < 15 || h.length > 600 || h.split(" ").length < 3 || seen.has(h)) return;
    seen.add(h);
    const n = decodeEntities(name).replace(/\s+/g, " ").trim();
    out.push(n && n.length <= 120 && n !== h ? `${n}: ${h}` : h);
  };
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = script[1];
    if (!/tool-?tip|hint|help_?text|helper_?text|info_?text/i.test(body)) continue;
    // "key":"value" in plain JSON, or \"key\":\"value\" inside a string (Next.js page data).
    const pair = (key: string) => new RegExp(`(\\\\*)"${key}\\1"\\s*:\\s*\\1"((?:(?!\\1").)*?)\\1"`, "gis");
    for (const m of body.matchAll(pair(HINT_KEY))) {
      // The row's own name: the nearest name/title/label before the hint, inside the same object.
      const before = body.slice(Math.max(0, (m.index ?? 0) - 1500), m.index ?? 0);
      // Back to the brace that opens the hint's own object, stepping over the nested ones (plan values and the like).
      let open = -1;
      for (let i = before.length - 1, depth = 0; i >= 0; i--) {
        if (before[i] === "}") depth++;
        else if (before[i] === "{") {
          if (depth === 0) {
            open = i;
            break;
          }
          depth--;
        }
      }
      const name = open >= 0 ? pair("(?:name|title|label|feature|heading)").exec(before.slice(open)) : null;
      add(name ? unescapeJson(name[2]) : "", unescapeJson(m[2]));
    }
  }
  const visible = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  for (const m of visible.matchAll(HINT_ATTR)) add("", m[1] ?? m[2] ?? "");
  return out.slice(0, 500);
}

export function htmlToText(html: string): string {
  const hints = hintsOf(html);
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|select|textarea|button|datalist)\b[\s\S]*?<\/\1>/gi, " ");
  // Block boundaries become newlines so headings and list items stay separable.
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|td|th|dt|dd|blockquote|figcaption|main|aside|header|footer|nav)>|<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const text = s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  // Hints follow the page text under one heading, one per line, named by the row they explain.
  return hints.length ? `${text}\nHints shown on hover:\n${hints.join("\n")}` : text;
}

export function titleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

/**
 * A competitor's display name from its home page: og:site_name, else the
 * first segment of <title> ("Flashpoint | Threat Intelligence…" → "Flashpoint"),
 * else the host without its suffix ("recordedfuture.com" → "Recordedfuture").
 */
export function siteNameOf(html: string, host: string): string {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  const fromOg = og ? decodeEntities(og[1]).trim() : "";
  if (fromOg && fromOg.length <= 60) return fromOg;
  const title = titleOf(html);
  if (title) {
    const parts = title.split(/\s+[|\-–—:·»]\s+/).map((p) => p.trim()).filter(Boolean);
    const short = parts.filter((p) => p.length <= 40).sort((a, b) => a.length - b.length)[0] ?? parts[0];
    if (short && short.length <= 60) return short.replace(/^(home|welcome to)\s+/i, "");
  }
  const label = host.split(".")[0] || host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The competitor's logo as the site declares it: the largest apple-touch-icon,
 * else the largest sizeable <link rel="icon">, else Google's favicon service
 * for the host. Absolute URL — nothing is copied or stored on our side.
 */
export function siteLogoOf(html: string, origin: string): string {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] ?? "";
  const sized = (tag: string) => Number((attr(tag, "sizes").match(/(\d+)x/)?.[1]) ?? 0);
  const pick = (test: (rel: string) => boolean) =>
    links
      .filter((t) => test(attr(t, "rel").toLowerCase()) && attr(t, "href"))
      .sort((a, b) => sized(b) - sized(a))[0];
  const touch = pick((rel) => rel.includes("apple-touch-icon"));
  const icon = pick((rel) => (rel.split(/\s+/).includes("icon") || rel === "shortcut icon") && !/\.ico(\?|$)/i.test(attr(tag_of(rel), "href")));
  // A 16-px .ico looks poor at 48 px; when the site declares no sizeable icon,
  // Google's favicon service returns the best icon it knows at 128 px.
  const host = new URL(origin).hostname.replace(/^www\./, "");
  const fallback = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  const chosen = touch ?? icon;
  if (!chosen) return fallback;
  if (chosen === icon && sized(icon) > 0 && sized(icon) < 64) return fallback;
  try {
    const u = new URL(decodeEntities(attr(chosen, "href")), origin);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : fallback;
  } catch {
    return fallback;
  }
  function tag_of(rel: string): string {
    return links.find((t) => attr(t, "rel").toLowerCase() === rel) ?? "";
  }
}

export function metaDescription(html: string): string {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  return m ? decodeEntities(m[1]).trim().slice(0, 500) : "";
}

/** Every href on the page, resolved against `base`; invalid ones dropped. */
export function extractLinks(html: string, base: string): URL[] {
  const out: URL[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi)) {
    try {
      out.push(new URL(m[1].trim(), base));
    } catch {
      // not a URL
    }
  }
  return out;
}

/**
 * Text as compared between scans (Website Scanning PRD: "text is normalized
 * before hashing, so dates and tracking strings do not count as change").
 * Strips what changes on every load without the page changing: dates and
 * times in common shapes, "x minutes ago", tracking query strings, long hex
 * or numeric ids (visitor ids, build hashes), and whitespace noise. The stored
 * text is NOT normalized — only the fingerprint is.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\b(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|_gl|ref|sessionid|sid|visitor_?id)=[^\s&"']+/gi, " ")
    .replace(/\b(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/g, " ")
    .replace(/\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/g, " ")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, " ")
    .replace(/(?:©|\(c\)|copyright)\s*\d{4}(?:\s*[-–]\s*\d{4})?/gi, " ")
    .replace(/\b[0-9a-f]{16,}\b/gi, " ")
    .replace(/\b\d{8,}\b/g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/** Stable fingerprint of the normalized text (not the HTML — markup churn is not a change). */
export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex").slice(0, 32);
}

/** Cloudflare / Akamai / Imperva interstitials and the like. */
export function looksLikeBotWall(status: number, html: string): boolean {
  if (status !== 403 && status !== 503 && status !== 429 && status !== 200) return false;
  const head = html.slice(0, 6000);
  return /just a moment|verify you are human|checking your browser|cf-chl|cf_chl|attention required|access denied|request unsuccessful\. incapsula|_incapsula_|akamai.*bot|px-captcha|captcha-delivery|hcaptcha|recaptcha\/api\.js/i.test(head);
}

/**
 * Pages that render nothing without JavaScript — a browser is needed. An
 * empty app root, or a big document with almost no text. A small page with
 * little text is just a small page.
 */
export function looksEmptyWithoutJs(text: string, html: string): boolean {
  if (text.length >= 400) return false;
  if (/<div\s+id=["'](root|app|__next|___gatsby)["']\s*>\s*<\/div>|window\.__NUXT__|__NEXT_DATA__/i.test(html)) return true;
  return text.length < 120 && html.length > 3000;
}

/** The page's own preview image (og:image, then twitter:image), absolute; "" when the page states none. */
export function ogImageOf(html: string, baseUrl: string): string {
  const head = html.slice(0, 200_000);
  const pick = (re: RegExp) => {
    const m = head.match(re);
    return m ? decodeEntities(m[1] || m[2] || "").trim() : "";
  };
  const raw =
    pick(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i);
  if (!raw) return "";
  try {
    const u = new URL(raw, baseUrl);
    return /^https?:$/.test(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}
