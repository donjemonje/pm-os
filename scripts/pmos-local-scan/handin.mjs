#!/usr/bin/env node
/**
 * Hand one page in to PM-OS — called by the Claude runner through the scan's
 * handin.sh (scripts/pmos-local-scan/poller.mjs). A real file, not a template
 * string: no escaping to get wrong.
 *
 *   node handin.mjs <scanDir> <url> <status> [file]
 *
 * The scan folder holds `api` (the hand-in route of this scan) and `token`
 * (its scan token, mode 0600) — Claude never sees the token in a command line.
 * A file that starts with %PDF- (or is named .pdf) is posted as bytes
 * (pdfBase64); anything else as HTML. The server extracts the text.
 * Prints the response status and the server's verdict; exit 1 on refusal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [scanDir, url, status, file] = process.argv.slice(2);
if (!scanDir || !url || !status) {
  console.error("usage: handin.mjs <scanDir> <url> <status> [file]");
  process.exit(2);
}
const api = readFileSync(join(scanDir, "api"), "utf8").trim();
const token = readFileSync(join(scanDir, "token"), "utf8").trim();

let body = { url, status };
if (file) {
  const buf = readFileSync(file);
  const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-" || /\.pdf$/i.test(file) || /\.pdf(\?|$)/i.test(url);
  body = isPdf ? { url, status, pdfBase64: buf.toString("base64") } : { url, status, html: buf.toString("utf8") };
}
const res = await fetch(api, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
const text = await res.text();
console.log(`${res.status} ${text.slice(0, 200)}`);
process.exit(res.ok ? 0 : 1);
