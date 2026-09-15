import { expect, test } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { loginAsRoomLensAdmin, withTestDb } from "./helpers";
import { ensureWindowHeadroom, submitTwoFactorCode, totpFor } from "./two-factor-helpers";
import { LOCAL_BASE_URL } from "./test-env";

/**
 * PM-OS Admin — onboarding, CSV mapping, import runs (release QA 2.0.0,
 * inventory ADM-02 / ADM-08 / ADM-09). Written against origin/development
 * 22b1799; the Admin pages are outside feature/face_lift_v2's scope.
 *
 * ADM-02 onboard a new organization end to end — the exact path Kela went
 *        through: Admin → Users → Add user → "+ Create new organization…" →
 *        the org, its workspace and the invite-pending user exist → the
 *        admin enables Ideas for the org (per-org override, as in
 *        Enablements; the off modules stay off = prod parity) → the invitee
 *        opens the invite link, signs up with credentials, enrolls in 2FA
 *        and lands in that org's EMPTY Ideas ("No ideas yet"). The invite
 *        token is inserted exactly as issuePasswordToken stores it (no SMTP
 *        in the test env — admin-delete-user-org AD2 proves the mail path).
 * ADM-08 CSV import mapping + re-apply: Kela-style aliases saved through
 *        the admin config API, raw ticket rows seeded as an import stores
 *        them, "Re-apply mapping" (POST …/ideas-config/remap) fills module /
 *        customerName / whyBuild / insights / dealRelated / customerType /
 *        url from the raw rows, adds the truth customer to the catalog, and
 *        leaves the AI verdict (catalogKind/catalogReason) untouched. The
 *        ticket drawer half of the case is v2-territory — asserted from the
 *        DB and the /api/ideas state instead.
 * ADM-09 Import runs: four seeded batches — completed / failed with a stage
 *        error / running with a fresh heartbeat / running with a 3-minute-old
 *        heartbeat — render as Completed / Failed / Running / Stale; the
 *        completed row expands into the per-stage table; while a run is
 *        live the card polls, so a batch that finishes in the DB flips
 *        without Refresh. (Empty state, Refresh and the USER→404 API rule
 *        are ui-facelift UF4's — not repeated here.)
 *
 * Fixtures: ADM-02 creates org "QA-ONB Kela-Like Org" + qa+onb-* users
 * through the product; ADM-08/09 use "QA-ADM Remap Org" created via the
 * admin API (no users). All removed in beforeAll + afterAll.
 */

const ONB_ORG = "QA-ONB Kela-Like Org";
const ONB_INVITEE = { name: "QA Onboard Invitee", email: "qa+onb-invitee@pm-os.io" };
const ONB_PASSWORD = "Onboard-pass1"; // policy-valid: 8+, lower, upper, digit, symbol
const ADM_ORG = "QA-ADM Remap Org";

const KELA_MAPPING = {
  module: ["kela module"],
  customerName: ["kela customer"],
  whyBuild: ["why build"],
  insights: ["insights we have"],
  dealRelated: ["deal"],
  customerType: ["cust type"],
  url: ["ticket link"],
};
const RAW_ROWS = [
  {
    externalId: "QA-ADM-T1",
    raw: {
      "Ticket ID": "QA-ADM-T1", Subject: "Detection tuning per tenant", Description: "QA-ADM fixture body one.",
      "Kela Module": "Detection", "Kela Customer": "QA-ADM Acme Corp", "Why Build": "Three tenants asked",
      "Insights We Have": "Seen in 4 tickets", Deal: "Yes", "Cust Type": "POC", "Ticket Link": "https://kela.example/tickets/1",
    },
  },
  {
    externalId: "QA-ADM-T2",
    raw: {
      "Ticket ID": "QA-ADM-T2", Subject: "Export alerts to CSV", Description: "QA-ADM fixture body two.",
      "Kela Module": "Reporting", "Kela Customer": "QA-ADM Acme Corp", "Why Build": "Compliance ask",
      "Insights We Have": "Recurring in QBRs", Deal: "No", "Cust Type": "Customer", "Ticket Link": "not a url",
    },
  },
];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function cleanup(db: PrismaClient): Promise<void> {
  await db.user.deleteMany({
    where: { OR: [{ email: { startsWith: "qa+onb-" } }, { organization: { name: { in: [ONB_ORG, ADM_ORG] } } }] },
  });
  await db.organization.deleteMany({ where: { name: { in: [ONB_ORG, ADM_ORG] } } });
}

test.describe("PM-OS Admin: onboarding, CSV mapping, import runs (ADM-02, ADM-08, ADM-09)", () => {
  test.beforeAll(async () => {
    await withTestDb(cleanup);
  });
  test.afterAll(async () => {
    await withTestDb(cleanup);
  });

  test("ADM-02 onboard a new organization: Add user + new org → enable Ideas → invite → sign-up → 2FA enrollment → empty Ideas", async ({
    page,
    browser,
  }) => {
    // Admin TOTP login + the invitee's enrollment (each may wait for TOTP headroom).
    test.setTimeout(150_000);

    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();

    await page.getByRole("button", { name: "Add user" }).click();
    await expect(page.getByRole("heading", { name: "Add a user" })).toBeVisible();
    await page.getByPlaceholder("Jane Doe").fill(ONB_INVITEE.name);
    await page.getByPlaceholder("jane@company.com").fill(ONB_INVITEE.email);
    await page.locator("select").selectOption({ label: "+ Create new organization…" });
    await page.getByPlaceholder("Acme Inc.").fill(ONB_ORG);
    await page.locator("form", { has: page.getByPlaceholder("Acme Inc.") }).locator('button[type="submit"]').click();

    // The org card appears with the invitee pending.
    const card = page.locator("div.rounded-xl").filter({ has: page.locator("p.font-semibold", { hasText: ONB_ORG }) });
    await expect(card).toBeVisible();
    const row = card.locator("tr", { hasText: ONB_INVITEE.email });
    await expect(row.getByText("Invite pending", { exact: true })).toBeVisible();

    // Org + workspace + user exist, the user has no password yet.
    const seeded = await withTestDb(async (db) => {
      const org = await db.organization.findFirstOrThrow({ where: { name: ONB_ORG }, include: { workspace: true } });
      const user = await db.user.findUniqueOrThrow({ where: { email: ONB_INVITEE.email } });
      return { org, user };
    });
    expect(seeded.org.workspace, "workspace created with the org").not.toBeNull();
    expect(seeded.user.organizationId).toBe(seeded.org.id);
    expect(seeded.user.passwordHash).toBeNull();
    expect(seeded.user.totpEnabledAt).toBeNull();

    // Admin enables Ideas for the new org (prod parity: the off modules stay off).
    const enable = await page.request.patch(`/api/admin/organizations/${seeded.org.id}`, {
      data: { features: { ideas: true, dashboard: false, docs: false, chat: false } },
    });
    expect(enable.status(), await enable.text()).toBe(200);

    // Invite link — the token row exactly as issuePasswordToken stores it.
    const inviteToken = await withTestDb(async (db) => {
      const raw = randomBytes(32).toString("base64url");
      await db.passwordResetToken.create({
        data: { userId: seeded.user.id, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      });
      return raw;
    });

    const inviteeContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const invitee = await inviteeContext.newPage();
    try {
      await invitee.goto(`/invite?token=${inviteToken}`);
      await expect(invitee.getByRole("heading", { name: "Complete your sign-up" })).toBeVisible();
      await expect(invitee.getByText(ONB_ORG, { exact: true })).toBeVisible();
      await invitee.getByRole("link", { name: "Sign Up with Credentials" }).click();
      await invitee.waitForURL(/\/reset-password\?/);
      await invitee.locator("#new-password").fill(ONB_PASSWORD);
      await invitee.locator("#confirm-password").fill(ONB_PASSWORD);
      await invitee.getByRole("button", { name: "Set password" }).click();

      // Mandatory 2FA: first login is an enrollment.
      await invitee.waitForURL(/\/login\/2fa/);
      await expect(invitee.getByRole("heading", { name: "Set up two-factor" })).toBeVisible();
      const secret = (await invitee.locator("span.font-mono").innerText()).trim();
      expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
      await ensureWindowHeadroom(8_000);
      await submitTwoFactorCode(invitee, totpFor(secret).generate());

      // Lands in the new org's empty Ideas.
      await invitee.waitForURL(/\/ideas/);
      await expect(invitee.getByRole("heading", { name: "Ideas" })).toBeVisible();
      await expect(invitee.getByText("No ideas yet")).toBeVisible();
      const state = await (await invitee.request.get("/api/ideas")).json();
      expect(state.ideas).toEqual([]);
      expect(state.tickets).toEqual([]);
      const me = await invitee.request.get("/api/auth/me");
      expect(me.status()).toBe(200);
    } finally {
      await inviteeContext.close();
    }

    const activated = await withTestDb((db) => db.user.findUniqueOrThrow({ where: { email: ONB_INVITEE.email } }));
    expect(activated.passwordHash).not.toBeNull();
    expect(activated.totpEnabledAt).not.toBeNull();
    await page.reload();
    await expect(card.locator("tr", { hasText: ONB_INVITEE.email }).getByText("Password", { exact: true })).toBeVisible();
  });

  test("ADM-08 CSV import mapping saved per org and re-applied to raw ticket rows; AI verdicts untouched", async ({ page }) => {
    await loginAsRoomLensAdmin(page);

    const created = await page.request.post("/api/admin/organizations", { data: { name: ADM_ORG } });
    expect(created.status(), await created.text()).toBe(201);
    const orgId = (await created.json()).organization.id as string;
    const workspaceId = (await withTestDb((db) => db.workspace.findUniqueOrThrow({ where: { organizationId: orgId } }))).id;

    // Raw rows as an import persists them under the DEFAULT mapping: the Kela
    // columns were not recognised, so the mapped params are empty.
    await withTestDb((db) =>
      db.zendeskTicketRaw.createMany({
        data: RAW_ROWS.map((r) => ({
          workspaceId, externalId: r.externalId, subject: r.raw.Subject, body: r.raw.Description,
          raw: r.raw, catalogKind: "fr", catalogReason: "QA-ADM fixture verdict",
        })),
      })
    );

    const saved = await page.request.put(`/api/admin/organizations/${orgId}/ideas-config`, {
      data: { csv: KELA_MAPPING },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const config = (await saved.json()).config as { csv: Record<string, string[]> };
    for (const [param, aliases] of Object.entries(KELA_MAPPING)) expect(config.csv[param]).toEqual(aliases);
    expect(config.csv.subject, "unmapped params keep their defaults").toContain("subject");
    const stored = await withTestDb((db) => db.workspace.findUniqueOrThrow({ where: { id: workspaceId } }));
    expect((stored.ideasConfig as { csv: Record<string, string[]> }).csv.module).toEqual(KELA_MAPPING.module);

    const remap = await page.request.post(`/api/admin/organizations/${orgId}/ideas-config/remap`);
    expect(remap.status(), await remap.text()).toBe(200);
    expect(await remap.json()).toEqual({ updated: RAW_ROWS.length, customersAdded: 1 });

    const tickets = await withTestDb((db) =>
      db.zendeskTicketRaw.findMany({ where: { workspaceId }, orderBy: { externalId: "asc" } })
    );
    expect(tickets.map((t) => ({
      module: t.module, customerName: t.customerName, whyBuild: t.whyBuild, insights: t.insights,
      dealRelated: t.dealRelated, customerType: t.customerType, url: t.url,
      kind: t.catalogKind, reason: t.catalogReason, customers: t.affectedCustomers,
    }))).toEqual([
      { module: "Detection", customerName: "QA-ADM Acme Corp", whyBuild: "Three tenants asked", insights: "Seen in 4 tickets",
        dealRelated: "Yes", customerType: "POC", url: "https://kela.example/tickets/1",
        kind: "fr", reason: "QA-ADM fixture verdict", customers: ["QA-ADM Acme Corp"] },
      { module: "Reporting", customerName: "QA-ADM Acme Corp", whyBuild: "Compliance ask", insights: "Recurring in QBRs",
        dealRelated: "No", customerType: "Customer", url: null, // "not a url" is dropped, never rendered
        kind: "fr", reason: "QA-ADM fixture verdict", customers: ["QA-ADM Acme Corp"] },
    ]);
    const customers = await withTestDb((db) => db.customer.findMany({ where: { workspaceId } }));
    expect(customers.map((c) => c.name)).toEqual(["QA-ADM Acme Corp"]);
  });

  test("ADM-09 Import runs: Completed / Failed / Running / Stale chips, stage table on expand, live poll flips a finished run", async ({ page }) => {
    await loginAsRoomLensAdmin(page);
    const org = await withTestDb((db) =>
      db.organization.findFirstOrThrow({ where: { name: ADM_ORG }, include: { workspace: true } })
    );
    const workspaceId = org.workspace!.id;
    const now = Date.now();
    const stage = (name: string, kind: string, calls?: number, error?: string) => ({
      stage: name, kind, startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now - 50_000).toISOString(),
      ms: 10_000, items: 3, ...(calls !== undefined ? { calls } : {}), ...(error ? { error } : {}),
      ...(kind === "ai" ? { tokens: { input: 3000, output: 400, cacheRead: 2400, cacheWrite: 0, thinking: 0 }, model: "qa-model" } : {}),
    });
    const trace = (stages: unknown[]) => ({ version: 1, pid: 1, serverBootedAt: new Date(now - 600_000).toISOString(), uploaded: 3, fresh: 3, stages });
    const runningId = await withTestDb(async (db) => {
      await db.ideaBatch.deleteMany({ where: { workspaceId } });
      await db.ideaBatch.create({ data: {
        workspaceId, status: "completed", startedAt: new Date(now - 240_000), completedAt: new Date(now - 200_000),
        heartbeatAt: new Date(now - 200_000), stats: { imported: 3, frs: 2, matched: 0, split: 0, bugs: 1, needsDetails: 0 },
        trace: trace([stage("dedupe", "db"), stage("classify", "ai", 3), stage("match", "ai", 2), stage("write", "db")]),
      } });
      await db.ideaBatch.create({ data: {
        workspaceId, status: "failed", startedAt: new Date(now - 180_000), completedAt: new Date(now - 170_000),
        heartbeatAt: new Date(now - 170_000), error: "classify: QA boom",
        trace: trace([stage("dedupe", "db"), stage("classify", "ai", 1, "QA boom")]),
      } });
      await db.ideaBatch.create({ data: {
        workspaceId, status: "running", startedAt: new Date(now - 300_000), heartbeatAt: new Date(now - 3 * 60_000),
        trace: trace([stage("dedupe", "db"), stage("classify", "ai", 1)]),
      } });
      const running = await db.ideaBatch.create({ data: {
        workspaceId, status: "running", startedAt: new Date(now - 20_000), heartbeatAt: new Date(now),
        trace: trace([stage("dedupe", "db")]),
      } });
      return running.id;
    });

    await page.goto("/admin/ideas");
    const runsCard = page.locator("section", { has: page.getByRole("heading", { name: "Import runs" }) });
    await expect(runsCard).toBeVisible();
    // Hydration anchor before touching the <select> (UF4's lesson).
    await expect(
      runsCard.locator("tbody tr").or(runsCard.getByText("No imports yet for this organization.")).first()
    ).toBeVisible();
    await page.locator("select").first().selectOption({ label: `${org.name} (${org.slug})` });

    for (const chip of ["Completed", "Failed", "Running", "Stale — no heartbeat"]) {
      await expect(runsCard.getByText(chip, { exact: true }), `${chip} chip`).toHaveCount(1);
    }
    await expect(runsCard.getByText("classify: QA boom")).toBeVisible();

    // Expand the completed run → stage table.
    // `has:` locators are page-rooted (a card-rooted one never matches — the
    // ui-facelift "has rooting" trap). The row itself carries aria-expanded.
    const completedRow = runsCard.locator("tr[aria-expanded]", { has: page.getByText("Completed", { exact: true }) });
    await expect(completedRow).toHaveAttribute("aria-expanded", "false");
    await completedRow.click();
    await expect(completedRow).toHaveAttribute("aria-expanded", "true");
    // The stage table is nested inside the expanded row of the runs table.
    const stageTable = runsCard.locator("table table");
    await expect(stageTable).toBeVisible();
    for (const name of ["dedupe", "classify", "match", "write"]) {
      await expect(stageTable.locator("tr", { hasText: name }).first()).toBeVisible();
    }

    // Live poll: the fresh running batch completes in the DB → chip flips without Refresh.
    await withTestDb((db) =>
      db.ideaBatch.update({
        where: { id: runningId },
        data: { status: "completed", completedAt: new Date(), heartbeatAt: new Date(), stats: { imported: 1, frs: 1, matched: 0, split: 0, bugs: 0, needsDetails: 0 } },
      })
    );
    await expect(runsCard.getByText("Running", { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await expect(runsCard.getByText("Completed", { exact: true })).toHaveCount(2);
  });
});
