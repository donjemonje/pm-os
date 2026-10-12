/**
 * Jira TEST project for the e2e suite (feature/jira-support-kela, 2026-10-12).
 *
 * The Ideas ↔ Jira path (pull, match candidates, write-back) is tested against
 * a REAL Jira project — a copy of Kela's 66 PRDT issues in a project the
 * tests may mutate and reset. Same Atlassian site as the demo (one account,
 * no time lost); a separate Jira dev environment is recorded tech debt.
 *
 * Auth: a Jira API token (email + token, basic auth). Not OAuth — refresh
 * tokens rotate on use and the test DB is wiped per run, so a seeded OAuth
 * token would die on its first refresh.
 *
 * Env (test-apphosting.yaml; the npm script loads it):
 *   JIRA_TEST_SITE_URL      https://d3east.atlassian.net
 *   JIRA_TEST_EMAIL         the token owner's Atlassian email
 *   JIRA_TEST_API_TOKEN     API token from id.atlassian.com → Security
 *   JIRA_TEST_PROJECT_KEY   TEST (default)
 *   JIRA_TEST_SOURCE_PROJECT PRDT (default) — schemes are cloned from it so
 *                           TEST has the same statuses, work types and the
 *                           Module field on its screens
 *   JIRA_TEST_PRODUCT_LINE_FIELD_ID customfield_10319 (default; Kela's Module)
 *
 * Usage (from the repo root):
 *   node scripts/with-apphosting-env.mjs test-apphosting.yaml -- node scripts/jira-test-project.mjs status
 *   … create            create the TEST project (idempotent)
 *   … seed <kela.csv>   create the 66 issues from Kela's Jira export (skips keys already seeded)
 *   … reset <kela.csv>  delete every TEST issue, then seed
 *   … wipe --yes        delete every TEST issue
 *
 * Safety: refuses to write to any project other than JIRA_TEST_PROJECT_KEY,
 * and never to the source project.
 */
import { readFileSync } from "node:fs";

const SITE = (process.env.JIRA_TEST_SITE_URL ?? "").replace(/\/+$/, "");
const EMAIL = process.env.JIRA_TEST_EMAIL ?? "";
const TOKEN = process.env.JIRA_TEST_API_TOKEN ?? "";
const KEY = (process.env.JIRA_TEST_PROJECT_KEY ?? "TEST").trim();
const SOURCE = (process.env.JIRA_TEST_SOURCE_PROJECT ?? "PRDT").trim();
const MODULE_FIELD = (process.env.JIRA_TEST_PRODUCT_LINE_FIELD_ID ?? "customfield_10319").trim();
const PROJECT_NAME = process.env.JIRA_TEST_PROJECT_NAME ?? "KELA Product — PM-OS QA copy";

/** Kela's export values → the imported PRDT values (same mapping as the 2026-10-10 import). */
const ISSUE_TYPE = { "Dev Story": "Story", Task: "Task", Idea: "Story" };
const PRIORITY = { Critical: "Highest", "Show stoper": "Highest", Major: "High", Minor: "Low" };
/** Label carrying the issue's key in Kela's export — the tests' stable handle. */
const SOURCE_LABEL_PREFIX = "kela-src-";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!SITE || !EMAIL || !TOKEN) {
  fail("JIRA_TEST_SITE_URL, JIRA_TEST_EMAIL and JIRA_TEST_API_TOKEN must be set (test-apphosting.yaml).");
}
if (KEY === SOURCE) fail(`Refusing: the test project key (${KEY}) equals the source project (${SOURCE}).`);

const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

async function api(method, path, body) {
  const res = await fetch(`${SITE}${path}`, {
    method,
    headers: { Authorization: AUTH, Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

/** Jira paginates search at 100; walk every page. */
async function searchAll(jql, fields = ["summary", "status", "labels"]) {
  const issues = [];
  let nextPageToken;
  for (;;) {
    const data = await api("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: 100,
      fields,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    issues.push(...(data.issues ?? []));
    if (data.isLast || !data.nextPageToken || (data.issues ?? []).length === 0) break;
    nextPageToken = data.nextPageToken;
  }
  return issues;
}

// ————— CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) —————

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}

function readKelaExport(path) {
  const rows = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
  const header = rows[0];
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) fail(`CSV has no "${name}" column`);
    return i;
  };
  const iSummary = col("Summary");
  const iKey = col("Issue key");
  const iType = col("Issue Type");
  const iStatus = col("Status");
  const iPriority = col("Priority");
  const iDesc = col("Description");
  // Several "Module…" custom fields exist in the export; the first "Custom
  // field (Module)" is the populated single-select.
  const iModule = header.indexOf("Custom field (Module)");
  if (iModule < 0) fail('CSV has no "Custom field (Module)" column');
  return rows.slice(1).map((r) => ({
    sourceKey: r[iKey],
    summary: r[iSummary],
    issueType: ISSUE_TYPE[r[iType]] ?? "Story",
    status: r[iStatus],
    priority: PRIORITY[r[iPriority]] ?? "High",
    description: r[iDesc] ?? "",
    module: r[iModule] ?? "",
  }));
}

// ————— project —————

async function getProject(key) {
  try {
    return await api("GET", `/rest/api/3/project/${key}`);
  } catch (err) {
    if (String(err.message).includes("→ 404")) return null;
    throw err;
  }
}

/** Scheme ids of the source project, so the copy behaves identically. */
async function sourceSchemes(sourceProjectId) {
  const q = `projectId=${sourceProjectId}`;
  const pick = async (path, field) => {
    try {
      const data = await api("GET", `${path}?${q}`);
      const first = data.values?.[0];
      return first?.[field]?.id ?? first?.id ?? undefined;
    } catch {
      return undefined;
    }
  };
  return {
    issueTypeScheme: await pick("/rest/api/3/issuetypescheme/project", "issueTypeScheme"),
    issueTypeScreenScheme: await pick("/rest/api/3/issuetypescreenscheme/project", "issueTypeScreenScheme"),
    workflowScheme: await pick("/rest/api/3/workflowscheme/project", "workflowScheme"),
    fieldConfigurationScheme: await pick("/rest/api/3/fieldconfigurationscheme/project", "fieldConfigurationScheme"),
  };
}

async function createProject() {
  const existing = await getProject(KEY);
  if (existing) {
    console.log(`• Project ${KEY} ("${existing.name}") exists — reusing.`);
    return existing;
  }
  const source = await getProject(SOURCE);
  if (!source) fail(`Source project ${SOURCE} not found on ${SITE}.`);
  const me = await api("GET", "/rest/api/3/myself");
  const schemes = await sourceSchemes(source.id);
  const body = {
    key: KEY,
    name: PROJECT_NAME,
    projectTypeKey: source.projectTypeKey ?? "software",
    leadAccountId: me.accountId,
    assigneeType: "UNASSIGNED",
    description: `Copy of ${SOURCE} for the PM-OS e2e suite. Issues here are created, edited and deleted by tests.`,
    ...(schemes.issueTypeScheme ? { issueTypeScheme: Number(schemes.issueTypeScheme) } : {}),
    ...(schemes.issueTypeScreenScheme ? { issueTypeScreenScheme: Number(schemes.issueTypeScreenScheme) } : {}),
    ...(schemes.workflowScheme ? { workflowScheme: Number(schemes.workflowScheme) } : {}),
    ...(schemes.fieldConfigurationScheme
      ? { fieldConfigurationScheme: Number(schemes.fieldConfigurationScheme) }
      : {}),
  };
  const created = await api("POST", "/rest/api/3/project", body);
  console.log(`✓ Project ${KEY} created (id ${created.id}), schemes cloned from ${SOURCE}:`, schemes);
  return getProject(KEY);
}

// ————— issues —————

function sourceLabel(sourceKey) {
  return `${SOURCE_LABEL_PREFIX}${sourceKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

async function seededSourceKeys() {
  const issues = await searchAll(`project = "${KEY}"`);
  const map = new Map();
  for (const i of issues) {
    const label = (i.fields.labels ?? []).find((l) => l.startsWith(SOURCE_LABEL_PREFIX));
    if (label) map.set(label, i.key);
  }
  return { map, total: issues.length };
}

async function transitionTo(issueKey, statusName) {
  const data = await api("GET", `/rest/api/3/issue/${issueKey}/transitions`);
  const t = (data.transitions ?? []).find(
    (x) => (x.to?.name ?? "").toLowerCase() === statusName.toLowerCase()
  );
  if (!t) return false;
  await api("POST", `/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: t.id } });
  return true;
}

async function seed(csvPath) {
  if (!csvPath) fail("seed needs the path to Kela's Jira export CSV");
  const rows = readKelaExport(csvPath);
  const project = await createProject();
  const { map: already } = await seededSourceKeys();
  const initialStatus = await (async () => {
    // The status new issues start in — transitions only when the target differs.
    const statuses = await api("GET", `/rest/api/3/project/${project.id}/statuses`).catch(() => []);
    return statuses?.[0]?.statuses?.[0]?.name ?? "";
  })();

  let created = 0;
  let skipped = 0;
  let moved = 0;
  const unmoved = [];
  for (const row of rows) {
    const label = sourceLabel(row.sourceKey);
    if (already.has(label)) {
      skipped++;
      continue;
    }
    // API v2 takes the description as Jira wiki markup — exactly what the
    // export holds, so links and lists survive.
    const fields = {
      project: { key: KEY },
      summary: row.summary,
      issuetype: { name: row.issueType },
      priority: { name: row.priority },
      labels: [label],
      description: row.description,
      ...(row.module ? { [MODULE_FIELD]: { value: row.module } } : {}),
    };
    let issue;
    try {
      issue = await api("POST", "/rest/api/2/issue", { fields });
    } catch (err) {
      // Most likely the Module field is not on TEST's create screen: retry
      // without it and say so, instead of leaving the project half-seeded.
      if (row.module && String(err.message).includes(MODULE_FIELD)) {
        delete fields[MODULE_FIELD];
        issue = await api("POST", "/rest/api/2/issue", { fields });
        console.warn(`! ${issue.key}: Module "${row.module}" not writable (field not on the create screen?)`);
      } else throw err;
    }
    created++;
    if (row.status && row.status.toLowerCase() !== initialStatus.toLowerCase()) {
      if (await transitionTo(issue.key, row.status)) moved++;
      else unmoved.push(`${issue.key} → ${row.status}`);
    }
    process.stdout.write(`\r  ${created} created, ${skipped} already there…`);
  }
  console.log(`\n✓ ${KEY}: ${created} issues created, ${skipped} skipped (already seeded), ${moved} transitioned.`);
  if (unmoved.length > 0) console.warn(`! No transition found for: ${unmoved.join(", ")}`);
}

async function wipe() {
  const issues = await searchAll(`project = "${KEY}"`, ["summary"]);
  let n = 0;
  for (const i of issues) {
    await api("DELETE", `/rest/api/3/issue/${i.key}?deleteSubtasks=true`);
    n++;
    process.stdout.write(`\r  ${n}/${issues.length} deleted…`);
  }
  console.log(`\n✓ ${KEY}: ${n} issues deleted.`);
}

async function status() {
  const project = await getProject(KEY);
  if (!project) {
    console.log(`• Project ${KEY} does not exist on ${SITE}. Run "create" (or "seed").`);
    return;
  }
  const issues = await searchAll(`project = "${KEY}"`, ["status", "labels"]);
  const byStatus = new Map();
  let labeled = 0;
  for (const i of issues) {
    const s = i.fields.status?.name ?? "?";
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
    if ((i.fields.labels ?? []).some((l) => l.startsWith(SOURCE_LABEL_PREFIX))) labeled++;
  }
  console.log(`• ${KEY} ("${project.name}"): ${issues.length} issues, ${labeled} seeded from Kela's export.`);
  for (const [s, n] of byStatus) console.log(`    ${s}: ${n}`);
  const fields = await api("GET", "/rest/api/3/field");
  const mod = fields.find((f) => f.id === MODULE_FIELD);
  console.log(`• Product-line field ${MODULE_FIELD}: ${mod ? `"${mod.name}"` : "NOT FOUND on this site"}`);
}

const [cmd, arg, flag] = process.argv.slice(2);
try {
  switch (cmd) {
    case "status":
      await status();
      break;
    case "create":
      await createProject();
      break;
    case "seed":
      await seed(arg);
      break;
    case "reset":
      await wipe();
      await seed(arg);
      break;
    case "wipe":
      if (flag !== "--yes" && arg !== "--yes") fail('wipe deletes every issue in the test project — add "--yes".');
      await wipe();
      break;
    default:
      fail("usage: jira-test-project.mjs status | create | seed <csv> | reset <csv> | wipe --yes");
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
