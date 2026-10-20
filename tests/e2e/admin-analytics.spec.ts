/**
 * Admin → Analytics + telemetry — release QA 4.0.0 version tests (ADM-17,
 * XC-05). Feature: feature/fixes_for_ideas_usage_by_kela.
 *
 * ADM-17 the Analytics screen for the picked org shows the totals cards,
 *        "What they changed" with the edit's action label, the correction
 *        table and the imports card; the JSON API counts the seeded events;
 *        the CSV export (the thing Daniel feeds to Claude) has the fixed
 *        header, the FULL text before/after of an edit — never a count —
 *        and the raw payload_json; non-admins get nothing.
 * XC-05  POST /api/track stores a batch under the caller's user + workspace
 *        with props kept as JSON, caps a batch at 100 events, rejects bad
 *        bodies with 400 and anonymous callers; events older than the
 *        retention window (90 days) are purged the next time an admin opens
 *        Analytics (the GET route sweeps before it counts).
 *
 * State: QA-AN fixtures (idea, review events, usage events) are
 * delete-and-recreate + cleanup on RoomLens.
 */
import { expect, test } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, loginAsRoomLensAdmin, QA_USER, selectAdminOrg, withTestDb } from "./helpers";
import { LOCAL_BASE_URL } from "./test-env";

const ROOMLENS_SLUG = "roomlens";
const IDEA = "QA-AN analytics idea";
const BEFORE_TEXT = "QA-AN the original idea text, long enough to prove the CSV carries full text and not a character count — line one.\nLine two with a comma, and a \"quote\".";
const AFTER_TEXT = "QA-AN the PM's rewritten text — also complete in the CSV.";
const SESSION = "qa-an-session";

let orgId: string;
let workspaceId: string;
let ideaId: string;

async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.usageEvent.deleteMany({ where: { workspaceId, sessionId: { startsWith: "qa-an-" } } });
  await db.idea.deleteMany({ where: { workspaceId, title: IDEA } }); // cascades its review events
}

test.describe("Admin analytics + telemetry (ADM-17, XC-05)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const org = await db.organization.findUniqueOrThrow({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } });
      orgId = org.id;
      workspaceId = org.workspace!.id;
      await deleteFixtures(db);
      const user = await db.user.findUniqueOrThrow({ where: { email: QA_USER.email } });
      ideaId = (
        await db.idea.create({
          data: {
            workspaceId, title: IDEA, details: AFTER_TEXT, products: ["QA-AN Line"], batchStatus: "new", decision: "reviewed",
            origin: "zendesk", newVotes: 1,
          },
        })
      ).id;
      await db.reviewEvent.createMany({
        data: [
          {
            workspaceId, ideaId, userId: user.id, action: "edit",
            payload: {
              before: { title: IDEA, details: BEFORE_TEXT, products: ["QA-AN Line"], addedCustomers: ["Nuvei"] },
              after: { title: IDEA, details: AFTER_TEXT, products: ["QA-AN Line"], addedCustomers: ["Nuvei", "Vital"] },
            },
          },
          { workspaceId, ideaId, userId: user.id, action: "approve", payload: {} },
        ],
      });
      await db.usageEvent.createMany({
        data: [
          { workspaceId, userId: user.id, sessionId: SESSION, event: "page_view", path: "/ideas" },
          { workspaceId, userId: user.id, sessionId: SESSION, event: "drawer_open", path: "/ideas", props: { ideaId } },
          { workspaceId, userId: user.id, sessionId: SESSION, event: "search", path: "/ideas", props: { query: "export" } },
          // Older than the retention window: the Analytics GET sweeps it.
          { workspaceId, userId: user.id, sessionId: "qa-an-old", event: "page_view", path: "/ideas", createdAt: new Date(Date.now() - 91 * 86_400_000) },
        ],
      });
    });
  });
  test.afterAll(async () => {
    await withTestDb(deleteFixtures);
  });

  test("ADM-17 Analytics screen, JSON counts and the full-ledger CSV with complete before/after text", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await loginAsRoomLensAdmin(page);
    await selectAdminOrg(page, orgId);

    await page.goto("/admin/analytics");
    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
    for (const label of ["Active users", "Ideas", "Decisions & edits", "Imports", "Behaviour events"]) {
      await expect(page.getByText(label, { exact: true }).first(), label).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "What they changed" })).toBeVisible();
    await expect(page.getByText("Edited (text / tags)").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Correction rate by product line" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Imports" })).toBeVisible();
    await expect(page.getByRole("link", { name: /CSV — full ledger/ })).toBeVisible();

    const json = await page.request.get(`/api/admin/analytics?org=${orgId}&days=30`);
    expect(json.status(), await json.text()).toBe(200);
    const data = (await json.json()) as {
      totals: { reviewEvents: number; usageEvents: number; sessions: number; activeUsers: number };
      decisions: { byAction: { key: string; n: number }[] };
      behaviour: { byEvent: { key: string; n: number }[]; searches: { key: string }[] };
      correction: { line: string; ideas: number; corrected: number; rate: number }[];
    };
    expect(await withTestDb((db) => db.usageEvent.count({ where: { sessionId: "qa-an-old" } })), "91-day-old event purged on open").toBe(0);
    expect(await withTestDb((db) => db.usageEvent.count({ where: { sessionId: SESSION } })), "fresh events kept").toBe(3);
    expect(data.totals.reviewEvents).toBeGreaterThanOrEqual(2);
    expect(data.totals.usageEvents).toBeGreaterThanOrEqual(3);
    expect(data.totals.sessions).toBeGreaterThanOrEqual(1);
    expect(data.decisions.byAction.map((a) => a.key)).toEqual(expect.arrayContaining(["edit", "approve"]));
    expect(data.behaviour.searches.map((s) => s.key)).toContain("export");
    const line = data.correction.find((c) => c.line === "QA-AN Line");
    expect(line).toMatchObject({ ideas: 1, corrected: 1, rate: 100 });

    // CSV: fixed header, full text before/after, payload_json — the artifact
    // Daniel hands to Claude, so completeness is the whole point.
    const csv = await page.request.get(`/api/admin/analytics/export?org=${orgId}&days=30`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(csv.headers()["content-disposition"]).toContain(`pmos-ledger-${orgId}-30d.csv`);
    const body = (await csv.text()).replace(/^﻿/, "");
    const [header] = body.split("\n");
    expect(header).toBe(
      "at,user,action,idea_id,idea_title_now,idea_products_now,idea_sources_now,idea_status_now,idea_decision_now,idea_origin," +
        "title_before,title_after,text_before,text_after,products_before,products_after," +
        "customers_added,customers_removed,sources_before,sources_after,customer_name,payload_json",
    );
    // The edit's text spans lines inside a quoted cell, so assert on the
    // whole body anchored by the row's fixed prefix (every cell is quoted).
    expect(body, "the edit event is in the export").toContain(`"edit","${ideaId}"`);
    expect(body).toContain("Line two with a comma");
    expect(body).toContain('""quote""'); // CSV-escaped, text intact
    expect(body).toContain(AFTER_TEXT);
    expect(body).toContain("Vital"); // customers_added
    expect(body).toContain('""before"":'); // payload_json present
    expect(body).not.toMatch(/,\d+ chars,/);

    // Non-admins get nothing from either endpoint.
    const userContext = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    const user = await userContext.newPage();
    try {
      await loginAsRoomLens(user);
      for (const path of [`/api/admin/analytics?org=${orgId}`, `/api/admin/analytics/export?org=${orgId}`]) {
        const res = await user.request.get(path);
        expect(res.status(), path).toBe(404);
      }
    } finally {
      await userContext.close();
    }
  });

  test("XC-05 /api/track stores a batch under the caller, keeps props, caps at 100, rejects bad bodies and anonymous calls", async ({ page, browser }) => {
    await loginAsRoomLens(page);
    const user = await withTestDb((db) => db.user.findUniqueOrThrow({ where: { email: QA_USER.email } }));

    const ok = await page.request.post("/api/track", {
      data: {
        sessionId: "qa-an-track",
        events: [
          { event: "page_view", path: "/ideas" },
          { event: "filter", path: "/ideas", props: { key: "status", value: "new" } },
        ],
      },
    });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, stored: 2 });
    const rows = await withTestDb((db) => db.usageEvent.findMany({ where: { workspaceId, sessionId: "qa-an-track" }, orderBy: { event: "asc" } }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.userId === user.id)).toBe(true);
    expect(rows.find((r) => r.event === "filter")?.props).toEqual({ key: "status", value: "new" });

    const big = await page.request.post("/api/track", {
      data: { sessionId: "qa-an-cap", events: Array.from({ length: 120 }, (_, i) => ({ event: "page_view", path: `/p${i}` })) },
    });
    expect((await big.json()).stored).toBe(100);

    const bad = await page.request.post("/api/track", { data: Buffer.from("{not json"), headers: { "Content-Type": "application/json" } });
    expect(bad.status()).toBe(400);

    const anon = await browser.newContext({ baseURL: LOCAL_BASE_URL });
    try {
      const res = await anon.request.post("/api/track", { data: { sessionId: "qa-an-anon", events: [{ event: "page_view" }] } });
      expect(res.status()).toBe(401);
      expect(await withTestDb((db) => db.usageEvent.count({ where: { sessionId: "qa-an-anon" } }))).toBe(0);
    } finally {
      await anon.close();
    }
  });
});
