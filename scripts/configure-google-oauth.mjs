#!/usr/bin/env node
/**
 * Update GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in dev-apphosting.yaml.
 *
 * Get values from:
 * https://console.cloud.google.com/apis/credentials?project=pm-os-9d992
 *
 * Usage:
 *   npm run google-oauth:configure -- <CLIENT_ID> <CLIENT_SECRET>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse, stringify } from "yaml";

const PMOS_GCP_PROJECT_ID = "pm-os-9d992";
const devYaml = resolve(import.meta.dirname, "../dev-apphosting.yaml");

const clientId = process.argv[2]?.trim();
const clientSecret = process.argv[3]?.trim();

if (!clientId || !clientSecret) {
  console.error("Usage: npm run google-oauth:configure -- <CLIENT_ID> <CLIENT_SECRET>");
  console.error(
    `Get credentials from https://console.cloud.google.com/apis/credentials?project=${PMOS_GCP_PROJECT_ID}`
  );
  process.exit(1);
}

if (!clientId.endsWith(".apps.googleusercontent.com")) {
  console.error("CLIENT_ID should end with .apps.googleusercontent.com");
  process.exit(1);
}

if (!existsSync(devYaml)) {
  console.error("dev-apphosting.yaml not found. Copy apphosting.yaml to dev-apphosting.yaml and replace each secret: with a local value: first.");
  process.exit(1);
}

const doc = parse(readFileSync(devYaml, "utf8"));
const env = doc.env ?? [];

function setVar(name, value) {
  const entry = env.find((e) => e.variable === name);
  if (entry) entry.value = value;
  else env.push({ variable: name, value, availability: ["RUNTIME"] });
}

setVar("GOOGLE_CLIENT_ID", clientId);
setVar("GOOGLE_CLIENT_SECRET", clientSecret);
doc.env = env;

writeFileSync(devYaml, stringify(doc), "utf8");

const projectNumber = clientId.match(/^(\d+)-/)?.[1] ?? "unknown";
console.log("Updated dev-apphosting.yaml");
console.log(`Client project number: ${projectNumber}`);
console.log("Restart dev server: npm run dev");
console.log("Then verify: npm run google-oauth:verify");
