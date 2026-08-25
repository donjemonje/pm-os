import { readFileSync, writeFileSync } from "fs";

// read token from .env.local without printing it
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const token = env.ZENDESK_OAUTH_TOKEN;
if (!token) { console.error("ZENDESK_OAUTH_TOKEN not found"); process.exit(1); }

const res = await fetch("https://pm-os.zendesk.com/api/v2/tickets.json?include=users&page[size]=100", {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) { console.error("Zendesk API error", res.status, (await res.text()).slice(0, 200)); process.exit(1); }
const data = await res.json();

const users = new Map((data.users ?? []).map((u) => [u.id, u]));
const seed = data.tickets.filter((t) => (t.tags ?? []).includes("pmos_seed"));

const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const rows = [["external_id", "subject", "description", "requester_name", "requester_email", "tags", "status", "created_at"].join(",")];
for (const t of seed) {
  const u = users.get(t.requester_id);
  // t.description = the ticket's first comment (the real body); later
  // comments (incl. the AI auto-reply) are not part of it.
  rows.push([
    q(t.external_id ?? t.id), q(t.subject), q(t.description),
    q(u?.name), q(u?.email),
    q((t.tags ?? []).join(" ")), q(t.status), q(t.created_at),
  ].join(","));
}
writeFileSync("data/zendesk-live-tickets.csv", rows.join("\n") + "\n");
console.log(`wrote ${seed.length} tickets (of ${data.tickets.length} total) to data/zendesk-live-tickets.csv`);
