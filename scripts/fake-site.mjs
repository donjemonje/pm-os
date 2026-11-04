#!/usr/bin/env node
/**
 * Run the Website Scanning fixture site by hand (the Playwright specs start it in-process):
 *   node --no-warnings --import ./scripts/ts-resolve-hooks.mjs scripts/fake-site.mjs --port 3399
 * Control: POST /__control {"peopleNotFound":true}, POST /__reset, GET /__requests.
 */
import { startFakeSite } from "../tests/fixtures/fake-site/fake-site.ts";

const i = process.argv.indexOf("--port");
const port = i >= 0 ? Number(process.argv[i + 1]) : 3399;
const h = process.argv.indexOf("--host");
const site = await startFakeSite({ port, host: h >= 0 ? process.argv[h + 1] : undefined });
console.log(`fake site: ${site.url} (host ${site.host})`);
process.on("SIGINT", () => void site.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void site.stop().then(() => process.exit(0)));
