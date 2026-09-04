import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, loginAsRoomLensAdmin, QA_USER } from "./helpers";
import { RESOLVED_ENV } from "./test-env";

/**
 * Support import to Jira (feature/support_import_to_jira): pushing reviewed
 * ideas into Jira issues after Match/Merge, configured per org in
 * Admin → Ideas (Workspace.ideasConfig), scoped per PM via "My Product
 * Lines", executed through /api/ideas/push (preview → execute).
 *
 * What this spec covers:
 * - PJ1: the Admin → Ideas config round-trip — defaults render, edits
 *   persist to Workspace.ideasConfig, the page re-renders them after
 *   reload, and the PUT endpoint normalizes garbage through
 *   mergeIdeasJiraConfig (the exact function the push path uses), so a
 *   broken stored config can never crash a merge.
 * - PJ2: authz + validation on every new API route: admin-only config
 *   (401 anon / 404 non-admin / 404 unknown org), push mode + JSON
 *   validation, the ideas org-feature gate, issue-types param + no-
 *   connection errors, and preferences validation incl. catalog
 *   filtering of ghost product-line names.
 * - PJ3: the PM flow end to end without a Jira connection — save My
 *   Product Lines in Settings → Ideas, see them pre-applied as the Ideas
 *   filter (and removable, i.e. a default, not a hard scope), open the
 *   Merge to Jira modal with the scope pre-selected, watch the
 *   scope-sensitive approved/pending hints, preview into the
 *   "Jira is not connected" blocker with Confirm disabled, and prove the
 *   execute API refuses with 409 before writing anything (idea stays
 *   reviewed, no inject ReviewEvent).
 *
 * Accepted gaps (need a live Jira connection — jira.ts talks to the
 * hard-coded api.atlassian.com, so there is nothing to point at a mock):
 * - Actual issue create/update, the Votes increment, set-if-empty /
 *   union policies against live field values, allowed-option warnings,
 *   the description overwrite as Jira renders it, and the update
 *   comment. buildDescription/buildUpdateComment are internal to
 *   push.ts and only run behind the connection check, so their assembly
 *   is not exercisable end-to-end here. The config that drives them IS
 *   covered (PJ1).
 *
 * Ideas gating: same pattern as customer-reporters.spec.ts — the env
 * guard pins IDEAS_ENABLED off, so beforeAll sets the RoomLens per-org
 * override {ideas: true} and afterAll clears it (all-pages.spec.ts
 * depends on the default). PJ2 flips the override off and back on inside
 * one test to exercise the API gate.
 *
 * State discipline: beforeAll deletes and recreates every fixture row
 * (QA-PJ prefixes), resets Workspace.ideasConfig and the QA user's
 * defaultProductLines; afterAll restores all of it. Each test restores
 * what it changes, so no test depends on another having run. All tests
 * write data.
 */

const ROOMLENS_SLUG = "roomlens";

const LINE_A = "QA-PJ Alpha";
const LINE_B = "QA-PJ Beta";
const IDEA_A_TITLE = "QA-PJ export presets"; // Alpha, approved
const IDEA_B_TITLE = "QA-PJ vendor sync"; // Beta, pending
const TICKET_PREFIX = "QA-PJ-T";

const NOT_CONNECTED_BLOCKER =
  "Jira is not connected — connect it in Settings → Integrations.";

let orgId: string;
let workspaceId: string;
let ideaAId: string;

async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  // Same resolved env as the app (yaml wins over shell); the env guard has
  // already pinned the database to pmos_test before this runs.
  process.env.DATABASE_URL = RESOLVED_ENV.DATABASE_URL;
  const db = new PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

/** Delete every fixture row this spec ever creates (idempotent). */
async function deleteFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({
    where: { workspaceId, title: { in: [IDEA_A_TITLE, IDEA_B_TITLE] } },
  });
  await db.zendeskTicketRaw.deleteMany({
    where: { workspaceId, externalId: { startsWith: TICKET_PREFIX } },
  });
  await db.productLine.deleteMany({
    where: { workspaceId, name: { startsWith: "QA-PJ " } },
  });
}

/** Reset the non-fixture state this spec touches to the seeded defaults. */
async function resetSharedState(db: PrismaClient): Promise<void> {
  await db.workspace.update({ where: { id: workspaceId }, data: { ideasConfig: {} } });
  await db.user.update({
    where: { email: QA_USER.email },
    data: { defaultProductLines: [] },
  });
}

test.describe("Ideas → Jira push (config, authz, merge scope)", () => {
  test.beforeAll(async () => {
    await withDb(async (db) => {
      const org = await db.organization
        .findUnique({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } })
        .catch((e) => {
          throw new Error(
            `ideas-jira-push spec could not reach the QA org — did you run ` +
              `\`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
          );
        });
      if (!org?.workspace) {
        throw new Error("RoomLens org/workspace missing — run `npm run test:db:setup`.");
      }
      orgId = org.id;
      workspaceId = org.workspace.id;

      // Ideas on for the org via the per-org override (env default stays off).
      await db.organization.update({
        where: { id: org.id },
        data: { features: { ideas: true } },
      });

      await deleteFixtures(db);
      await resetSharedState(db);

      for (const name of [LINE_A, LINE_B]) {
        await db.productLine.create({ data: { workspaceId, name } });
      }

      const t1 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: `${TICKET_PREFIX}1`,
          subject: "Export presets please",
          body: "QA fixture ticket — save export settings as presets.",
          requester: "Rivka Stern (QA)",
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });
      const t2 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: `${TICKET_PREFIX}2`,
          subject: "Vendor sync request",
          body: "QA fixture ticket — sync vendor catalogs nightly.",
          requester: "Avi Peretz (QA)",
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });

      // Approved idea in line A — the mergeable one.
      ideaAId = (
        await db.idea.create({
          data: {
            workspaceId,
            title: IDEA_A_TITLE,
            details: "QA fixture idea — approved, ready to merge.",
            products: [LINE_A],
            batchStatus: "new",
            decision: "reviewed",
            origin: "zendesk",
            newVotes: 1,
            sources: { create: [{ kind: "zendesk", ticketId: t1.id }] },
          },
        })
      ).id;
      // Pending idea in line B — stays behind on a partial merge.
      await db.idea.create({
        data: {
          workspaceId,
          title: IDEA_B_TITLE,
          details: "QA fixture idea — still pending review.",
          products: [LINE_B],
          batchStatus: "new",
          decision: "pending",
          origin: "zendesk",
          newVotes: 1,
          sources: { create: [{ kind: "zendesk", ticketId: t2.id }] },
        },
      });
    });
  });

  test.afterAll(async () => {
    await withDb(async (db) => {
      await deleteFixtures(db);
      await resetSharedState(db);
      // Back to the env default (ideas off) — all-pages.spec.ts depends on it.
      await db.organization.update({
        where: { slug: ROOMLENS_SLUG },
        data: { features: {} },
      });
    });
  });

  // ——— Admin → Ideas selectors ———

  /** A field-mapping row on /admin/ideas, scoped by its attribute label. */
  function fieldRow(page: Page, label: string) {
    return page.locator("div.rounded-lg", { has: page.getByText(label, { exact: true }) });
  }

  /** A labeled input on /admin/ideas ("Tickets heading", "Prefix", …). */
  function labeledInput(page: Page, labelText: string) {
    return page.locator("label", { hasText: labelText }).locator("input");
  }

  test("PJ1 Admin → Ideas config: defaults render, edits persist to Workspace.ideasConfig and survive reload, PUT normalizes garbage", async ({
    page,
  }) => {
    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();

    // Defaults from jira-mapping.ts render with the fixed policies on display.
    await expect(labeledInput(page, "Tickets heading")).toHaveValue("Supported Tickets:");
    await expect(labeledInput(page, "Blank lines before the list")).toHaveValue("2");
    await expect(labeledInput(page, "Zendesk ticket link template")).toHaveValue("");
    await expect(labeledInput(page, "Prefix")).toHaveValue(
      "#update from @PM-OS, fields affected:"
    );
    await expect(fieldRow(page, "Votes").locator('input[type="text"]')).toHaveValue("P_Votes");
    await expect(
      fieldRow(page, "Votes").getByText("Increment by this batch's new votes")
    ).toBeVisible();
    await expect(
      fieldRow(page, "Product Line").getByText(
        "Set only when empty (never replace a human's value)"
      )
    ).toBeVisible();
    await expect(
      fieldRow(page, "Components").locator('input[type="text"]')
    ).toHaveValue("P_Components");
    await expect(
      fieldRow(page, "Customers").getByText("Add missing values (never remove)")
    ).toBeVisible();

    // Edit: description format, one field name, one field toggle, the prefix.
    await labeledInput(page, "Tickets heading").fill("QA Supported:");
    await labeledInput(page, "Blank lines before the list").fill("3");
    await labeledInput(page, "Zendesk ticket link template").fill(
      "https://qa.zendesk.example/agent/tickets/{id}"
    );
    await fieldRow(page, "Customers").locator('input[type="text"]').fill("QA_Customers");
    // Components (platforms → P_Components) is OFF by default since
    // 2026-09-03, so its field-name input starts disabled; enabling the
    // attribute enables the input.
    await expect(
      fieldRow(page, "Components").locator('input[type="text"]')
    ).toBeDisabled();
    await fieldRow(page, "Components").getByRole("checkbox").check();
    await expect(
      fieldRow(page, "Components").locator('input[type="text"]')
    ).toBeEnabled();
    await labeledInput(page, "Prefix").fill("QA update:");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved — applies to the next merge")).toBeVisible();

    // Persisted normalized: the stored config is always complete.
    const stored = await withDb(async (db) => {
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      return ws.ideasConfig as Record<string, unknown>;
    });
    expect(stored.descriptionMode).toBe("overwrite");
    expect(stored.supportedTicketsHeading).toBe("QA Supported:");
    expect(stored.descriptionGapLines).toBe(3);
    expect(stored.zendeskTicketUrlTemplate).toBe(
      "https://qa.zendesk.example/agent/tickets/{id}"
    );
    expect(stored.commentPrefix).toBe("QA update:");
    const fields = stored.fields as Record<
      string,
      { jiraField: string; type: string; policy: string; enabled: boolean }
    >;
    expect(fields.customers).toEqual({
      jiraField: "QA_Customers",
      type: "multi_select",
      policy: "union",
      enabled: true,
    });
    expect(fields.platforms.enabled).toBe(true);
    expect(fields.votes).toEqual({
      jiraField: "P_Votes",
      type: "number",
      policy: "increment",
      enabled: true,
    });

    // Reload: the server renders the saved config back, not the defaults.
    await page.reload();
    await expect(labeledInput(page, "Tickets heading")).toHaveValue("QA Supported:");
    await expect(labeledInput(page, "Blank lines before the list")).toHaveValue("3");
    await expect(
      fieldRow(page, "Customers").locator('input[type="text"]')
    ).toHaveValue("QA_Customers");
    await expect(fieldRow(page, "Components").getByRole("checkbox")).toBeChecked();

    // PUT normalization: garbage in, complete valid config out — the same
    // mergeIdeasJiraConfig the push path runs, so a stored config can never
    // crash a merge. Unknown keys dropped, negative gap and empty heading
    // fall back to defaults, partial field entries are completed.
    const res = await page.request.put(`/api/admin/organizations/${orgId}/ideas-config`, {
      data: {
        descriptionMode: "append", // not a real mode — forced back to overwrite
        descriptionGapLines: -3,
        supportedTicketsHeading: "",
        junkKey: true,
        fields: { votes: { enabled: false }, junkField: { jiraField: "X" } },
      },
    });
    expect(res.status()).toBe(200);
    const { config } = await res.json();
    expect(config.descriptionMode).toBe("overwrite");
    expect(config.descriptionGapLines).toBe(2);
    expect(config.supportedTicketsHeading).toBe("Supported Tickets:");
    expect(config.junkKey).toBeUndefined();
    expect(config.fields.junkField).toBeUndefined();
    expect(config.fields.votes).toEqual({
      jiraField: "P_Votes",
      type: "number",
      policy: "increment",
      enabled: false,
    });
    // PUT replaces the whole config — the earlier platforms toggle is gone,
    // back to the default (off).
    expect(config.fields.platforms.enabled).toBe(false);

    // An org id without a workspace is refused, not upserted.
    const missing = await page.request.put(
      "/api/admin/organizations/qa-pj-no-such-org/ideas-config",
      { data: {} }
    );
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toBe("Organization has no workspace");

    // Restore the seeded default so no other test inherits this config.
    await withDb((db) =>
      db.workspace.update({ where: { id: workspaceId }, data: { ideasConfig: {} } })
    );
  });

  test("PJ2 API authz and validation on the push, config, issue-types and preferences routes", async ({
    page,
    request,
  }) => {
    // Anonymous: admin config is 401; push hides behind the ideas gate
    // (logged-out callers get the env default, which the guard pins off).
    expect(
      (
        await request.put(`/api/admin/organizations/${orgId}/ideas-config`, { data: {} })
      ).status()
    ).toBe(401);
    expect(
      (await request.post("/api/ideas/push", { data: { mode: "preview" } })).status()
    ).toBe(404);

    await loginAsRoomLens(page);

    // Signed-in non-admin: 404, admin existence is not advertised.
    expect(
      (
        await page.request.put(`/api/admin/organizations/${orgId}/ideas-config`, {
          data: {},
        })
      ).status()
    ).toBe(404);

    // Push input validation.
    const badMode = await page.request.post("/api/ideas/push", {
      data: { mode: "bogus" },
    });
    expect(badMode.status()).toBe(400);
    expect((await badMode.json()).error).toBe("mode must be preview or execute");
    const badJson = await page.request.post("/api/ideas/push", {
      headers: { "Content-Type": "application/json" },
      // A string under a JSON content-type gets JSON.stringify-ed by Playwright
      // when it is not parsable; a Buffer goes over the wire untouched.
      data: Buffer.from("{not json"),
    });
    expect(badJson.status()).toBe(400);
    expect((await badJson.json()).error).toBe("Invalid JSON");

    // Issue types: param required; without a connection the error is loud,
    // not an empty list.
    const noProject = await page.request.get("/api/jira/issue-types");
    expect(noProject.status()).toBe(400);
    expect((await noProject.json()).error).toBe("project is required");
    const noConnection = await page.request.get("/api/jira/issue-types?project=QAPJ");
    expect(noConnection.status()).toBe(502);
    expect((await noConnection.json()).error).toContain("Jira not connected");

    // Preferences: array required; names are canonicalized against the
    // catalog (case-insensitive) and ghosts dropped, in the response AND
    // the DB.
    const notArray = await page.request.post("/api/ideas/preferences", {
      data: { productLines: "nope" },
    });
    expect(notArray.status()).toBe(400);
    expect((await notArray.json()).error).toBe("productLines must be an array");
    const ghosts = await page.request.post("/api/ideas/preferences", {
      data: { productLines: ["qa-pj alpha", "QA-PJ Ghost"] },
    });
    expect(ghosts.status()).toBe(200);
    expect((await ghosts.json()).productLines).toEqual([LINE_A]);
    const savedLines = await withDb(async (db) => {
      const user = await db.user.findUniqueOrThrow({ where: { email: QA_USER.email } });
      return user.defaultProductLines;
    });
    expect(savedLines).toEqual([LINE_A]);
    // Restore the empty default — PJ3 sets its own lines through the UI.
    await withDb((db) =>
      db.user.update({ where: { email: QA_USER.email }, data: { defaultProductLines: [] } })
    );

    // The org feature gate covers the push route: override off → 404, even
    // for a valid session. Restored immediately (PJ3 needs ideas on).
    try {
      await withDb((db) =>
        db.organization.update({ where: { slug: ROOMLENS_SLUG }, data: { features: {} } })
      );
      expect(
        (
          await page.request.post("/api/ideas/push", { data: { mode: "preview" } })
        ).status()
      ).toBe(404);
    } finally {
      await withDb((db) =>
        db.organization.update({
          where: { slug: ROOMLENS_SLUG },
          data: { features: { ideas: true } },
        })
      );
    }
  });

  test("PJ3 My Product Lines default the Ideas filter and merge scope; preview surfaces the not-connected blocker and execute refuses before writing", async ({
    page,
  }) => {
    await loginAsRoomLens(page);

    // Save "my" line in Settings → Ideas.
    await page.goto("/settings/ideas");
    const panel = page.locator("section", {
      has: page.getByRole("heading", { name: "My Product Lines" }),
    });
    await panel.getByRole("button", { name: LINE_A, exact: true }).click();
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(panel.getByText("Saved", { exact: true })).toBeVisible();
    const prefs = await withDb(async (db) => {
      const user = await db.user.findUniqueOrThrow({ where: { email: QA_USER.email } });
      return user.defaultProductLines;
    });
    expect(prefs).toEqual([LINE_A]);

    // The Ideas screen opens pre-filtered to my line: the Alpha idea shows,
    // the Beta idea does not, and the filter chip is removable — it is a
    // default, not a hard scope.
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    const rowA = page.locator("div.cursor-pointer", { hasText: IDEA_A_TITLE });
    const rowB = page.locator("div.cursor-pointer", { hasText: IDEA_B_TITLE });
    await expect(rowA).toBeVisible();
    await expect(rowB).toHaveCount(0);
    await page.getByRole("button", { name: `${LINE_A} ✕` }).click();
    await expect(rowB).toBeVisible();

    // Merge modal: scope opens pre-selected to my line.
    await page.getByRole("button", { name: "Merge to Jira" }).click();
    const modal = page.locator("div.fixed.inset-0.z-50");
    await expect(modal.getByText("Merge to Jira", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: LINE_A, exact: true })).toHaveClass(
      /bg-primary/
    );
    await expect(modal.getByText("1 approved change will merge")).toBeVisible();

    // Scope drives the gate: only-Beta has nothing approved and preview is
    // disabled; Beta+Alpha merges the approved one while the pending one
    // stays behind (partial merge, pending never blocks).
    await modal.getByRole("button", { name: LINE_A, exact: true }).click(); // deselect
    await modal.getByRole("button", { name: LINE_B, exact: true }).click();
    await expect(
      modal.getByText("Nothing approved in the selected product lines")
    ).toBeVisible();
    await expect(modal.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    await modal.getByRole("button", { name: LINE_A, exact: true }).click(); // reselect
    await expect(
      modal.getByText("1 approved change will merge — 1 still pending stays here")
    ).toBeVisible();

    // Preview without a Jira connection: the blocker renders and the
    // confirm button never opens.
    await modal.getByRole("button", { name: "Preview changes" }).click();
    await expect(modal.getByText(NOT_CONNECTED_BLOCKER)).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Confirm merge/ })).toBeDisabled();

    // Esc closes the modal (Enter deliberately does nothing here).
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    // Execute refuses with the same blocker BEFORE any write: 409, the idea
    // stays approved and no inject event is recorded.
    const execute = await page.request.post("/api/ideas/push", {
      data: { mode: "execute" },
    });
    expect(execute.status()).toBe(409);
    const body = await execute.json();
    expect(body.blockers).toContain(NOT_CONNECTED_BLOCKER);
    const after = await withDb(async (db) => {
      const idea = await db.idea.findUniqueOrThrow({ where: { id: ideaAId } });
      const injects = await db.reviewEvent.count({
        where: { workspaceId, ideaId: ideaAId, action: "inject" },
      });
      return { decision: idea.decision, injects };
    });
    expect(after.decision).toBe("reviewed");
    expect(after.injects).toBe(0);
  });
});
