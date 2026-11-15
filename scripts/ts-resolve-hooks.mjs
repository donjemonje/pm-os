/**
 * Lets Node run the app's TypeScript sources directly (Node ≥ 23.6 strips
 * types natively) by resolving the extensionless relative imports the app
 * uses — "./html" → "./html.ts". Used by the competitors scanner:
 *
 *   node --import ./scripts/ts-resolve-hooks.mjs scripts/competitors-scanner.mts
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const EXTS = [".ts", ".tsx", ".mts", "/index.ts"];

registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const ext of EXTS) {
        const candidate = new URL(base.href + ext);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
    }
    return next(specifier, context);
  },
});
