import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * The fake competitor website of the Website Scanning QA rows (WS-01 … WS-27,
 * spec tab "Website Scanning", 2026-11-04). One Node server, no files, started
 * in-process by the Playwright spec (or from the CLI, scripts/fake-site.mjs):
 *
 *   12 pages: /, /product, /product/features, /pricing, /docs, /docs/start,
 *             /docs/api, /blog, /blog/1, /blog/2, /people, /about
 *   plus      /sitemap.xml and /robots.txt (not pages), /files/brochure.pdf
 *             (a real 2-page PDF, linked from home and /product only with the
 *             `linkPdf` variant), a captioned image on /about, and home links
 *             to app.<host>, another domain and linkedin.com. /login demands a
 *             login (reason "login") when the `loginPage` variant links it.
 *             `bigPage` links /big (2.6 MB of HTML), `bogusPdf` links
 *             /files/report.pdf (a .pdf that is not a PDF) — WS-28.
 *             `sitemapOnly` serves /whitepaper, listed in /sitemap.xml and
 *             linked from no page — WS-33. `variantLinks` makes home link
 *             the same pages under other spellings (trailing slash, www.
 *             host) — WS-34.
 *
 * Variants are toggled through the control endpoint (same server, never a
 * second site) and every request is logged:
 *
 *   POST /__control  { ...partial Variants }    merge variants
 *   POST /__reset                               defaults + empty request log
 *   GET  /__requests                            [{ at, method, host, path, ua, status }]
 *
 * Several sites = this fixture on several ports (startFakeSite({ port })).
 * Pages are deterministic: the same variants always give the same text, so
 * hashes are stable across scans.
 */

export interface Variants {
  /** /pricing renders its text only via JavaScript (the plain fetch sees an empty shell). */
  jsOnlyPricing: boolean;
  /** /docs never answers (socket left open until the client times out). */
  docsTimeoutAlways: boolean;
  /** /docs does not answer the first time, answers afterwards. */
  docsTimeoutOnce: boolean;
  /** /people answers 404 (or 410 when `gone` is set). */
  peopleNotFound: boolean;
  peopleGone: boolean;
  /** Every page answers 403 to a user agent that names PM-OS (the remote lane); browsers get 200. */
  forbidPmosUa: boolean;
  /** 403 on EVERY page for every client (a hard bot wall: both lanes refused). */
  forbidAll: boolean;
  /** After N successful page requests the server answers 429 with Retry-After to everything. 0 = off. */
  slowdownAfter: number;
  /** robots.txt rules. */
  robotsDisallow: string[];
  robotsCrawlDelay: number | null;
  /** /loop/N pages each link to /loop/N+1 forever (the ceiling test). */
  infiniteLinks: boolean;
  /** Text edits (WS-08). */
  pricingText: string;
  footerDate: string;
  utmInDocs: boolean;
  /** /product/new exists and is linked from /product. */
  newProductPage: boolean;
  /** /people still answers but nothing links to it and the sitemap omits it (WS-27). */
  unlinkPeople: boolean;
  /** Home links /login, which answers 401. */
  loginPage: boolean;
  /** Whole site down: every request is refused at the socket (connection reset). */
  down: boolean;
  /** Home and /product link /files/brochure.pdf (WS-21). Off by default so the common site is exactly 12 pages. */
  linkPdf: boolean;
  /** Every page answers after this many ms (WS-26: scans slow enough to watch the concurrency). 0 = at once. */
  delayMs: number;
  /**
   * Home links /big, a 2.6 MB HTML page (WS-28). Its visible text is three marker paragraphs separated by whitespace
   * padding: BIG_PAGE_MARKERS.start at the top, .beforeCut at ~1.9 MB, .afterCut at ~2.3 MB — so a cut at 2 MB keeps
   * the first two and drops the third, and the text stays far below the page store's character cap.
   */
  bigPage: boolean;
  /** Home links /files/report.pdf: served as application/pdf, but the bytes are plain text, not a PDF (WS-28). */
  bogusPdf: boolean;
  /** /whitepaper answers and is listed in /sitemap.xml, but no page links to it (WS-33: a sitemap entry counts as "something points at the page"). */
  sitemapOnly: boolean;
  /**
   * Home links the same pages under other spellings (WS-34: one page, one row): /pricing/ and /product/features/ with a
   * trailing slash, and /about under the www. copy of the host (http://www.<host>:<port>/about — the fixture answers any Host
   * header, and *.localtest.me resolves to 127.0.0.1).
   */
  variantLinks: boolean;
}

export const DEFAULT_VARIANTS: Variants = {
  jsOnlyPricing: false,
  docsTimeoutAlways: false,
  docsTimeoutOnce: false,
  peopleNotFound: false,
  peopleGone: false,
  forbidPmosUa: false,
  forbidAll: false,
  slowdownAfter: 0,
  robotsDisallow: [],
  robotsCrawlDelay: null,
  infiniteLinks: false,
  pricingText: "Starter $49 per month. Team $199 per month. Enterprise: talk to us.",
  footerDate: "Updated 2026-11-01",
  utmInDocs: false,
  newProductPage: false,
  unlinkPeople: false,
  loginPage: false,
  down: false,
  linkPdf: false,
  delayMs: 0,
  bigPage: false,
  bogusPdf: false,
  sitemapOnly: false,
  variantLinks: false,
};

/** The marker paragraphs of the `bigPage` variant (byte offsets in the served HTML, ASCII only). */
export const BIG_PAGE_MARKERS = {
  start: "Big page start marker: the first paragraph of the long page.",
  beforeCut: "Big page marker before the cut: this paragraph sits at about 1.9 MB.",
  afterCut: "Big page marker after the cut: this paragraph sits at about 2.3 MB.",
} as const;
const MB = 1024 * 1024;
/** Size of the `bigPage` HTML in bytes (2.6 MB). */
export const BIG_PAGE_BYTES = Math.round(2.6 * MB);

/** The 2.6 MB page: whitespace padding (no text, no tags) between the marker paragraphs, so where the cut lands is visible in the stored text. */
function bigPageHtml(nav: string, footerDate: string): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Big page · Acme Fake</title></head><body>
<nav>${nav}</nav>
<main>
<h1>Big page</h1>
<p>${BIG_PAGE_MARKERS.start}</p>
`;
  const before = `<p>${BIG_PAGE_MARKERS.beforeCut}</p>\n`;
  const after = `<p>${BIG_PAGE_MARKERS.afterCut}</p>\n`;
  const tail = `<p>Acme Fake is a fictional vendor that exists only for the PM-OS test suite; nothing on this site describes a real company, product or person.</p>
</main>
<footer><p>Acme Fake Inc. ${footerDate}</p></footer>
</body></html>`;
  const pad = (n: number) => " ".repeat(Math.max(0, n));
  let out = head;
  out += pad(Math.round(1.9 * MB) - out.length) + before;
  out += pad(Math.round(2.3 * MB) - out.length) + after;
  out += pad(BIG_PAGE_BYTES - out.length - tail.length) + tail;
  return out;
}

/** Not a PDF: what a misconfigured server hands out under a .pdf name. */
const BOGUS_PDF = Buffer.from("This file is named report.pdf but it is plain text, not a PDF document.\n", "utf8");

export interface RequestLogEntry {
  at: number;
  method: string;
  /** The Host header as the client sent it (app.localhost:port vs localhost:port). */
  host: string;
  path: string;
  ua: string;
  status: number;
}

export interface FakeSite {
  url: string;
  host: string;
  port: number;
  control(patch: Partial<Variants>): Promise<Variants>;
  reset(): Promise<void>;
  requests(): Promise<RequestLogEntry[]>;
  stop(): Promise<void>;
}

/** The 12 page paths (the suite's "12 pages"); /sitemap.xml, /robots.txt and /files/brochure.pdf are extra. */
export const PAGE_PATHS = ["/", "/product", "/product/features", "/pricing", "/docs", "/docs/start", "/docs/api", "/blog", "/blog/1", "/blog/2", "/people", "/about"] as const;

function page(title: string, body: string, nav: string, footerDate: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · Acme Fake</title></head><body>
<nav>${nav}</nav>
<main>
<h1>${title}</h1>
${body}
<p>Acme Fake is a fictional vendor that exists only for the PM-OS test suite; nothing on this site describes a real company, product or person.</p>
</main>
<footer><p>Acme Fake Inc. ${footerDate}</p></footer>
</body></html>`;
}

/** A minimal, valid 2-page PDF with extractable text. */
function brochurePdf(): Buffer {
  const objects: string[] = [];
  const add = (s: string) => objects.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>");
  const stream1 = "BT /F1 18 Tf 50 750 Td (Acme Fake brochure) Tj 0 -30 Td /F1 12 Tf (Threat intelligence for every analyst. Starter and Team plans.) Tj ET";
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>");
  add(`<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream`);
  const stream2 = "BT /F1 12 Tf 50 750 Td (Datasheet page two: SOC 2 Type II, ISO 27001, 40 integrations.) Tj ET";
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>");
  add(`<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function startFakeSite(opts: { port?: number; host?: string } = {}): Promise<FakeSite> {
  const hostName = opts.host ?? "localhost";
  let variants: Variants = { ...DEFAULT_VARIANTS };
  let requests: RequestLogEntry[] = [];
  let okPages = 0;
  let docsTimedOutOnce = false;
  const pdf = brochurePdf();

  const origin = (port: number) => `http://${hostName}:${port}`;

  const handler = (port: number) => (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", origin(port));
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ua = req.headers["user-agent"] ?? "";
    const host = req.headers.host ?? "";
    const send = (status: number, body: string | Buffer, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => {
      requests.push({ at: Date.now(), method: req.method ?? "GET", host, path, ua, status });
      const write = () => {
        res.writeHead(status, { "content-type": type, ...headers });
        res.end(body);
      };
      if (variants.delayMs > 0) setTimeout(write, variants.delayMs);
      else write();
    };

    // ——— control plane (never logged as site traffic) ———
    if (path === "/__control" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        try {
          const patch = JSON.parse(raw || "{}") as Partial<Variants>;
          variants = { ...variants, ...patch };
          if (patch.slowdownAfter !== undefined) okPages = 0;
          if (patch.docsTimeoutOnce !== undefined) docsTimedOutOnce = false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(variants));
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
      return;
    }
    if (path === "/__reset" && req.method === "POST") {
      variants = { ...DEFAULT_VARIANTS };
      requests = [];
      okPages = 0;
      docsTimedOutOnce = false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (path === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(requests));
      return;
    }

    // ——— site-wide conditions ———
    if (variants.down) {
      requests.push({ at: Date.now(), method: req.method ?? "GET", host, path, ua, status: 0 });
      req.socket.destroy();
      return;
    }
    if (variants.forbidAll || (variants.forbidPmosUa && /pm-os/i.test(ua))) {
      return send(403, "<html><body><h1>Access denied</h1></body></html>");
    }
    if (variants.slowdownAfter > 0 && okPages >= variants.slowdownAfter && path !== "/robots.txt") {
      return send(429, "Too Many Requests", "text/plain", { "retry-after": "120" });
    }

    const base = origin(port);
    const navLinks = [
      ["/", "Home"],
      ["/product", "Product"],
      ["/pricing", "Pricing"],
      ["/docs", "Docs"],
      ["/blog", "Blog"],
      ...(variants.unlinkPeople ? [] : [["/people", "People"]]),
      ["/about", "About"],
      ...(variants.loginPage ? [["/login", "Log in"]] : []),
    ];
    const nav = navLinks.map(([p, l]) => `<a href="${base}${p}">${l}</a>`).join(" | ");
    const footerDate = variants.footerDate;

    switch (path) {
      case "/robots.txt": {
        const lines = ["User-agent: *", ...variants.robotsDisallow.map((d) => `Disallow: ${d}`), ...(variants.robotsCrawlDelay ? [`Crawl-delay: ${variants.robotsCrawlDelay}`] : []), `Sitemap: ${base}/sitemap.xml`];
        return send(200, lines.join("\n") + "\n", "text/plain");
      }
      case "/sitemap.xml": {
        const paths = [...PAGE_PATHS.filter((p) => !(variants.unlinkPeople && p === "/people")), ...(variants.newProductPage ? ["/product/new"] : []), ...(variants.sitemapOnly ? ["/whitepaper"] : [])];
        const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${base}${p}</loc></url>`).join("")}</urlset>`;
        return send(200, xml, "application/xml");
      }
      case "/files/brochure.pdf":
        okPages++;
        return send(200, pdf, "application/pdf");
      case "/files/report.pdf":
        if (!variants.bogusPdf) break;
        okPages++;
        return send(200, BOGUS_PDF, "application/pdf");
      case "/whitepaper":
        if (!variants.sitemapOnly) break;
        okPages++;
        return send(200, page("Whitepaper", "<p>The state of threat intelligence: a whitepaper only the sitemap lists. Forty pages of findings from two hundred analysts.</p>", nav, footerDate));
      case "/big":
        if (!variants.bigPage) break;
        okPages++;
        return send(200, bigPageHtml(nav, footerDate));
      case "/img/office.png":
        return send(200, PNG, "image/png");
      case "/login":
        return send(401, "<html><body><h1>Please log in</h1></body></html>");
      case "/":
        okPages++;
        return send(200, page("Acme Fake", `<p>Threat intelligence for every analyst.</p>
<p>Also see <a href="http://app.${hostName}:${port}/dashboard">the app</a>, <a href="https://other-domain.example/partner">our partner</a> and <a href="https://www.linkedin.com/company/acme-fake">LinkedIn</a>.</p>
${variants.linkPdf ? `<p>Read the <a href="${base}/files/brochure.pdf">brochure (PDF)</a>.</p>` : ""}${variants.bigPage ? `<p>The <a href="${base}/big">long page</a>.</p>` : ""}${variants.bogusPdf ? `<p>The <a href="${base}/files/report.pdf">annual report (PDF)</a>.</p>` : ""}${variants.infiniteLinks ? `<p><a href="${base}/loop/1">An endless series</a></p>` : ""}${variants.variantLinks ? `<p>Our <a href="${base}/pricing/">plans</a>, the <a href="${base}/product/features/">feature list</a> and <a href="http://www.${hostName}:${port}/about">who we are</a>.</p>` : ""}`, nav, footerDate));
      case "/product":
        okPages++;
        return send(200, page("Product", `<p>Acme Platform collects, correlates and alerts.</p><ul><li><a href="${base}/product/features">Features</a></li>${variants.newProductPage ? `<li><a href="${base}/product/new">Acme Shield (new)</a></li>` : ""}</ul>${variants.linkPdf ? `<p>Datasheet: <a href="${base}/files/brochure.pdf">brochure.pdf</a></p>` : ""}`, nav, footerDate));
      case "/product/features":
        okPages++;
        return send(200, page("Features", "<ul><li>Dark web monitoring</li><li>Brand protection</li><li>Attack surface management</li><li>Takedowns</li></ul>", nav, footerDate));
      case "/product/new":
        if (!variants.newProductPage) break;
        okPages++;
        return send(200, page("Acme Shield", "<p>Acme Shield: identity intelligence for the SOC. Launched this quarter.</p>", nav, footerDate));
      case "/pricing":
        okPages++;
        if (variants.jsOnlyPricing) {
          return send(200, `<!doctype html><html><head><title>Pricing · Acme Fake</title></head><body><div id="root"></div><script>document.getElementById('root').innerHTML='<h1>Pricing</h1><p>${variants.pricingText.replace(/'/g, "\\'")}</p>'</script></body></html>`);
        }
        return send(200, page("Pricing", `<p>${variants.pricingText}</p>`, nav, footerDate));
      case "/docs":
        if (variants.docsTimeoutAlways || (variants.docsTimeoutOnce && !docsTimedOutOnce)) {
          docsTimedOutOnce = true;
          requests.push({ at: Date.now(), method: req.method ?? "GET", host, path, ua, status: 0 });
          return; // never answer; the client times out
        }
        okPages++;
        return send(200, page("Docs", `<p>Start with <a href="${base}/docs/start${variants.utmInDocs ? "?utm_source=docs&utm_campaign=nov" : ""}">Getting started</a> and the <a href="${base}/docs/api">API reference</a>.</p>`, nav, footerDate));
      case "/docs/start":
        okPages++;
        return send(200, page("Getting started", "<p>Install the agent, connect a source, run your first search.</p>", nav, footerDate));
      case "/docs/api":
        okPages++;
        return send(200, page("API reference", "<p>REST API v2: /alerts, /indicators, /reports. Rate limit 600 requests per minute.</p>", nav, footerDate));
      case "/blog":
        okPages++;
        return send(200, page("Blog", `<ul><li><a href="${base}/blog/1">Why context beats volume</a></li><li><a href="${base}/blog/2">Acme at the summit</a></li></ul>`, nav, footerDate));
      case "/blog/1":
        okPages++;
        return send(200, page("Why context beats volume", "<p>Analysts drown in indicators. Context is what they need.</p>", nav, footerDate));
      case "/blog/2":
        okPages++;
        return send(200, page("Acme at the summit", "<p>We presented our roadmap at the summit.</p>", nav, footerDate));
      case "/people":
        if (variants.peopleNotFound) return send(variants.peopleGone ? 410 : 404, "<html><body><h1>Page not found</h1><p>This page does not exist.</p></body></html>");
        okPages++;
        return send(200, page("People", "<p>Jane Doe, CEO. John Smith, CTO. Twelve engineers in two offices.</p>", nav, footerDate));
      case "/about":
        okPages++;
        return send(200, page("About", `<p>Founded 2015. Offices in Tel Aviv and Boston.</p><figure><img src="${base}/img/office.png" alt="The Boston office"><figcaption>Our Boston office at dusk</figcaption></figure>`, nav, footerDate));
      default:
        if (variants.infiniteLinks) {
          const m = path.match(/^\/loop\/(\d+)$/);
          if (m || path === "/loop") {
            const n = m ? Number(m[1]) : 0;
            okPages++;
            return send(200, page(`Loop ${n}`, `<p>Page ${n} of an endless series.</p><a href="${base}/loop/${n + 1}">next</a>`, nav, footerDate));
          }
        }
    }
    return send(404, "<html><body><h1>Page not found</h1><p>This page does not exist.</p></body></html>");
  };

  const server: Server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, hostName, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : opts.port ?? 0);
    });
  });
  server.on("request", handler(port));
  const url = origin(port);
  return {
    url,
    host: `${hostName}:${port}`,
    port,
    async control(patch) {
      const res = await fetch(`${url}/__control`, { method: "POST", body: JSON.stringify(patch) });
      return (await res.json()) as Variants;
    },
    async reset() {
      await fetch(`${url}/__reset`, { method: "POST" });
    },
    async requests() {
      const res = await fetch(`${url}/__requests`);
      return (await res.json()) as RequestLogEntry[];
    },
    stop() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
