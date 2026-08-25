#!/usr/bin/env node
/**
 * Run a command with env vars loaded from an App Hosting yaml file.
 *
 *   node scripts/with-apphosting-env.mjs [yamlPath] -- <command> [args...]
 *   PMOS_APPHOSTING_ENV=dev-apphosting.yaml npm run dev
 */
import { spawn } from "child_process";
import { resolve } from "path";
import { applyAppHostingEnv, DEFAULT_DEV_APPHOSTING } from "./apphosting-env.mjs";

const argv = process.argv.slice(2);
let yamlPath = process.env.PMOS_APPHOSTING_ENV?.trim() || DEFAULT_DEV_APPHOSTING;
let commandStart = 0;

if (argv[0] !== "--") {
  if (argv[0]?.endsWith(".yaml") || argv[0]?.endsWith(".yml")) {
    yamlPath = argv[0];
    commandStart = argv[1] === "--" ? 2 : 1;
  }
}

const command = argv.slice(commandStart);
if (command.length === 0) {
  console.error(
    "Usage: node scripts/with-apphosting-env.mjs [dev-apphosting.yaml] -- <command> [args...]"
  );
  process.exit(1);
}

const absYaml = resolve(yamlPath);
applyAppHostingEnv(absYaml);

const [bin, ...args] = command;
const child = spawn(bin, args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
