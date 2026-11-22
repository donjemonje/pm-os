/**
 * A company's knowledge base in the database (src/lib/competitors/news/knowledge.ts):
 *
 *   npm run competitors:knowledge -- --org <organization name> --list
 *       every company of the organization: features in its knowledge base (from the read, from news), when it was
 *       made, and how many pages are due for the news intake.
 *
 *   npm run competitors:knowledge -- --org <organization name> --import <items.json> [--company <name in PM-OS>] [--as-of <ISO time>]
 *       a list file (form "features-v3") becomes that company's knowledge base. The company is the file's `company`
 *       unless --company names it as PM-OS knows it ("Cybersixgill (Bitsight)" for a file that says "Bitsight").
 *       The list's time is the file's own time unless --as-of gives it: news is what the company's pages add after it.
 *       An earlier read's rows are replaced; what the news intake added stays. One file at a time; an older list form is refused.
 *
 *   npm run competitors:knowledge -- --news <scanId>
 *       run the news step of a scan that has ended, by hand (what the scan itself does at its end).
 *
 * A list made from material under NDA is imported from its private file like any other: it lives in the database
 * only — never copy such a file into the repository.
 */
import { readFileSync, statSync } from "node:fs";
import { db } from "../src/lib/db";
import { dueStatus } from "../src/lib/competitors/news/after-scan";
import { importKnowledge, knowledgeFileProblem, type KnowledgeFile } from "../src/lib/competitors/news/knowledge";

const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null; };
const fail = (message: string): never => { console.error(message); process.exit(2); };

async function workspaceOf(orgName: string) {
  const workspaces = await db.workspace.findMany({ where: { organization: { name: orgName } }, select: { id: true } });
  if (workspaces.length !== 1) fail(`Expected one organization named "${orgName}", found ${workspaces.length}.`);
  return workspaces[0].id;
}

async function main() {
  const scanId = value("--news");
  if (scanId) {
    const { newsAfterScan } = await import("../src/lib/competitors/news/after-scan");
    console.log(JSON.stringify(await newsAfterScan(scanId, { byHand: true }), null, 2));
    return;
  }
  const org = value("--org") ?? fail("Give the organization: --org <name>.");
  const workspaceId = await workspaceOf(org);

  if (args.includes("--list")) {
    const companies = await db.competitor.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ isOwn: "desc" }, { name: "asc" }], select: { id: true, name: true, isOwn: true, knowledgeReadyAt: true } });
    for (const c of companies) {
      const [read, news] = await Promise.all([db.competitorKnowledge.count({ where: { competitorId: c.id, source: "read" } }), db.competitorKnowledge.count({ where: { competitorId: c.id, source: "news" } })]);
      let due = 0;
      if (c.knowledgeReadyAt && !c.isOwn) {
        const pages = await db.sourcePage.findMany({ where: { source: { competitorId: c.id }, state: { in: ["present", "unlinked"] }, text: { not: null }, OR: [{ firstSeenAt: { gt: c.knowledgeReadyAt } }, { changedAt: { gt: c.knowledgeReadyAt } }] }, select: { id: true, url: true, hash: true, newsHash: true, firstSeenAt: true, changedAt: true } });
        due = pages.filter((p) => dueStatus(p, c.knowledgeReadyAt!)).length;
      }
      console.log(`${c.name}${c.isOwn ? " (own)" : ""}: ${read ? `${read} features` : "no knowledge base"}${news ? ` + ${news} from news` : ""}${c.knowledgeReadyAt ? ` · made ${c.knowledgeReadyAt.toISOString().slice(0, 16)}Z` : ""}${c.isOwn ? "" : c.knowledgeReadyAt ? ` · ${due} pages due for news` : ""}`);
    }
    return;
  }

  const path = value("--import") ?? fail("Say what to do: --list, --import <items.json> or --news <scanId>.");
  const file = JSON.parse(readFileSync(path, "utf8")) as KnowledgeFile;
  const problem = knowledgeFileProblem(file);
  if (problem) fail(`${path} is not imported: ${problem}.`);
  const name = value("--company") ?? String(file.company);
  const companies = await db.competitor.findMany({ where: { workspaceId, deletedAt: null, name: { equals: name, mode: "insensitive" } }, select: { id: true, workspaceId: true, name: true } });
  if (companies.length !== 1) fail(`No single company named "${name}" in ${org} (found ${companies.length}). Give its name in PM-OS with --company.`);
  const asOf = value("--as-of");
  const readyAt = asOf ? new Date(asOf) : statSync(path).mtime;
  if (Number.isNaN(readyAt.getTime())) fail(`--as-of is not a time: ${asOf}`);
  const done = await importKnowledge(companies[0], file, readyAt);
  console.log(`${done.company}: ${done.rows} features imported${done.leftOut ? ` (${done.leftOut} items without a name left out)` : ""}, ${done.integrations} known integrations · replaced ${done.replaced} rows of an earlier read · kept ${done.keptFromNews} added by news · list made ${done.readyAt.toISOString().slice(0, 16)}Z`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
