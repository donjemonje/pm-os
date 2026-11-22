import { describe, expect, it } from "vitest";
import { judgeChromeRead, looksLikeBotWallPage, REFUSED_IN_A_ROW, refusedStop } from "../../scripts/pmos-local-scan/chrome.mjs";
import { looksLikeBotWall } from "@/lib/competitors/html";

/**
 * A page the site refuses on the plain request is read with the Mac's Chrome (Daniel 2026-11-21: Bitsight's site and
 * help center and ZeroFox's help center answered 403 to every plain request). The rules live in
 * scripts/pmos-local-scan/chrome.mjs; the poller only calls them.
 */

const page = (title: string, body = "x".repeat(400)) => `<html><head><title>${title}</title></head><body>${body}</body></html>`;

describe("judgeChromeRead — what a read with Chrome counts as", () => {
  it("a 200 with a page is the page", () => {
    expect(judgeChromeRead({ status: 200, html: page("Help center") })).toBe("ok");
    expect(judgeChromeRead({ status: 304, html: page("Help center") })).toBe("ok");
  });
  it("keeps what the site answered: not found, login, slow down", () => {
    expect(judgeChromeRead({ status: 404, html: page("Page not found") })).toBe("notfound");
    expect(judgeChromeRead({ status: 410, html: page("Gone") })).toBe("notfound");
    expect(judgeChromeRead({ status: 401, html: page("Sign in") })).toBe("login");
    expect(judgeChromeRead({ status: 429, html: page("Too many requests") })).toBe("slowdown");
  });
  it("a 403 is still refused, and so is no answer at all", () => {
    expect(judgeChromeRead({ status: 403, html: page("Access Denied") })).toBe("blocked");
    expect(judgeChromeRead({ status: null, html: "" })).toBe("blocked");
  });
  it("a 503 is a bot wall when it looks like one, a server error otherwise", () => {
    expect(judgeChromeRead({ status: 503, html: page("Just a moment...") })).toBe("blocked");
    expect(judgeChromeRead({ status: 503, html: page("Service unavailable") })).toBe("other");
  });
  it("a 200 that is still the bot check is refused", () => {
    expect(judgeChromeRead({ status: 200, html: page("Just a moment...") })).toBe("blocked");
  });
  it("a real page that only carries a captcha script is the page: the status decides, not the script", () => {
    expect(judgeChromeRead({ status: 200, html: page("Contact us", `<script src="https://www.google.com/recaptcha/api.js"></script>${"x".repeat(400)}`) })).toBe("ok");
  });
  it("a 200 with next to nothing in it is not a page", () => {
    expect(judgeChromeRead({ status: 200, html: "<html></html>" })).toBe("other");
  });
});

describe("looksLikeBotWallPage — the same signs as the server", () => {
  const samples = [
    page("Just a moment..."),
    page("Attention Required! | Cloudflare"),
    page("Access Denied", "You don't have permission to access this page. Reference #18.2f"),
    page("x", "Request unsuccessful. Incapsula incident ID: 1"),
    page("x", `<div id="px-captcha"></div>`),
    page("x", `<script src="https://geo.captcha-delivery.com/captcha/"></script>`),
    page("Product overview"),
    page("Pricing", "Plans for every team"),
  ];
  it("agrees with looksLikeBotWall (html.ts) on every sample, for the statuses a wall comes with", () => {
    for (const html of samples) for (const status of [200, 403, 503]) expect(looksLikeBotWallPage(html), html.slice(0, 80)).toBe(looksLikeBotWall(status, html));
  });
});

describe("refusedStop — a site that refuses everything is not asked for every page", () => {
  it("the scan goes on until five pages in a row were refused", () => {
    expect(REFUSED_IN_A_ROW).toBe(5);
    for (let n = 1; n < 5; n++) expect(refusedStop(n).stop).toBe(false);
    expect(refusedStop(5).stop).toBe(true);
    expect(refusedStop(6).stop).toBe(true);
  });
});
