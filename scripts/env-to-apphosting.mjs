#!/usr/bin/env node
/**
 * Build dev-apphosting.yaml from apphosting.yaml structure + .env values.
 *
 *   node scripts/env-to-apphosting.mjs [.env] [dev-apphosting.yaml]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const templatePath = resolve(ROOT, "apphosting.yaml");
const envPath = resolve(process.argv[2] ?? resolve(ROOT, ".env"));
const outPath = resolve(process.argv[3] ?? resolve(ROOT, "dev-apphosting.yaml"));

const BUILD_RUNTIME = new Set([
  "DISABLE_LOGIN",
  "DISABLE_GOOGLE_LOGIN",
  "SHOW_START_FREE_TRIAL",
  "NEXT_PUBLIC_APP_URL",
]);

function parseDotEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function yamlQuote(value) {
  if (value === "") return '""';
  if (/[\n:#"'{}[\],&*?|>-]/.test(value)) {
    return JSON.stringify(value);
  }
  return `"${value}"`;
}

function formatEntry(key, value) {
  const availability = BUILD_RUNTIME.has(key)
    ? "    availability:\n      - BUILD\n      - RUNTIME\n"
    : "    availability:\n      - RUNTIME\n";
  return `  - variable: ${key}\n    value: ${yamlQuote(value)}\n${availability}`;
}

const template = parse(readFileSync(templatePath, "utf8"));
const dotenv = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};

const entries = (template.env ?? []).map((entry) => {
  const key = entry.variable;
  let value = "";

  if (key in dotenv) {
    value = dotenv[key];
  } else if (entry.value !== undefined && entry.value !== null && entry.value !== "") {
    value = String(entry.value);
  }

  // Local dev: prefer DATABASE_URL over Cloud SQL connector.
  if (key === "INSTANCE_CONNECTION_NAME" && dotenv.DATABASE_URL) {
    value = "";
  }
  if (key === "DB_USER" && dotenv.DATABASE_URL) value = "";
  if (key === "DB_NAME" && dotenv.DATABASE_URL) value = "";
  if (key === "DB_PASSWORD" && dotenv.DATABASE_URL) value = "";

  return formatEntry(key, value);
});

const yaml = `# Local App Hosting configuration (DEV)
# Loaded by npm scripts via scripts/with-apphosting-env.mjs
# Keep variable names and order aligned with apphosting.yaml (prod).
#
# Copy apphosting.yaml to dev-apphosting.yaml, replace each `secret:` with a local `value:`, and fill in secrets.
# Compare prod vs dev:  npm run env:diff

runConfig:
  minInstances: 0

env:
${entries.join("\n")}
`;

writeFileSync(outPath, yaml);
console.log(`Wrote ${outPath} (${entries.length} variables; overlaid ${envPath})`);
