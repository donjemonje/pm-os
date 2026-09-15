import { expect, test } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginWithTotp, QA_USER, seedQaOrgWithUser, withTestDb } from "./helpers";
import { TEST_TOTP_SECRET } from "./two-factor-helpers";

/**
 * Gating + isolation (release QA 2.0.0, inventory GATE-02 / GATE-06 / XC-02).
 * Written against origin/development 22b1799; nothing here renders the Ideas
 * list beyond an idea title, so feature/face_lift_v2 cannot break it.
 *
 * GATE-02 off modules are gone: with the prod-parity org flags (Ideas on;
 *         dashboard / docs / chat off — set as the per-org override, the same
 *         mechanism Admin → Enablements uses, because the suite's env pins
 *         those three ON for all-pages/A2), the pages /dashboard, /chat,
 *         /docs, /docs/new, /releases 404, their APIs 404, the sidebar shows
 *         no link to them, and Ideas + Settings remain. Google Drive counts
 *         as non-existent too (Daniel 2026-09-13): /settings/google-drive and
 *         /api/google-drive/status are asserted 404 as well.
 * GATE-06 organization isolation: a second QA org (own TOTP user) with its
 *         own idea / ticket / customer / product line / batch sees only its
 *         data on /api/ideas, /api/ideas/lists/*, and /ideas; RoomLens ids
 *         passed to mutate / lists / ideas-runs never change RoomLens rows
 *         and never return RoomLens data. (Inventory says "A's ids → 404";
 *         mutate today answers 200 with the caller's own state — a silent
 *         no-op, no leak. Both are accepted here; the invariant asserted is
 *         no cross-org write and no cross-org read.)
 * XC-02   anonymous API sweep: every /api/ideas/*, /api/jira/*, /api/admin/*
 *         and /api/auth/me route answers 401 (or 404 where the org feature
 *         gate runs before auth) with an { error } body only — never data.
 *         Limit: with IDEAS_ENABLED off in the test env every /api/ideas/*
 *         route 404s before auth for an anonymous caller, so this sweep
 *         cannot tell "auth removed" from "flag off" on those routes.
 *
 * State: GATE-02 sets the RoomLens override and restores {} after; GATE-06
 * seeds QA-ISO fixtures in RoomLens and its own org, both removed in
 * afterAll. Rerunnable without reseed.
 */

const ROOMLENS_SLUG = "roomlens";
const PROD_PARITY = { ideas: true, dashboard: false, docs: false, chat: false };

const ORG_B = { orgName: "QA-ISO Org B", slug: "qa-iso-org-b" };
const USER_B = {
  name: "QA ISO User B",
  email: "qa+iso-b@pm-os.io",
  password: "Iso-b-qa-pass1",
  totpSecret: "MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK", // synthetic, test-only
};
const A = {
  line: "QA-ISO A Line", customer: "QA-ISO A Customer", ticket: "QA-ISO-A-T1", idea: "QA-ISO A idea",
};
const B = {
  line: "QA-ISO B Line", customer: "QA-ISO B Customer", ticket: "QA-ISO-B-T1", idea: "QA-ISO B idea",
};

let roomlensOrgId: string;
let roomlensWorkspaceId: string;
let bWorkspaceId: string;
let aIds: { idea: string; line: string; ticket: string; customer: string };

async function seedIdeaSet(
  db: PrismaClient,
  workspaceId: string,
  names: typeof A,
): Promise<{ idea: string; line: string; ticket: string; customer: string }> {
  const line = await db.productLine.create({
    data: { workspaceId, name: names.line, description: "QA-ISO fixture" },
  });
  const customer = await db.customer.create({ data: { workspaceId, name: names.customer, description: "QA-ISO fixture" } });
  const ticket = await db.zendeskTicketRaw.create({
    data: {
      workspaceId, externalId: names.ticket, subject: names.idea, body: "QA-ISO fixture ticket.",
      requester: "QA ISO Reporter", affectedCustomers: [names.customer], tags: ["qa-iso"], raw: {},
      catalogKind: "fr", catalogReason: "QA-ISO fixture verdict",
    },
  });
  const idea = await db.idea.create({
    data: {
      workspaceId, title: names.idea, details: "QA-ISO fixture idea.", products: [names.line],
      batchStatus: "new", decision: "pending", origin: "zendesk", newVotes: 1,
      sources: { create: [{ kind: "zendesk", ticketId: ticket.id }] },
    },
  });
  await db.ideaBatch.create({
    data: { workspaceId, status: "completed", completedAt: new Date(), stats: { imported: 1 } },
  });
  return { idea: idea.id, line: line.id, ticket: ticket.id, customer: customer.id };
}

async function deleteIsoFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({ where: { title: { startsWith: "QA-ISO " } } });
  await db.zendeskTicketRaw.deleteMany({ where: { externalId: { startsWith: "QA-ISO-" } } });
  await db.customer.deleteMany({ where: { name: { startsWith: "QA-ISO " } } });
  await db.productLine.deleteMany({ where: { name: { startsWith: "QA-ISO " } } });
  await db.ideaBatch.deleteMany({ where: { workspaceId: roomlensWorkspaceId, stats: { equals: { imported: 1 } } } });
  await db.user.deleteMany({ where: { OR: [{ email: USER_B.email }, { organization: { slug: ORG_B.slug } }] } });
  await db.organization.deleteMany({ where: { slug: ORG_B.slug } });
}

test.describe("Gating and isolation (GATE-02, GATE-06, XC-02)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const org = await db.organization.findUniqueOrThrow({
        where: { slug: ROOMLENS_SLUG }, include: { workspace: true },
      });
      roomlensOrgId = org.id;
      roomlensWorkspaceId = org.workspace!.id;
      await deleteIsoFixtures(db);
      const b = await seedQaOrgWithUser(db, { ...ORG_B, features: PROD_PARITY, user: USER_B });
      bWorkspaceId = b.workspaceId;
      aIds = await seedIdeaSet(db, roomlensWorkspaceId, A);
      await seedIdeaSet(db, bWorkspaceId, B);
    });
  });

  test.afterAll(async () => {
    await withTestDb(async (db) => {
      await deleteIsoFixtures(db);
      await db.organization.update({ where: { id: roomlensOrgId }, data: { features: {} } });
    });
  });

  test("GATE-02 off modules: pages and APIs 404 under prod-parity flags, sidebar shows only Ideas and Settings", async ({
    page,
  }) => {
    await withTestDb((db) =>
      db.organization.update({ where: { id: roomlensOrgId }, data: { features: PROD_PARITY } })
    );
    try {
      await loginWithTotp(page, { ...QA_USER, totpSecret: TEST_TOTP_SECRET });
      await expect(page).toHaveURL(/\/ideas/);

      // Soft: a sweep should report every off surface in one run, not stop
      // at the first one that still renders (the test still fails).
      for (const path of ["/chat", "/docs", "/docs/new", "/releases", "/settings/google-drive"]) {
        await page.goto(path);
        await expect.soft(page.getByText("This page could not be found"), `${path} is gone`).toBeVisible();
      }
      // /dashboard is the landing route: with the dashboard off it forwards to
      // the first ON surface instead of 404-ing (admin-delete-user-org AD4,
      // signed off 2026-09-03) — never renders the dashboard.
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/ideas/);
      await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
      for (const path of ["/api/chat/sessions", "/api/documents", "/api/releases", "/api/google-drive/status"]) {
        const res = await page.request.get(path);
        expect.soft(res.status(), `${path} is gone`).toBe(404);
      }

      await page.goto("/ideas");
      const aside = page.locator("aside");
      await expect(aside).toBeVisible();
      await expect(aside.locator('a[href="/ideas"]')).toHaveCount(1);
      await expect(aside.locator('a[href^="/settings"]')).toHaveCount(1);
      for (const href of ["/dashboard", "/docs", "/chat", "/settings/google-drive"]) {
        await expect.soft(aside.locator(`a[href="${href}"]`), `no sidebar link to ${href}`).toHaveCount(0);
      }
      // "/" follows the same order: with only Ideas on it lands on /ideas.
      await page.goto("/");
      await expect(page).toHaveURL(/\/ideas/);
    } finally {
      await withTestDb((db) =>
        db.organization.update({ where: { id: roomlensOrgId }, data: { features: {} } })
      );
    }
  });

  test("GATE-06 organization isolation: org B sees only its data; RoomLens ids never read or write across", async ({
    page,
  }) => {
    await loginWithTotp(page, USER_B);
    await expect(page).toHaveURL(/\/ideas/);

    // Reads: only B's rows, counts match B alone.
    const state = (await (await page.request.get("/api/ideas")).json()) as {
      ideas: { id: string; title: string }[];
      tickets: { id: string }[];
      customerCatalog: string[];
    };
    expect(state.ideas.map((i) => i.title)).toEqual([B.idea]);
    expect(state.tickets).toHaveLength(1);
    expect(state.customerCatalog).toContain(B.customer);
    expect(state.customerCatalog).not.toContain(A.customer);
    const lines = (await (await page.request.get("/api/ideas/lists/product-lines")).json()) as {
      items: { id: string; name: string }[];
    };
    expect(lines.items.map((l) => l.name)).toEqual([B.line]);
    await expect(page.getByText(B.idea, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(A.idea, { exact: true })).toHaveCount(0);

    // Writes with A's ids: refused or no-op, never a cross-org change, never A's data back.
    const before = await withTestDb((db) =>
      db.idea.findUniqueOrThrow({ where: { id: aIds.idea } })
    );
    for (const mutation of [
      { type: "decision", ideaId: aIds.idea, decision: "reviewed" },
      { type: "edit", ideaId: aIds.idea, title: "QA-ISO HACKED" },
      { type: "reassign", ideaId: aIds.idea, zen: [], jira: [] },
    ]) {
      const res = await page.request.post("/api/ideas/mutate", { data: mutation });
      expect([200, 404], `${mutation.type} with A's idea id → ${res.status()}`).toContain(res.status());
      if (res.status() === 200) {
        const body = (await res.json()) as { state: { ideas: { id: string }[] } };
        expect(body.state.ideas.some((i) => i.id === aIds.idea), "A's idea leaked into B's state").toBe(false);
      }
    }
    const after = await withTestDb((db) => db.idea.findUniqueOrThrow({ where: { id: aIds.idea } }));
    expect(after.decision).toBe(before.decision);
    expect(after.title).toBe(before.title);
    expect(after.newVotes).toBe(before.newVotes);
    expect(
      await withTestDb((db) => db.ideaSource.count({ where: { ideaId: aIds.idea } })),
      "A's sources untouched"
    ).toBe(1);

    // Lists: a plain USER may write customers and pick any chip color (product
    // line writes are admin-only, 403 before any lookup — SET-01), so the
    // isolation probe uses A's customer id and a color pick on A's line.
    const del = await page.request.delete("/api/ideas/lists/customers", { data: { id: aIds.customer } });
    expect(del.status(), await del.text()).toBe(404);
    const rename = await page.request.patch("/api/ideas/lists/customers", { data: { id: aIds.customer, name: "QA-ISO HACKED" } });
    expect(rename.status(), await rename.text()).toBe(404);
    // The app assigns a palette color to every product line on the org's own
    // first Ideas/Settings load, so A's line may already carry one — the
    // invariant is "unchanged by B's call", not "still null" (release-gate
    // run 2026-09-15 read "lime", auto-assigned earlier in the suite).
    const lineBefore = await withTestDb((db) => db.productLine.findUniqueOrThrow({ where: { id: aIds.line } }));
    const probeColor = lineBefore.color === "teal" ? "lime" : "teal";
    const color = await page.request.patch("/api/ideas/lists/product-lines", { data: { id: aIds.line, color: probeColor } });
    expect(color.status(), await color.text()).toBe(404);
    expect((await withTestDb((db) => db.customer.findUniqueOrThrow({ where: { id: aIds.customer } }))).name).toBe(A.customer);
    expect((await withTestDb((db) => db.productLine.findUniqueOrThrow({ where: { id: aIds.line } }))).color).toBe(lineBefore.color);

    // Admin-only history of another org: hidden, not forbidden.
    const runs = await page.request.get(`/api/admin/organizations/${roomlensOrgId}/ideas-runs`);
    expect(runs.status()).toBe(404);
  });

  test("XC-02 anonymous API sweep: ideas / jira / admin / me answer 401 or 404 with an error body only", async ({
    request,
  }) => {
    const ADMIN = [401];
    const IDEAS = [401, 404]; // 404 = org feature gate before auth (see header)
    const cases: [string, string, number[]][] = [
      ["GET", "/api/auth/me", [401]],
      ["GET", "/api/ideas", IDEAS], ["DELETE", "/api/ideas", IDEAS],
      ["POST", "/api/ideas/import", IDEAS], ["POST", "/api/ideas/mutate", IDEAS],
      ["GET", "/api/ideas/lists/product-lines", IDEAS], ["POST", "/api/ideas/lists/product-lines", IDEAS],
      ["PATCH", "/api/ideas/lists/product-lines", IDEAS], ["DELETE", "/api/ideas/lists/product-lines", IDEAS],
      ["PUT", "/api/ideas/lists/product-lines", IDEAS], ["GET", "/api/ideas/lists/customers", IDEAS],
      ["POST", "/api/ideas/lists/customers/merge", IDEAS],
      ["POST", "/api/ideas/preferences", IDEAS],
      ["POST", "/api/ideas/push", IDEAS], ["POST", "/api/ideas/undo", IDEAS],
      ["POST", "/api/jira/settings", [401]], ["GET", "/api/jira/projects", [401]],
      ["GET", "/api/jira/issue-types?project=QA", [401]], ["GET", "/api/jira/issues?projectKey=QA", [401]],
      // epics/versions validate the query before auth: without projectKey an
      // anonymous caller gets 400 { error: "projectKey required" } — no data,
      // but the auth path is only reached with the param present.
      ["GET", "/api/jira/epics?projectKey=QA", [401]], ["GET", "/api/jira/versions?projectKey=QA", [401]],
      ["POST", "/api/jira/aggregate", [401]], ["GET", "/api/jira/attachments/x", [401]],
      ["GET", "/api/admin/users", ADMIN], ["POST", "/api/admin/users", ADMIN],
      ["DELETE", "/api/admin/users/x", ADMIN], ["POST", "/api/admin/users/x/invite", ADMIN],
      ["GET", "/api/admin/organizations", ADMIN], ["POST", "/api/admin/organizations", ADMIN],
      ["PATCH", "/api/admin/organizations/x", ADMIN], ["DELETE", "/api/admin/organizations/x", ADMIN],
      ["PUT", "/api/admin/organizations/x/ideas-config", ADMIN],
      ["POST", "/api/admin/organizations/x/ideas-config/remap", ADMIN],
      ["GET", "/api/admin/organizations/x/ideas-runs", ADMIN],
      ["GET", "/api/ai/status", [401, 404]],
    ];
    const failures: string[] = [];
    for (const [method, path, expected] of cases) {
      const res = await request.fetch(path, { method, data: method === "GET" ? undefined : {} });
      const text = await res.text();
      let keys: string[] = [];
      try { keys = Object.keys(JSON.parse(text)); } catch { keys = text ? ["<non-json>"] : []; }
      const bodyOk = keys.every((k) => k === "error");
      if (!expected.includes(res.status()) || !bodyOk) {
        failures.push(`${method} ${path} → ${res.status()} body keys [${keys.join(",")}] (expected ${expected.join("|")})`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
