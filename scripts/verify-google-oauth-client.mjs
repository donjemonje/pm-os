#!/usr/bin/env node
/**
 * Verify GOOGLE_CLIENT_ID belongs to pm-os-9d992 (not a personal GCP project).
 * Run: npm run google-oauth:verify
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import { spawnSync } from "child_process";

const PMOS_GCP_PROJECT_ID = "pm-os-9d992";
const BRANDING = { appName: "PM-OS", supportEmail: "daniel@pm-os.io" };
const WRONG_CLIENT_PREFIX = "480975761543";

function loadAppUrl() {
  if (process.env.NEXT_PUBLIC_APP_URL?.trim()) {
    return process.env.NEXT_PUBLIC_APP_URL.trim().replace(/\/$/, "");
  }
  const devYaml = resolve(import.meta.dirname, "../dev-apphosting.yaml");
  if (!existsSync(devYaml)) return "http://localhost:3000";
  const doc = parse(readFileSync(devYaml, "utf8"));
  const entry = (doc.env ?? []).find((e) => e.variable === "NEXT_PUBLIC_APP_URL");
  const value = entry?.value?.trim();
  return value ? value.replace(/\/$/, "") : "http://localhost:3000";
}

function loadClientId() {
  if (process.env.GOOGLE_CLIENT_ID?.trim()) {
    return process.env.GOOGLE_CLIENT_ID.trim();
  }
  const devYaml = resolve(import.meta.dirname, "../dev-apphosting.yaml");
  if (!existsSync(devYaml)) return null;
  const doc = parse(readFileSync(devYaml, "utf8"));
  const entry = (doc.env ?? []).find((e) => e.variable === "GOOGLE_CLIENT_ID");
  return entry?.value?.trim() || null;
}

function expectedProjectNumber() {
  const result = spawnSync(
    "gcloud",
    ["projects", "describe", PMOS_GCP_PROJECT_ID, "--format=value(projectNumber)"],
    { encoding: "utf8" }
  );
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

const clientId = loadClientId();
const appUrl = loadAppUrl();
const redirectUri = `${appUrl}/api/auth/oauth/google/callback`;
const prodRedirectUri = "https://pm-os.io/api/auth/oauth/google/callback";
if (!clientId) {
  console.error("No GOOGLE_CLIENT_ID found (env or dev-apphosting.yaml).");
  process.exit(1);
}

const projectNumber = clientId.match(/^(\d+)-/)?.[1] ?? "unknown";
const expectedNumber = expectedProjectNumber();
const brandingUrl = `https://console.cloud.google.com/auth/branding?project=${PMOS_GCP_PROJECT_ID}`;
const credentialsUrl = `https://console.cloud.google.com/apis/credentials?project=${PMOS_GCP_PROJECT_ID}`;

let wrong = false;

console.log("PM-OS Google OAuth check\n");
console.log(`Configured client: ${clientId.slice(0, 30)}…`);
console.log(`Client GCP project number: ${projectNumber}`);
console.log(`Expected GCP project id: ${PMOS_GCP_PROJECT_ID}`);
if (expectedNumber) {
  console.log(`Expected GCP project number: ${expectedNumber}`);
  if (projectNumber !== expectedNumber) wrong = true;
}
if (clientId.startsWith(WRONG_CLIENT_PREFIX)) wrong = true;

console.log(`Expected consent screen: "${BRANDING.appName}" / ${BRANDING.supportEmail}\n`);

if (wrong) {
  console.error("✗ WRONG OAuth client — Google will show the old app name (pmos) and developer email.");
  console.error("  Your local dev-apphosting.yaml still uses a personal/dev GCP project client.\n");
  console.error("Fix:");
  console.error(`1. Open ${credentialsUrl}`);
  console.error("2. Copy the OAuth 2.0 Web client from pm-os-9d992 (Client ID + Secret)");
  console.error("3. Run: npm run google-oauth:configure -- <CLIENT_ID> <CLIENT_SECRET>");
  console.error("4. Ensure branding is set at:");
  console.error(`   ${brandingUrl}`);
  console.error(`   App name: ${BRANDING.appName}, support email: ${BRANDING.supportEmail}`);
  console.error("5. Restart: npm run dev\n");
  process.exit(1);
}

console.log("✓ OAuth client project number looks correct.\n");
console.log("Add these Authorized redirect URIs on your OAuth 2.0 Web client:");
console.log(`  ${redirectUri}`);
console.log(`  ${prodRedirectUri}`);
console.log(`\nGCP credentials: ${credentialsUrl}`);
console.log("\nIf Google shows redirect_uri_mismatch, the local URI above is missing from that client.");
console.log("If Google still shows the wrong app name, update consent screen branding:");
console.log(brandingUrl);
