#!/usr/bin/env node
/**
 * Side-by-side diff of env vars in apphosting.yaml vs dev-apphosting.yaml.
 *
 *   npm run env:diff
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

/** @param {string} yamlPath */
function readEnvEntries(yamlPath) {
  const doc = parse(readFileSync(yamlPath, "utf8"));
  const map = new Map();
  for (const entry of doc.env ?? []) {
    const key = entry?.variable?.trim();
    if (!key) continue;
    if (entry.secret) {
      map.set(key, { kind: "secret", value: entry.secret });
    } else {
      map.set(key, { kind: "value", value: String(entry.value ?? "") });
    }
  }
  return map;
}

const prodPath = resolve(process.argv[2] ?? resolve(ROOT, "apphosting.yaml"));
const devPath = resolve(process.argv[3] ?? resolve(ROOT, "dev-apphosting.yaml"));

const prod = readEnvEntries(prodPath);
const dev = readEnvEntries(devPath);

const SECRET_KEYS =
  /SECRET|PASSWORD|KEY|CREDENTIALS|TOKEN|DATABASE_URL|CLIENT_SECRET/i;

function display(key, entry) {
  if (!entry) return "(missing)";
  if (entry.kind === "secret") return `(secret: ${entry.value})`;
  if (!entry.value) return "(empty)";
  if (SECRET_KEYS.test(key)) return "***";
  return entry.value;
}

function classify(key, prodEntry, devEntry) {
  if (!prodEntry) return "dev only";
  if (!devEntry) return "prod only";
  if (prodEntry.kind === "secret" && devEntry.kind === "value") {
    return devEntry.value ? "prod secret / dev value" : "prod secret / dev empty";
  }
  if (prodEntry.value === devEntry.value) return "same";
  return "different";
}

const allKeys = [...new Set([...prod.keys(), ...dev.keys()])].sort();
const rows = [];

for (const key of allKeys) {
  const p = prod.get(key);
  const d = dev.get(key);
  const note = classify(key, p, d);
  if (note === "same") continue;
  rows.push({ key, prod: display(key, p), dev: display(key, d), note });
}

const keyW = Math.max(8, ...rows.map((r) => r.key.length));
const prodW = Math.max(4, ...rows.map((r) => String(r.prod).length), 4);
const devW = Math.max(3, ...rows.map((r) => String(r.dev).length), 3);

console.log(`Comparing:\n  prod: ${prodPath}\n  dev:  ${devPath}\n`);
console.log(
  `${"VARIABLE".padEnd(keyW)}  ${"PROD".padEnd(prodW)}  ${"DEV".padEnd(devW)}  NOTE`
);
console.log(`${"-".repeat(keyW)}  ${"-".repeat(prodW)}  ${"-".repeat(devW)}  ${"-".repeat(20)}`);

for (const row of rows) {
  console.log(
    `${row.key.padEnd(keyW)}  ${String(row.prod).padEnd(prodW)}  ${String(row.dev).padEnd(devW)}  ${row.note}`
  );
}

console.log(`\n${rows.length} difference(s), ${allKeys.length} shared variable(s).`);
