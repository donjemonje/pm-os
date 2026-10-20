import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests (`npm run test:unit`): pure modules only, no DOM, no DB.
// The e2e suite is Playwright (`npm run test:e2e`).
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
