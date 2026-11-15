import { lookup } from "node:dns/promises";
import { isPrivateHost } from "./url";

/**
 * The private-network guard with DNS (story checklist §12, Tomer's review 2026-11-10). isPrivateHost() reads the
 * hostname text; a public name can still resolve to 10.x or 127.0.0.1, which would make the add-competitor probe
 * (in the app server) or a redirect (in the scanner) fetch an internal page. So a host is also resolved, and every
 * address it answers with must be public. Server only (node:dns) — never imported by a component.
 */
export async function resolvesToPrivate(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHost(h)) return true;
  // An IP literal was already judged by isPrivateHost; names are resolved.
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(h, { all: true });
  } catch {
    // Does not resolve: not private, and the fetch that follows reports the real failure.
    return false;
  }
  return addresses.some((a) => isPrivateHost(a.address));
}

/** The one check the add/edit routes run on a website before anything is fetched from it: public name AND public addresses. */
export async function isPublicWebsite(url: string): Promise<boolean> {
  try {
    return !(await resolvesToPrivate(new URL(url).hostname));
  } catch {
    return false;
  }
}
