/**
 * Load Firebase App Hosting-style env blocks into a plain key/value map.
 * Used locally so dev runs the same variable names as production (apphosting.yaml).
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_DEV_APPHOSTING = resolve(ROOT, "dev-apphosting.yaml");

function parseEnvFile(path) {
  const raw = readFileSync(path, "utf8");
  const doc = parse(raw);
  if (!doc || !Array.isArray(doc.env)) {
    throw new Error(`${path}: expected top-level "env:" array`);
  }
  return doc.env;
}

/** @param {string} yamlPath */
export function loadAppHostingEnv(yamlPath) {
  const abs = resolve(yamlPath);
  if (!existsSync(abs)) {
    // In the App Hosting build/runtime the dev yaml is (correctly) absent —
    // env is injected from apphosting.yaml by the platform. Only local dev
    // needs the file, so skip with a notice instead of failing.
    console.warn(`[apphosting-env] ${abs} not found — using existing process env`);
    return {};
  }

  const env = {};
  for (const entry of parseEnvFile(abs)) {
    const name = entry?.variable?.trim();
    if (!name) continue;

    if (entry.value !== undefined && entry.value !== null && entry.value !== "") {
      env[name] = String(entry.value);
      continue;
    }

    if (entry.secret) {
      // Local dev files should use "value". For secret refs, allow override via env.
      const overrideKey = `PMOS_SECRET_${entry.secret.replace(/-/g, "_").toUpperCase()}`;
      const resolved = process.env[overrideKey] ?? process.env[name];
      if (resolved?.trim()) {
        env[name] = resolved.trim();
      }
    }
  }

  return env;
}

/**
 * @param {string} yamlPath
 * @param {{ override?: boolean }} [options]
 */
export function applyAppHostingEnv(yamlPath, options = {}) {
  const { override = true } = options;
  const loaded = loadAppHostingEnv(yamlPath);

  for (const [key, value] of Object.entries(loaded)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return loaded;
}
