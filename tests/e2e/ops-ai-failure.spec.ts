import { expect, test } from "@playwright/test";
import { resolve } from "path";
import { loginWithTotp, seedQaOrgWithUser, withTestDb } from "./helpers";
import { OPS_BOGUS_MODEL, OPS_MODEL_VARS, RESOLVED_ENV } from "./test-env";

/**
 * @ops — IMP-09 "all-or-nothing on AI failure" (release QA 2.0.0,
 * RUN-2.0.0.md §3.4). One real upload through the real "Upload Zendesk CSV"
 * button against real PMOS AI (Vertex), with a deliberately wrong model
 * name in the SERVER env. The first Anthropic stage (classify) must fail;
 * the batch row must be `failed` and name that stage; the UI must show the
 * failure; nothing may have been written (zero tickets, zero ideas, no new
 * catalog rows); and the verdicts paid for before the failure — the Gemini
 * field-parse call, which uses its own model env — stay in the ledger.
 *
 * Why its own invocation: the wrong model has to reach the webServer, and
 * test-apphosting.yaml wins over shell env, so tests/e2e/test-env.ts
 * overrides the Anthropic stage models (IDEAS_CATALOG_MODEL / _SPLIT_ /
 * _MATCH_ — the pipeline never reads VERTEX_MODEL) from PW_OPS_BOGUS_MODEL
 * for the ops run only:
 *   npm run test:e2e:ops      (= PW_OPS_BOGUS_MODEL=<name> … --grep @ops)
 * `npm run test:e2e` and CI exclude @ops (--grep-invert). Without the
 * override the import would succeed and the first step fails loudly — this
 * spec can never pass vacuously. Never in CI (no Vertex credentials).
 *
 * Own org (qa-ops-fail, own TOTP user) so "nothing written" is provable on
 * an empty workspace. Recreated in beforeAll and deliberately kept after the
 * run (like the golden org): the failed batch stays readable in Admin →
 * Ideas Import and in the DB for the release record.
 */

const FIXTURE = resolve(__dirname, "../fixtures/roomlens-golden-v2.csv");
const ORG = { orgName: "QA Ops Failure Org", slug: "qa-ops-fail" };
const OPS_USER = {
  name: "QA Ops PM",
  email: "qa+ops-fail@pm-os.io",
  password: "Ops-qa-pass1",
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJR", // synthetic, test-only
};
const ALL_CUSTOMERS = "All Customers"; // built-in row, bootstrapped before any batch
const UPLOAD_TIMEOUT_MS = 180_000;

interface Stage {
  stage: string;
  kind: string;
  calls?: number;
  error?: string;
}

let workspaceId: string;

test.describe("@ops IMP-09 — AI stage failure is all-or-nothing", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const seeded = await seedQaOrgWithUser(db, {
        ...ORG,
        features: { ideas: true, dashboard: false, docs: false, chat: false },
        user: OPS_USER,
      });
      workspaceId = seeded.workspaceId;
    });
  });

  test("@ops IMP-09 bogus model env: batch failed at classify, UI shows it, zero tickets/ideas written, paid verdicts kept", async ({ page }) => {
    test.setTimeout(300_000);

    await test.step("precondition: the wrong model name reached the server env", async () => {
      expect(OPS_BOGUS_MODEL, "PW_OPS_BOGUS_MODEL must be set — run `npm run test:e2e:ops`").toBeTruthy();
      for (const v of OPS_MODEL_VARS) expect(RESOLVED_ENV[v], v).toBe(OPS_BOGUS_MODEL);
      expect(OPS_BOGUS_MODEL).not.toMatch(/^claude-/);
    });

    await loginWithTotp(page, OPS_USER);
    await page.goto("/ideas");
    await expect(page.getByText("No ideas yet")).toBeVisible();

    // v2 shows no summary line after an import (c0171ba) — "done" is the
    // overlay ending; success would show ideas, failure shows the error.
    const importing = page.getByRole("button", { name: "Importing…" });
    const importError = page.getByText(/^Import failed/);

    await test.step("the upload fails in the UI and names the stage", async () => {
      await page.locator('input[type="file"]').setInputFiles(FIXTURE);
      await expect(importing.first()).toBeVisible();
      await expect(importing).toHaveCount(0, { timeout: UPLOAD_TIMEOUT_MS });
      await expect(importError, "import must fail with a bogus model, not succeed").toBeVisible();
      const text = (await importError.innerText()).trim();
      console.log(`[ops] ${text}`);
      expect(text).toMatch(/^Import failed: classify failed: /);
    });

    const batch = await withTestDb((db) =>
      db.ideaBatch.findFirstOrThrow({ where: { workspaceId }, orderBy: { startedAt: "desc" } })
    );
    const stages = ((batch.trace as unknown as { stages: Stage[] } | null)?.stages ?? []);
    console.log(
      `[ops] batch ${batch.id} ${batch.status} · ${stages.map((s) => `${s.stage}${s.calls ? `(${s.calls})` : ""}${s.error ? "!" : ""}`).join(" ")} · ${batch.error}`
    );

    await test.step("batch row is failed, names the stage, and the trace stops there", async () => {
      expect(batch.status).toBe("failed");
      expect(batch.error).toMatch(/^classify failed: /);
      expect(batch.completedAt).not.toBeNull();
      const names = stages.map((s) => s.stage);
      for (const s of ["dedupe", "jira-fetch", "prepare", "parse", "classify"]) {
        expect(names, `stage ${s} present`).toContain(s);
      }
      const classify = stages.find((s) => s.stage === "classify")!;
      expect(classify.error, "classify stage carries the error").toBeTruthy();
      for (const s of stages) {
        if (s.stage !== "classify" && s.stage !== "prewarm") {
          expect(s.error, `stage ${s.stage} has no error`).toBeUndefined();
        }
      }
      for (const s of ["split", "match", "customers", "jira-sync", "write"]) {
        expect(names, `stage ${s} never ran`).not.toContain(s);
      }
    });

    await test.step("nothing written: zero tickets, zero ideas, no catalog rows beyond the built-in", async () => {
      const [tickets, ideas, customers] = await withTestDb((db) =>
        Promise.all([
          db.zendeskTicketRaw.count({ where: { workspaceId } }),
          db.idea.count({ where: { workspaceId } }),
          db.customer.findMany({ where: { workspaceId }, select: { name: true } }),
        ])
      );
      expect(tickets).toBe(0);
      expect(ideas).toBe(0);
      expect(customers.map((c) => c.name).filter((n) => n !== ALL_CUSTOMERS)).toEqual([]);
      await page.reload();
      await expect(page.getByText("No ideas yet")).toBeVisible();
      const res = await page.request.get("/api/ideas");
      expect(res.status()).toBe(200);
      const state = (await res.json()) as { ideas: unknown[]; tickets: unknown[] };
      expect(state.ideas).toHaveLength(0);
      expect(state.tickets).toHaveLength(0);
    });

    await test.step("ledger keeps exactly the verdicts paid for before the failure", async () => {
      const rows = await withTestDb((db) =>
        db.ledgerEntry.findMany({ where: { workspaceId }, select: { stage: true, model: true } })
      );
      const paidCalls = stages
        .filter((s) => s.kind === "ai" && !s.error && s.stage !== "prewarm")
        .reduce((n, s) => n + (s.calls ?? 0), 0);
      console.log(`[ops] ledger rows ${rows.length} · paid calls ${paidCalls} · stages ${Array.from(new Set(rows.map((r) => r.stage))).join(",") || "—"}`);
      expect(rows.length).toBe(paidCalls);
      for (const r of rows) expect(r.model, "no verdict recorded against the bogus model").not.toBe(OPS_BOGUS_MODEL);
    });
  });
});
