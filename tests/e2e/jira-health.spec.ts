/**
 * Jira health → Ideas banner + import-without-Jira dialog — release QA
 * 4.0.0 version test (PSH-11). Feature: feature/fixes_for_ideas_usage_by_kela
 * (Jira connection lifecycle: PM-OS owns the connection, the customer only
 * sees a status and a support address).
 *
 * PSH-11 with the org flag "jira" on, every unhealthy state shows the amber
 *        banner on /ideas with the support copy, /api/jira/health reports the
 *        same status, and a CSV import first asks "Import without Jira"
 *        (Cancel = no batch, nothing imported):
 *          - no JiraConnection row            → not_connected
 *          - row without a PM-OS user token    → unavailable (legacy/empty)
 *          - row whose API token has expired   → unavailable (expired on …)
 *        With the flag off the banner is gone and the API says enabled=false.
 *        not_configured (healthy probe, no project) needs a live Jira and is
 *        covered by ADM-16 / manual on the TEST project.
 *
 * State: RoomLens gets {ideas: true, jira: true} for the test and {} back;
 * the QA-JH connection row is delete-and-recreate + cleanup; the alert
 * columns (Workspace.jiraAlertedAt/Since) are cleared after.
 */
import { expect, test } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, withTestDb } from "./helpers";

const ROOMLENS_SLUG = "roomlens";
const VALID_CSV = "external_id,subject,description\nQA-JH-1,QA-JH hello,QA-JH a ticket body that is long enough\n";

let orgId: string;
let workspaceId: string;

async function reset(db: PrismaClient): Promise<void> {
  await db.jiraConnection.deleteMany({ where: { workspaceId } });
  await db.workspace.update({ where: { id: workspaceId }, data: { jiraAlertedAt: null, jiraAlertedSince: null } });
}

async function setFeatures(features: Record<string, boolean>): Promise<void> {
  await withTestDb((db) => db.organization.update({ where: { id: orgId }, data: { features } }));
}

test.describe("Jira health banner + import without Jira (PSH-11)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const org = await db.organization.findUniqueOrThrow({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } });
      orgId = org.id;
      workspaceId = org.workspace!.id;
      await reset(db);
    });
    await setFeatures({ ideas: true, jira: true });
  });
  test.afterAll(async () => {
    await withTestDb(reset);
    await setFeatures({});
  });

  test("PSH-11 not connected / no token / expired token show the banner and gate the import; flag off hides it", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsRoomLens(page);

    const health = async () => {
      const res = await page.request.get("/api/jira/health?fresh=1");
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()) as { enabled: boolean; status: string; cause?: string };
    };
    const batches = () => withTestDb((db) => db.ideaBatch.count({ where: { workspaceId } }));

    // 1. No connection row.
    expect(await health()).toMatchObject({ enabled: true, status: "not_connected" });
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    await expect(page.getByText("Jira is not connected for your organization")).toBeVisible();

    const before = await batches();
    await page.locator('input[type="file"]').setInputFiles({ name: "qa-jh.csv", mimeType: "text/csv", buffer: Buffer.from(VALID_CSV) });
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Jira is not connected" })).toBeVisible();
    await expect(dialog.getByText("You can import Zendesk only")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Import without Jira" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Importing…" })).toHaveCount(0);
    expect(await batches(), "Cancel imports nothing").toBe(before);

    // 2. A row without a PM-OS user token (legacy / emptied).
    await withTestDb((db) =>
      db.jiraConnection.create({
        data: {
          workspaceId, cloudId: "qa-jh-cloud", siteUrl: "https://qa-jh.atlassian.net", accessToken: "", refreshToken: "",
          expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000), authType: "basic", projectKeys: JSON.stringify(["QAJH"]),
        },
      }),
    );
    let h = await health();
    expect(h.status).toBe("unavailable");
    expect(h.cause).toContain("No PM-OS user token");
    await page.goto("/ideas");
    await expect(page.getByText("Jira is temporarily unavailable — imports will not match")).toBeVisible();
    await expect(page.getByText("Jira is not connected for your organization")).toHaveCount(0);

    // 3. A token that has expired — no probe, the date is the cause.
    await withTestDb((db) =>
      db.jiraConnection.update({
        where: { workspaceId },
        data: { accessToken: "enc:qa-jh-sealed", apiTokenExpiresAt: new Date("2026-01-31T00:00:00Z") },
      }),
    );
    h = await health();
    expect(h.status).toBe("unavailable");
    expect(h.cause).toContain("expired on 2026-01-31");
    await page.goto("/ideas");
    await expect(page.getByText("Jira is temporarily unavailable — imports will not match")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: "qa-jh.csv", mimeType: "text/csv", buffer: Buffer.from(VALID_CSV) });
    await expect(dialog.getByRole("heading", { name: "Jira is unavailable" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await batches()).toBe(before);

    // 4. Flag off: no Jira expected → no banner, no dialog gate.
    await setFeatures({ ideas: true, jira: false });
    h = await health();
    expect(h.enabled).toBe(false);
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    await expect(page.getByText("Jira is temporarily unavailable — imports will not match")).toHaveCount(0);
    await expect(page.getByText("Jira is not connected for your organization")).toHaveCount(0);
  });
});
