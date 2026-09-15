import { randomBytes, scryptSync } from "crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsRoomLens, loginWithTotp, withTestDb } from "./helpers";
import { RESOLVED_ENV } from "./test-env";
import { encryptTotpSecret } from "../../src/lib/two-factor";

/**
 * UI facelift v2 (feature/face_lift_v2, Direction B) — the behaviour that
 * changed, not the restyle:
 *
 * FL1 Fresh workspace: the sidebar rail starts collapsed with no
 *     pmos_sidebar cookie (w-16), "Expand menu" widens it (w-60), sets the
 *     cookie and reveals the green pending badge on Ideas with the exact
 *     pending count, and the state survives a reload (server-read cookie).
 *     Visiting /ideas bootstraps the built-in "All Customers" catalog row in
 *     a workspace that had no customers at all; DELETE of that row through
 *     /api/ideas/lists/customers is refused with 400 "All Customers is
 *     built in and can't be deleted" and the row stays listed.
 * FL2 Fresh workspace: "Clear import" opens the PM-OS confirm dialog
 *     (role=alertdialog, title "Are you sure?", Cancel + "Remove all" as the
 *     last button). Esc closes it and clears nothing (row still there, DB
 *     untouched); reopening and pressing Enter confirms — the list shows
 *     "No ideas yet", the Clear import button is gone, and the workspace's
 *     tickets and ideas are 0 in the DB.
 * FL3 RoomLens: the Final list is grouped by product line — one <section>
 *     per line with a header button (aria-expanded) showing the name,
 *     "N ideas", the vote sum and "N pending" / "All reviewed"; clicking it
 *     folds the rows and clicking again unfolds them. The always-visible
 *     approve mark ("Mark reviewed") approves the row: toast
 *     Approved “<title>”, the header's pending count drops, the DB flips to
 *     reviewed; "Mark unreviewed" reverses all of it.
 * FL4 RoomLens: the new Label filter — Internal narrows the list to ideas
 *     with no customer on any supporting ticket (chip "Internal ✕" clears
 *     it). Then the ticket view inside the drawer: a source row opens the
 *     ticket with labelled Customer / Reported by / Module / Created fields,
 *     the Evaluation box with the catalog verdict, and "Split into 2 ideas"
 *     as link pills; a pill opens that idea with a back chevron ("Back")
 *     that returns to the ticket, and "Back to idea" returns to the idea.
 *
 * The RoomLens workspace on a feature clone can hold the developer's own
 * import (it did on face_lift_v2: 71 ideas), and Clear import wipes a whole
 * workspace — so FL1/FL2 run in a QA-owned org (QA-FL Clear Org) with its
 * own synthetic user, seeded through Prisma exactly like seed-test-db.mjs
 * seeds RoomLens (scrypt password, TOTP secret encrypted with the app's own
 * encryptTotpSecret). FL3/FL4 use QA-FL-prefixed fixtures in RoomLens and
 * only ever read or flip their own rows. LLM-free throughout: tickets and
 * ideas are seeded as the import would have persisted them (matchNotes
 * included, for the ticket view's idea links).
 *
 * Ideas gating: the env guard pins IDEAS_ENABLED off, so beforeAll sets the
 * per-org {ideas: true} override on RoomLens (and on the QA org) and
 * afterAll clears RoomLens's (all-pages.spec.ts depends on the default).
 * State discipline: delete-and-recreate in beforeAll, delete in afterAll;
 * FL1/FL2 reset the QA org's tickets/ideas themselves, FL3 restores the
 * decision it flips — no test depends on another having run.
 */

const ROOMLENS_SLUG = "roomlens";

// ── QA-owned org for the destructive path (FL1/FL2) ──────────────────────
const FL_ORG = { name: "QA-FL Clear Org", slug: "qa-fl-clear" };
const FL_USER = {
  email: "qa+fl-clear@pm-os.io",
  password: "roomlens-qa-pass1",
  // Synthetic, test-only TOTP secret — distinct from the seeded users' so
  // back-to-back logins never share a consumed code window.
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};
const FL_TICKET_ID = "QA-FL-CLEAR-T1";
const FL_IDEA_TITLE = "QA-FL clear-org idea";

// ── RoomLens fixtures (FL3/FL4) — synthetic, mutually non-substring ──────
const LINE_A = "QA-FL Line A";
const LINE_B = "QA-FL Line B";
const CUSTOMER = "QA-FL Cust Co";
const REPORTER_1 = "Rivka Stern (QA)";
const REPORTER_2 = "Avi Peretz (QA)";
const MODULE = "QA Module";
const T1 = "QA-FL-T1"; // customer named; split into A1 (new) + B1 (merged)
const T2 = "QA-FL-T2"; // no customer named → its idea is Internal
const A1_TITLE = "QA-FL alpha export"; // Line A, pending, from T1
const A2_TITLE = "QA-FL alpha internal"; // Line A, pending, from T2 (Internal)
const B1_TITLE = "QA-FL beta merged"; // Line B, reviewed, from T1
const ALL_TITLES = [A1_TITLE, A2_TITLE, B1_TITLE];
const CATALOG_REASON = "QA fixture verdict — a real feature ask";

let roomlensWorkspaceId: string;
let flWorkspaceId: string;
let a1Id: string;

/** Same salt:scrypt format as src/lib/auth.ts hashPassword / the seed. */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

async function deleteRoomLensFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({ where: { workspaceId: roomlensWorkspaceId, title: { in: ALL_TITLES } } });
  await db.zendeskTicketRaw.deleteMany({
    where: { workspaceId: roomlensWorkspaceId, externalId: { in: [T1, T2] } },
  });
  await db.customer.deleteMany({
    where: { workspaceId: roomlensWorkspaceId, name: { equals: CUSTOMER, mode: "insensitive" } },
  });
  await db.productLine.deleteMany({
    where: { workspaceId: roomlensWorkspaceId, name: { in: [LINE_A, LINE_B] } },
  });
}

async function deleteQaOrg(db: PrismaClient): Promise<void> {
  // User.organizationId has no cascade — remove the user (sessions cascade)
  // before the org (workspace → tickets/ideas/customers cascade).
  await db.user.deleteMany({ where: { email: FL_USER.email } });
  await db.organization.deleteMany({ where: { slug: FL_ORG.slug } });
}

/** One ticket → one pending idea in the QA org (what FL1 counts and FL2 clears). */
async function resetQaOrgIdeas(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({ where: { workspaceId: flWorkspaceId } });
  await db.zendeskTicketRaw.deleteMany({ where: { workspaceId: flWorkspaceId } });
  const t = await db.zendeskTicketRaw.create({
    data: {
      workspaceId: flWorkspaceId,
      externalId: FL_TICKET_ID,
      subject: "Clear-org fixture ticket",
      body: "QA fixture ticket — exists to be cleared.",
      requester: REPORTER_1,
      tags: ["qa-fixture"],
      raw: {},
      catalogKind: "fr",
      catalogReason: CATALOG_REASON,
    },
  });
  await db.idea.create({
    data: {
      workspaceId: flWorkspaceId,
      title: FL_IDEA_TITLE,
      details: "QA fixture idea — the only idea in this workspace.",
      products: [],
      batchStatus: "new",
      decision: "pending",
      origin: "zendesk",
      newVotes: 1,
      sources: { create: [{ kind: "zendesk", ticketId: t.id }] },
    },
  });
}

test.describe("UI facelift v2 — confirm dialog, grouped list, Label filter, ticket view, sidebar", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const org = await db.organization
        .findUnique({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } })
        .catch((e) => {
          throw new Error(
            `ui-facelift-v2 spec could not reach the QA org — did you run ` +
              `\`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
          );
        });
      if (!org?.workspace) {
        throw new Error("RoomLens org/workspace missing — run `npm run test:db:setup`.");
      }
      roomlensWorkspaceId = org.workspace.id;

      // Ideas on for RoomLens via the per-org override (env default stays off).
      await db.organization.update({
        where: { id: org.id },
        data: { features: { ideas: true } },
      });

      // ── QA-owned org + enrolled user (FL1/FL2) ──
      await deleteQaOrg(db);
      process.env.TOTP_ENC_KEY = RESOLVED_ENV.TOTP_ENC_KEY; // encrypt with the app's test key
      const qaOrg = await db.organization.create({
        data: {
          name: FL_ORG.name,
          slug: FL_ORG.slug,
          features: { ideas: true },
          workspace: { create: { name: `${FL_ORG.name} Workspace` } },
        },
        include: { workspace: true },
      });
      flWorkspaceId = qaOrg.workspace!.id;
      await db.user.create({
        data: {
          email: FL_USER.email,
          name: "QA FL Clear",
          passwordHash: hashPassword(FL_USER.password),
          organizationId: qaOrg.id,
          role: "USER",
          totpSecretEnc: encryptTotpSecret(FL_USER.totpSecret),
          totpEnabledAt: new Date(),
          totpLastUsedStep: null,
        },
      });
      await resetQaOrgIdeas(db);

      // ── RoomLens fixtures (FL3/FL4) ──
      await deleteRoomLensFixtures(db);
      for (const [name, color] of [
        [LINE_A, "indigo"],
        [LINE_B, "teal"],
      ] as const) {
        await db.productLine.create({
          data: { workspaceId: roomlensWorkspaceId, name, description: "QA fixture line", color },
        });
      }
      await db.customer.create({
        data: { workspaceId: roomlensWorkspaceId, name: CUSTOMER, description: "QA fixture customer", color: "blue" },
      });
      const t1 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId: roomlensWorkspaceId,
          externalId: T1,
          subject: "Export alpha, and the beta part too",
          body: "QA fixture ticket — one ask that split into two ideas.",
          requester: REPORTER_1,
          customerName: CUSTOMER,
          affectedCustomers: [CUSTOMER],
          module: MODULE,
          sourceCreatedAt: "2026-09-01T10:00:00.000Z",
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: CATALOG_REASON,
        },
      });
      const t2 = await db.zendeskTicketRaw.create({
        data: {
          workspaceId: roomlensWorkspaceId,
          externalId: T2,
          subject: "Internal alpha request",
          body: "QA fixture ticket — no customer named anywhere.",
          requester: REPORTER_2,
          affectedCustomers: [],
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: CATALOG_REASON,
        },
      });
      a1Id = (
        await db.idea.create({
          data: {
            workspaceId: roomlensWorkspaceId,
            title: A1_TITLE,
            details: "QA fixture idea — new this batch, one customer.",
            products: [LINE_A],
            batchStatus: "new",
            decision: "pending",
            origin: "zendesk",
            newVotes: 2,
            sources: { create: [{ kind: "zendesk", ticketId: t1.id }] },
          },
        })
      ).id;
      await db.idea.create({
        data: {
          workspaceId: roomlensWorkspaceId,
          title: A2_TITLE,
          details: "QA fixture idea — internal, no customer.",
          products: [LINE_A],
          batchStatus: "new",
          decision: "pending",
          origin: "zendesk",
          newVotes: 1,
          sources: { create: [{ kind: "zendesk", ticketId: t2.id }] },
        },
      });
      const b1Id = (
        await db.idea.create({
          data: {
            workspaceId: roomlensWorkspaceId,
            title: B1_TITLE,
            details: "QA fixture idea — already reviewed, in the other line.",
            products: [LINE_B],
            batchStatus: "new",
            decision: "reviewed",
            origin: "zendesk",
            existingVotes: 3,
            newVotes: 1,
            sources: { create: [{ kind: "zendesk", ticketId: t1.id }] },
          },
        })
      ).id;
      // What the match stage records on a split ticket: unit → idea.
      await db.zendeskTicketRaw.update({
        where: { id: t1.id },
        data: {
          matchNotes: [
            { unit: `${T1}#1`, ideaId: a1Id, merged: false, reason: "QA: new idea" },
            { unit: `${T1}#2`, ideaId: b1Id, merged: true, reason: "QA: merged into beta" },
          ],
        },
      });
    });
  });

  test.afterAll(async () => {
    await withTestDb(async (db) => {
      await deleteRoomLensFixtures(db);
      await deleteQaOrg(db);
      await db.organization.update({
        where: { slug: ROOMLENS_SLUG },
        data: { features: {} },
      });
    });
  });

  /** An idea row on the Final list (only rows carry cursor-pointer + the title). */
  function ideaRow(scope: Page | Locator, title: string) {
    return scope.locator("div.cursor-pointer").filter({ hasText: title });
  }
  /** A product-line group and its header button. */
  function group(page: Page, line: string) {
    const section = page.locator("section").filter({
      has: page.getByRole("button", { name: new RegExp(`^${line}\\b`) }),
    });
    return { section, header: section.getByRole("button", { name: new RegExp(`^${line}\\b`) }) };
  }
  const drawer = (page: Page) => page.locator("div.fixed.bottom-0.right-0.top-0");
  const sidebar = (page: Page) => page.locator("aside");

  test("FL1 sidebar starts collapsed and expands with the pending badge; /ideas bootstraps the built-in All Customers row, which cannot be deleted", async ({
    page,
    context,
  }) => {
    await withTestDb(resetQaOrgIdeas);
    await loginWithTotp(page, FL_USER);

    // No cookie → collapsed rail; the Ideas label and badge are curtained off.
    expect((await context.cookies()).find((c) => c.name === "pmos_sidebar")).toBeUndefined();
    const rail = sidebar(page);
    await expect(rail).toHaveClass(/\bw-16\b/);
    await expect(rail.getByRole("button", { name: "Expand menu" })).toBeVisible();
    const ideasLink = rail.locator('a[href="/ideas"]');
    await expect(ideasLink).toHaveAttribute("title", "Ideas · 1 awaiting review");

    // Expand: wide rail, cookie written, badge = the workspace's pending count.
    await rail.getByRole("button", { name: "Expand menu" }).click();
    await expect(rail).toHaveClass(/\bw-60\b/);
    await expect(rail).not.toHaveClass(/\bw-16\b/);
    const pending = await withTestDb((db) =>
      db.idea.count({
        where: { workspaceId: flWorkspaceId, decision: "pending", batchStatus: { notIn: ["unchanged", "deleted"] } },
      })
    );
    expect(pending).toBe(1);
    const badge = ideasLink.locator(`span[title="${pending} awaiting review"]`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(String(pending));
    await expect(badge).toHaveClass(/bg-success/);
    expect((await context.cookies()).find((c) => c.name === "pmos_sidebar")?.value).toBe("expanded");

    // The server reads the cookie: a reload renders the rail open, no flash.
    await page.reload();
    await expect(rail).toHaveClass(/\bw-60\b/);
    await expect(rail.getByRole("button", { name: "Collapse menu" })).toBeVisible();
    await rail.getByRole("button", { name: "Collapse menu" }).click();
    await expect(rail).toHaveClass(/\bw-16\b/);
    expect((await context.cookies()).find((c) => c.name === "pmos_sidebar")?.value).toBe("collapsed");

    // Catalog bootstrap: the fresh workspace has no customers until /ideas
    // is visited; then the built-in row is there.
    expect(await withTestDb((db) => db.customer.count({ where: { workspaceId: flWorkspaceId } }))).toBe(0);
    await page.goto("/ideas");
    await expect(ideaRow(page, FL_IDEA_TITLE)).toBeVisible();
    const list = await page.request.get("/api/ideas/lists/customers");
    expect(list.status()).toBe(200);
    const items = (await list.json()).items as { id: string; name: string }[];
    const allCustomers = items.find((i) => i.name === "All Customers");
    expect(allCustomers, `customers list: ${JSON.stringify(items.map((i) => i.name))}`).toBeTruthy();

    // Built in: DELETE is refused with the exact message and the row stays.
    const del = await page.request.delete("/api/ideas/lists/customers", { data: { id: allCustomers!.id } });
    expect(del.status()).toBe(400);
    expect((await del.json()).error).toBe("All Customers is built in and can't be deleted");
    const again = (await (await page.request.get("/api/ideas/lists/customers")).json()).items as { name: string }[];
    expect(again.map((i) => i.name)).toContain("All Customers");
    expect(
      await withTestDb((db) => db.customer.count({ where: { workspaceId: flWorkspaceId, name: "All Customers" } }))
    ).toBe(1);
  });

  test("FL2 Clear import goes through the PM-OS confirm dialog: Esc cancels and clears nothing, Enter removes every ticket and idea", async ({
    page,
  }) => {
    await withTestDb(resetQaOrgIdeas);
    await loginWithTotp(page, FL_USER);
    await page.goto("/ideas");
    const row = ideaRow(page, FL_IDEA_TITLE);
    await expect(row).toBeVisible();
    const clearButton = page.getByRole("button", { name: "Clear import" });
    const dialog = page.getByRole("alertdialog");

    // Open: title, message, Cancel then the primary action as the last button.
    await clearButton.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Are you sure?" })).toBeVisible();
    await expect(dialog.getByText("This removes every imported ticket and idea from this workspace.")).toBeVisible();
    const buttons = dialog.getByRole("button");
    await expect(buttons).toHaveCount(2);
    await expect(buttons.first()).toHaveText("Cancel");
    await expect(buttons.last()).toHaveText("Remove all");
    await expect(buttons.last()).toBeFocused();

    // Esc cancels: dialog gone, nothing cleared (UI and DB).
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(clearButton).toBeVisible();
    const before = await withTestDb(async (db) => ({
      ideas: await db.idea.count({ where: { workspaceId: flWorkspaceId } }),
      tickets: await db.zendeskTicketRaw.count({ where: { workspaceId: flWorkspaceId } }),
    }));
    expect(before).toEqual({ ideas: 1, tickets: 1 });

    // Enter confirms: empty state, no Clear import button left, DB emptied.
    await clearButton.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("No ideas yet")).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(clearButton).toHaveCount(0);
    const after = await withTestDb(async (db) => ({
      ideas: await db.idea.count({ where: { workspaceId: flWorkspaceId } }),
      tickets: await db.zendeskTicketRaw.count({ where: { workspaceId: flWorkspaceId } }),
    }));
    expect(after).toEqual({ ideas: 0, tickets: 0 });
    // The catalog is not part of "import" — the customer rows survive.
    expect(await withTestDb((db) => db.customer.count({ where: { workspaceId: flWorkspaceId } }))).toBeGreaterThan(0);
  });

  test("FL3 Final list groups by product line with counts, votes and pending state; headers fold; the approve mark toasts and flips the DB decision both ways", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await page.goto("/ideas");

    const a = group(page, LINE_A);
    const b = group(page, LINE_B);
    await expect(a.header).toBeVisible();
    await expect(a.header).toHaveAttribute("aria-expanded", "true");
    await expect(a.header).toContainText("2 ideas");
    await expect(a.header).toContainText("3 votes");
    await expect(a.header).toContainText("2 pending");
    await expect(b.header).toHaveAttribute("aria-expanded", "true");
    await expect(b.header).toContainText("1 idea");
    await expect(b.header).toContainText("4 votes");
    await expect(b.header).toContainText("All reviewed");
    await expect(b.header).not.toContainText("pending");
    // Rows live inside their line's section, not the other's.
    await expect(ideaRow(a.section, A1_TITLE)).toBeVisible();
    await expect(ideaRow(a.section, A2_TITLE)).toBeVisible();
    await expect(ideaRow(b.section, B1_TITLE)).toBeVisible();
    await expect(ideaRow(a.section, B1_TITLE)).toHaveCount(0);

    // Fold / unfold Line A; Line B is untouched.
    await a.header.click();
    await expect(a.header).toHaveAttribute("aria-expanded", "false");
    await expect(ideaRow(a.section, A1_TITLE)).toHaveCount(0);
    await expect(ideaRow(a.section, A2_TITLE)).toHaveCount(0);
    await expect(ideaRow(b.section, B1_TITLE)).toBeVisible();
    await a.header.click();
    await expect(a.header).toHaveAttribute("aria-expanded", "true");
    await expect(ideaRow(a.section, A1_TITLE)).toBeVisible();

    // Approve from the row mark (always visible now — no hover needed).
    const rowA1 = ideaRow(a.section, A1_TITLE);
    const mark = rowA1.getByTitle("Mark reviewed");
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("aria-pressed", "false");
    await mark.click();
    await expect(page.getByRole("status")).toHaveText(`Approved “${A1_TITLE}”`);
    await expect(rowA1.getByTitle("Mark unreviewed")).toHaveAttribute("aria-pressed", "true");
    await expect(a.header).toContainText("1 pending");
    expect(
      (await withTestDb((db) => db.idea.findUniqueOrThrow({ where: { id: a1Id }, select: { decision: true } }))).decision
    ).toBe("reviewed");

    // Reverse it — the toast, the header and the DB all follow.
    await rowA1.getByTitle("Mark unreviewed").click();
    await expect(page.getByRole("status")).toHaveText(`“${A1_TITLE}” marked unreviewed`);
    await expect(rowA1.getByTitle("Mark reviewed")).toHaveAttribute("aria-pressed", "false");
    await expect(a.header).toContainText("2 pending");
    expect(
      (await withTestDb((db) => db.idea.findUniqueOrThrow({ where: { id: a1Id }, select: { decision: true } }))).decision
    ).toBe("pending");
  });

  test("FL4 Label → Internal narrows the list to ideas with no customer; the drawer's ticket view shows labelled fields, the Evaluation box and idea links with Back navigation", async ({
    page,
  }) => {
    await loginAsRoomLens(page);
    await page.goto("/ideas");
    const rowA1 = ideaRow(page, A1_TITLE);
    const rowA2 = ideaRow(page, A2_TITLE);
    const rowB1 = ideaRow(page, B1_TITLE);
    await expect(rowA1).toBeVisible();
    await expect(rowA2).toBeVisible();
    await expect(rowB1).toBeVisible();
    // Only the customer-less idea carries the Internal tag on its row.
    await expect(rowA2.getByText("Internal", { exact: true })).toBeVisible();
    await expect(rowA1.getByText("Internal", { exact: true })).toHaveCount(0);

    // Label → Internal (multi-select popover stays open; close via the backdrop).
    await page.getByRole("button", { name: "Label", exact: true }).click();
    const popover = page.locator("div.z-\\[25\\]");
    await popover.getByRole("button", { name: "Internal", exact: true }).click();
    await page.locator("div.z-\\[24\\]").click({ position: { x: 4, y: 4 } });
    await expect(popover).toHaveCount(0);
    const chip = page.getByRole("button", { name: "Internal ✕" });
    await expect(chip).toBeVisible();
    await expect(rowA2).toBeVisible();
    await expect(rowA1).toHaveCount(0);
    await expect(rowB1).toHaveCount(0);
    // Clearing via the chip brings the customer-backed ideas back.
    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect(rowA1).toBeVisible();
    await expect(rowB1).toBeVisible();

    // Drawer → source row → the ticket view.
    await rowA1.click();
    const d = drawer(page);
    await expect(d).toBeVisible();
    await expect(d.getByText("Sources · 1")).toBeVisible();
    await d.getByRole("button", { name: new RegExp(T1) }).click();
    await expect(d.getByText(`Zendesk ticket ${T1}`)).toBeVisible();
    for (const [label, value] of [
      ["Customer", CUSTOMER],
      ["Reported by", REPORTER_1],
      ["Module", MODULE],
      ["Created", /2026/],
    ] as const) {
      const field = d.locator("span.inline-flex").filter({ has: page.getByText(label, { exact: true }) }).first();
      await expect(field, `ticket field ${label}`).toBeVisible();
      await expect(field).toContainText(value);
    }
    await expect(d.getByText("Evaluation", { exact: true })).toBeVisible();
    await expect(d.getByText("Feature request", { exact: true })).toBeVisible();
    await expect(d.getByText(CATALOG_REASON)).toBeVisible();
    await expect(d.getByText("Split into 2 ideas")).toBeVisible();
    const pillA1 = d.getByRole("button", { name: A1_TITLE, exact: true });
    const pillB1 = d.getByRole("button", { name: B1_TITLE, exact: true });
    await expect(pillA1).toBeVisible();
    await expect(pillB1).toBeVisible();
    await expect(pillB1).toHaveAttribute("title", /^Merged into: /);
    await expect(pillA1).toHaveAttribute("title", /^New idea: /);

    // Pill → the other idea, with a Back chevron that returns to the ticket.
    await pillB1.click();
    await expect(d.getByRole("heading", { name: B1_TITLE, exact: true })).toBeVisible();
    await expect(d.getByText(`Zendesk ticket ${T1}`)).toHaveCount(0);
    const back = d.getByTitle("Back", { exact: true });
    await expect(back).toBeVisible();
    await back.click();
    await expect(d.getByText(`Zendesk ticket ${T1}`)).toBeVisible();
    await expect(d.getByText("Split into 2 ideas")).toBeVisible();
    await expect(d.getByTitle("Back", { exact: true })).toHaveCount(0);
    // And from the ticket back to the idea it was opened from.
    await d.getByTitle("Back to idea").click();
    await expect(d.getByRole("heading", { name: A1_TITLE, exact: true })).toBeVisible();
    await expect(d.getByText("Sources · 1")).toBeVisible();
    await expect(d.getByText(`Zendesk ticket ${T1}`)).toHaveCount(0);
  });
});
