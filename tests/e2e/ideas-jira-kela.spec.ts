import { expect, test, type Locator, type Page } from "@playwright/test";
import { type Prisma, PrismaClient } from "@prisma/client";
import {
  jiraTestEnv,
  loginAsKelaQa,
  loginAsRoomLensAdmin,
  QA_KELA,
  withTestDb,
} from "./helpers";
import { buildProductLineResolver } from "../../src/lib/ideas/product-line-key";

/**
 * Jira support for Kela (feature/jira-support-kela): Jira's Module and the
 * PM-OS product lines are ONE taxonomy (aliases on the catalog row), the
 * pulled issue's live Jira state shows on ideas (status filter, status chip,
 * the raw issue in the drawer), "Jira Merge" became "Sync to Jira" with a
 * ready / nothing-to-sync scope, and Admin → Ideas is grouped into
 * Stats / Jira / Zendesk / AI with a pull ceiling and read-only field rows.
 *
 * What this spec covers (LLM-free — nothing here imports a CSV or talks to
 * Jira; fixtures are seeded with Prisma exactly as the import would have
 * written them):
 * - JK1 Product-line aliases: Settings → Product Lines (PM-OS admin) shows
 *   "Also called:", the edit form's comma field round-trips through the API
 *   (trimmed, deduped case-insensitively, the line's own name dropped), a
 *   duplicate NAME is a 409, GET returns the aliases; and the pure resolver
 *   (buildProductLineResolver, run in-process) maps every seeded Kela
 *   spelling of Platform to "Platform" and an unknown value to undefined.
 * - JK2 Jira status on ideas (Kela QA org): with Status: All the "Jira
 *   Status" filter lists the pulled statuses, a Done idea with no ticket is
 *   hidden by default and shown when Done is picked, a Done idea WITH a
 *   ticket shows by default, rows carry the status chip and the ZEN-<id>
 *   label for a numeric ticket id, and the drawer's raw Jira issue shows
 *   Module / Status / Assignee / Reporter / Created on top plus an
 *   "All fields" dropdown with the type and priority.
 * - JK3 Sync to Jira dialog without a usable connection: the button reads
 *   "Sync to Jira", the dialog lists "Ready to sync" (approved counts) and
 *   "Nothing to sync" (disabled rows: "N pending" / "no changes"), the Ready
 *   header toggles Clear / Select all, picking a row narrows the hint, and
 *   Preview reaches the "Jira is not connected" blocker with Confirm never
 *   enabled.
 * - JK4 Admin → Ideas: the four groups render, the Jira pull section has
 *   only "Max issues per project", select-type mapping rows carry "Create
 *   missing options", the read-only Reporter/Assignee rows show the "Read on
 *   import" policy with Kela's P_Reporter / P_Assignee, and PUT normalizes
 *   pull.maxIssues (above 10000 → 10000, fraction → floor, 0 → default).
 * No live-Jira test: the pull only runs inside the LLM import, which this
 * suite never triggers; jiraTestEnv() gates the token-less connection row
 * JK3 seeds (never over a real one).
 *
 * Orgs: JK1's UI half runs as the RoomLens PM-OS admin (product-line writes
 * are admin-only and the Kela QA user is a plain USER) on QA-JK rows in the
 * RoomLens workspace, with the per-org {ideas: true} override set in
 * beforeAll and cleared in afterAll (all-pages.spec.ts depends on the
 * default). JK2/JK3 run as the Kela QA user (ideas on per org from the seed,
 * Product Line mapped to "Module"). JK4 runs as the RoomLens admin against
 * the Kela org in Admin → Ideas.
 *
 * State discipline: beforeAll deletes and recreates every fixture row (QA-JK
 * prefixes, KQA- Jira keys, ticket ids 4711-4713), afterAll deletes them,
 * removes the token-less Jira row JK3 needs for the button gate and restores
 * the Kela workspace's seeded ideasConfig byte for byte. No test depends on
 * another having run. All tests write data.
 */

const ROOMLENS_SLUG = "roomlens";

// RoomLens fixtures (JK1)
const RL_LINE = "QA-JK Billing";
const RL_ALIAS_SEEDED = "QA-JK Invoicing";
const RL_ALIAS_ADDED = "QA-JK Payments";

// Kela fixtures (JK2/JK3)
const LINE_ALPHA = "QA-JK Alpha";
const LINE_BETA = "QA-JK Beta";
const LINE_GAMMA = "QA-JK Gamma";
const KELA_LINES = [LINE_ALPHA, LINE_BETA, LINE_GAMMA];
const JIRA_PREFIX = "KQA-";
const JIRA_BACKLOG = `${JIRA_PREFIX}1`; // status Backlog, no ticket
const JIRA_DONE = `${JIRA_PREFIX}2`; // status Done, no ticket → hidden by default
const JIRA_DONE_TICKET = `${JIRA_PREFIX}3`; // status Done + a ticket → visible
const TICKET_DONE = "4711"; // numeric → ZEN-4711
const TICKET_ALPHA = "4712";
const TICKET_BETA = "4713";
const KELA_TICKET_IDS = [TICKET_DONE, TICKET_ALPHA, TICKET_BETA];
const BACKLOG_TITLE = "QA-JK backlog idea";
const DONE_TITLE = "QA-JK shipped idea";
const DONE_TICKET_TITLE = "QA-JK shipped with ticket";
const APPROVED_ALPHA_TITLE = "QA-JK approved alpha export";
const APPROVED_BETA_TITLE = "QA-JK approved beta import";
const KELA_TITLES = [
  BACKLOG_TITLE,
  DONE_TITLE,
  DONE_TICKET_TITLE,
  APPROVED_ALPHA_TITLE,
  APPROVED_BETA_TITLE,
];
const JIRA_CREATED_ISO = "2026-03-05T12:00:00.000Z";
const JIRA_REPORTER = "Noa Reporter (QA)";
const JIRA_ASSIGNEE = "Eitan Assignee (QA)";
const QA_JK_CLOUD = "qa-jk-cloud";

const NOT_CONNECTED_BLOCKER = "Jira is temporarily unavailable — Sync to Jira is paused. Contact support@pm-os.io.";
const READ_POLICY = "Read on import — shown on the raw Jira issue, never written";

let roomlensOrgId: string;
let roomlensWorkspaceId: string;
let kelaOrgId: string;
let kelaWorkspaceId: string;
/** The seeded Kela ideasConfig (the partial scripts/seed-test-db.mjs writes) — restored in afterAll. */
let kelaSeededConfig: unknown;

async function deleteRoomLensFixtures(db: PrismaClient): Promise<void> {
  await db.productLine.deleteMany({
    where: { workspaceId: roomlensWorkspaceId, name: { startsWith: "QA-JK " } },
  });
}

async function deleteKelaFixtures(db: PrismaClient): Promise<void> {
  await db.idea.deleteMany({ where: { workspaceId: kelaWorkspaceId, title: { in: KELA_TITLES } } });
  await db.zendeskTicketRaw.deleteMany({
    where: { workspaceId: kelaWorkspaceId, externalId: { in: KELA_TICKET_IDS } },
  });
  await db.jiraIdeaSnapshot.deleteMany({
    where: { workspaceId: kelaWorkspaceId, key: { startsWith: JIRA_PREFIX } },
  });
  await db.productLine.deleteMany({
    where: { workspaceId: kelaWorkspaceId, name: { in: KELA_LINES } },
  });
  await db.jiraConnection.deleteMany({ where: { workspaceId: kelaWorkspaceId, cloudId: QA_JK_CLOUD } });
}

test.describe("Ideas — Kela Jira support (aliases, Jira status, Sync to Jira, Admin → Ideas)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const roomlens = await db.organization
        .findUnique({ where: { slug: ROOMLENS_SLUG }, include: { workspace: true } })
        .catch((e) => {
          throw new Error(
            `ideas-jira-kela spec could not reach the QA org — did you run ` +
              `\`npm run test:db:setup\`? (${e instanceof Error ? e.message : e})`
          );
        });
      const kela = await db.organization.findUnique({
        where: { slug: QA_KELA.slug },
        include: { workspace: true },
      });
      if (!roomlens?.workspace || !kela?.workspace) {
        throw new Error("RoomLens / Kela QA org or workspace missing — run `npm run test:db:setup`.");
      }
      roomlensOrgId = roomlens.id;
      roomlensWorkspaceId = roomlens.workspace.id;
      kelaOrgId = kela.id;
      kelaWorkspaceId = kela.workspace.id;
      kelaSeededConfig = kela.workspace.ideasConfig;

      // Ideas on for RoomLens via the per-org override (env default stays off).
      await db.organization.update({
        where: { id: roomlens.id },
        data: { features: { ideas: true } },
      });

      await deleteRoomLensFixtures(db);
      await deleteKelaFixtures(db);

      // ——— RoomLens: one line with one alias, for the Settings edit path ———
      const lastRl = await db.productLine.findFirst({
        where: { workspaceId: roomlensWorkspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      await db.productLine.create({
        data: {
          workspaceId: roomlensWorkspaceId,
          name: RL_LINE,
          description: "QA fixture line — alias editing.",
          aliases: [RL_ALIAS_SEEDED],
          position: (lastRl?.position ?? -1) + 1,
        },
      });

      // ——— Kela: catalog lines, tickets, Jira snapshots, ideas ———
      const lastKela = await db.productLine.findFirst({
        where: { workspaceId: kelaWorkspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      let pos = (lastKela?.position ?? -1) + 1;
      for (const name of KELA_LINES) {
        await db.productLine.create({
          data: { workspaceId: kelaWorkspaceId, name, description: "QA fixture line.", position: pos++ },
        });
      }

      const ticket = (externalId: string, subject: string) =>
        db.zendeskTicketRaw.create({
          data: {
            workspaceId: kelaWorkspaceId,
            externalId,
            subject,
            body: `QA fixture ticket ${externalId}.`,
            requester: "Rivka Stern (QA)",
            tags: ["qa-fixture"],
            raw: {},
            catalogKind: "fr",
            catalogReason: "QA fixture verdict",
          },
        });
      const tDone = await ticket(TICKET_DONE, "Already shipped in Jira, still asked for");
      const tAlpha = await ticket(TICKET_ALPHA, "Alpha export please");
      const tBeta = await ticket(TICKET_BETA, "Beta import please");

      // Live-state snapshots exactly as the Jira pull persists them — the
      // mapped Module value lands in `components`, the read-only fields in
      // their own columns.
      for (const [key, title, status] of [
        [JIRA_BACKLOG, BACKLOG_TITLE, "Backlog"],
        [JIRA_DONE, DONE_TITLE, "Done"],
        [JIRA_DONE_TICKET, DONE_TICKET_TITLE, "Done"],
      ] as const) {
        await db.jiraIdeaSnapshot.create({
          data: {
            workspaceId: kelaWorkspaceId,
            key,
            title,
            body: `QA fixture Jira issue ${key} — description text.`,
            status,
            components: ["Platform"],
            issueType: "Story",
            priority: "Medium",
            reporter: JIRA_REPORTER,
            assignee: JIRA_ASSIGNEE,
            sourceCreatedAt: new Date(JIRA_CREATED_ISO),
          },
        });
      }

      // Jira-origin ideas: the untouched backlog (Backlog / Done) and a Done
      // issue a ticket was matched to this batch (Updated, pending).
      await db.idea.create({
        data: {
          workspaceId: kelaWorkspaceId,
          title: BACKLOG_TITLE,
          details: "QA fixture idea — open in Jira.",
          products: [LINE_ALPHA],
          batchStatus: "unchanged",
          decision: "pending",
          origin: "jira",
          existingVotes: 2,
          sources: { create: [{ kind: "jira", jiraKey: JIRA_BACKLOG }] },
        },
      });
      await db.idea.create({
        data: {
          workspaceId: kelaWorkspaceId,
          title: DONE_TITLE,
          details: "QA fixture idea — shipped in Jira, nobody asked.",
          products: [LINE_ALPHA],
          batchStatus: "unchanged",
          decision: "pending",
          origin: "jira",
          existingVotes: 1,
          sources: { create: [{ kind: "jira", jiraKey: JIRA_DONE }] },
        },
      });
      await db.idea.create({
        data: {
          workspaceId: kelaWorkspaceId,
          title: DONE_TICKET_TITLE,
          details: "QA fixture idea — shipped in Jira, a ticket still asks for it.",
          products: [LINE_GAMMA],
          batchStatus: "updated",
          decision: "pending",
          origin: "jira",
          existingVotes: 1,
          newVotes: 1,
          sources: {
            create: [
              { kind: "jira", jiraKey: JIRA_DONE_TICKET },
              { kind: "zendesk", ticketId: tDone.id },
            ],
          },
        },
      });
      // Two approved Zendesk ideas, one per line — the "Ready to sync" rows.
      for (const [title, line, t] of [
        [APPROVED_ALPHA_TITLE, LINE_ALPHA, tAlpha],
        [APPROVED_BETA_TITLE, LINE_BETA, tBeta],
      ] as const) {
        await db.idea.create({
          data: {
            workspaceId: kelaWorkspaceId,
            title,
            details: "QA fixture idea — approved, ready to sync.",
            products: [line],
            batchStatus: "new",
            decision: "reviewed",
            origin: "zendesk",
            newVotes: 1,
            sources: { create: [{ kind: "zendesk", ticketId: t.id }] },
          },
        });
      }

      // The Sync to Jira button is gated on a Jira integration row existing;
      // a token-less row satisfies the gate and the preview treats it as not
      // connected (same recipe as ideas-jira-push.spec.ts). The seed removes
      // any Kela connection when JIRA_TEST_* is absent, so this only runs
      // when the live specs would skip anyway.
      if (!jiraTestEnv()) {
        const other = await db.jiraConnection.findUnique({ where: { workspaceId: kelaWorkspaceId } });
        if (other && other.cloudId !== QA_JK_CLOUD) {
          throw new Error(
            `Kela QA already has a Jira connection (${other.siteUrl}) without JIRA_TEST_* env — refusing to overwrite it.`
          );
        }
        await db.jiraConnection.upsert({
          where: { workspaceId: kelaWorkspaceId },
          create: {
            workspaceId: kelaWorkspaceId,
            cloudId: QA_JK_CLOUD,
            siteUrl: "https://qa-jk.atlassian.net",
            accessToken: "",
            refreshToken: "",
            expiresAt: new Date(0),
            projectKeys: JSON.stringify(["KQA"]),
          },
          update: {},
        });
      }
    });
  });

  test.afterAll(async () => {
    await withTestDb(async (db) => {
      await deleteRoomLensFixtures(db);
      await deleteKelaFixtures(db);
      await db.workspace.update({
        where: { id: kelaWorkspaceId },
        data: { ideasConfig: (kelaSeededConfig ?? {}) as Prisma.InputJsonValue },
      });
      // Back to the env default (ideas off) — all-pages.spec.ts depends on it.
      await db.organization.update({
        where: { slug: ROOMLENS_SLUG },
        data: { features: {} },
      });
    });
  });

  // ——— Shared selectors ———

  /** An idea row on the Final page (the only cursor-pointer divs there). */
  function ideaRow(page: Page, title: string) {
    return page.locator("div.cursor-pointer", { hasText: title });
  }

  /** The multi-select popover (one open at a time) and its backdrop. */
  const popover = (page: Page) => page.locator("div.z-\\[25\\]");
  const closePopover = async (page: Page) => {
    await page.locator("div.z-\\[24\\]").click({ position: { x: 4, y: 4 } });
    await expect(popover(page)).toHaveCount(0);
  };

  /** Pick a Status option (single-select: closes on pick). */
  async function pickStatus(page: Page, label: string) {
    await page.getByRole("button", { name: /^Status/ }).click();
    await popover(page).getByRole("button", { name: label, exact: true }).click();
    await expect(popover(page)).toHaveCount(0);
  }

  /** A labelled field on the raw Jira issue / ticket view: `<span.inline-flex><label><value>`. */
  function field(page: Page, scope: Locator, label: string) {
    return scope.locator("span.inline-flex", { has: page.getByText(label, { exact: true }) });
  }

  /** A field-mapping row on /admin/ideas, scoped by its attribute label. */
  function fieldRow(page: Page, label: string) {
    return page.locator("div.rounded-lg", { has: page.getByText(label, { exact: true }) });
  }

  async function gotoKelaIdeas(page: Page) {
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();
    // Positive anchor before any absence assert: the state fetch has landed.
    await expect(ideaRow(page, APPROVED_ALPHA_TITLE)).toBeVisible();
  }

  test("JK1 product-line aliases: Settings edit field round-trips (trimmed, deduped, own name dropped), duplicate name is 409, and the resolver maps every spelling to the catalog name", async ({
    page,
  }) => {
    await loginAsRoomLensAdmin(page);
    await page.goto("/settings/ideas/product-lines");
    const panel = page.locator("section", {
      has: page.getByRole("heading", { name: "Product Lines", exact: true }),
    });
    const row = panel.locator("div.rounded-xl", { hasText: RL_LINE });
    await expect(row).toBeVisible();
    await expect(row.getByText(`Also called: ${RL_ALIAS_SEEDED}`)).toBeVisible();

    // Edit: the comma field starts with the stored alias; add one, repeat it
    // in another case, and try to alias the line to its own name.
    await row.getByTitle("Edit").click();
    // In edit mode the name lives in an input value (hasText no longer sees
    // it); one row edits at a time, so the alias field identifies the row.
    const aliasPlaceholder = /^Aliases, comma-separated/;
    const editRow = panel.locator("div.rounded-xl", { has: page.getByPlaceholder(aliasPlaceholder) });
    await expect(editRow.locator('input[maxlength="80"]')).toHaveValue(RL_LINE);
    const aliasInput = editRow.getByPlaceholder(aliasPlaceholder);
    await expect(aliasInput).toHaveValue(RL_ALIAS_SEEDED);
    await aliasInput.fill(
      ` ${RL_ALIAS_SEEDED} ,${RL_ALIAS_ADDED},  ${RL_ALIAS_ADDED.toLowerCase()} , ${RL_LINE}`
    );
    await editRow.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText(`Also called: ${RL_ALIAS_SEEDED}, ${RL_ALIAS_ADDED}`)).toBeVisible();
    await expect(panel.getByPlaceholder(aliasPlaceholder)).toHaveCount(0);

    // Persisted exactly as shown, and the list API returns it (round-trip).
    const stored = await withTestDb((db) =>
      db.productLine.findFirstOrThrow({
        where: { workspaceId: roomlensWorkspaceId, name: RL_LINE },
        select: { id: true, aliases: true },
      })
    );
    expect(stored.aliases).toEqual([RL_ALIAS_SEEDED, RL_ALIAS_ADDED]);
    const list = await page.request.get("/api/ideas/lists/product-lines");
    expect(list.status()).toBe(200);
    const { items } = (await list.json()) as { items: { id: string; name: string; aliases: string[] }[] };
    expect(items.find((i) => i.id === stored.id)?.aliases).toEqual([RL_ALIAS_SEEDED, RL_ALIAS_ADDED]);

    // Reload: the server renders the saved aliases, not the seed.
    await page.reload();
    await expect(row.getByText(`Also called: ${RL_ALIAS_SEEDED}, ${RL_ALIAS_ADDED}`)).toBeVisible();

    // A duplicate line NAME (any case) is refused outright.
    const dup = await page.request.post("/api/ideas/lists/product-lines", {
      data: { name: RL_LINE.toLowerCase(), description: "", aliases: "" },
    });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error).toBe(`"${RL_LINE.toLowerCase()}" already exists`);
    // Release QA 3.0.0 (Dana, 2026-10-14): a name or alias means ONE product
    // line. The resolver is first-wins, so a clash would route a Module value
    // by sort order with no error anywhere — the 409 (Tomer's review fix) is
    // the only thing that makes it visible. Clash with another line's alias
    // (any spelling) and with another line's name, as a new row and as an edit.
    const CLASH_NAME = "QA-JK Ledger";
    for (const aliases of [[` ${RL_ALIAS_SEEDED.toLowerCase()} `], [RL_LINE.toUpperCase()]]) {
      const clash = await page.request.post("/api/ideas/lists/product-lines", {
        data: { name: CLASH_NAME, description: "", aliases },
      });
      expect(clash.status(), `POST aliases ${JSON.stringify(aliases)}`).toBe(409);
      expect((await clash.json()).error).toContain(`already belongs to product line "${RL_LINE}"`);
    }
    const afterClash = await page.request.get("/api/ideas/lists/product-lines");
    expect(((await afterClash.json()).items as { name: string }[]).some((i) => i.name === CLASH_NAME)).toBe(false);
    // PATCH with an array body dedupes the same way as the comma field.
    const patched = await page.request.patch("/api/ideas/lists/product-lines", {
      data: {
        id: stored.id,
        name: RL_LINE,
        description: "QA fixture line — alias editing.",
        aliases: [RL_ALIAS_ADDED, RL_ALIAS_ADDED.toUpperCase(), RL_ALIAS_SEEDED],
      },
    });
    expect(patched.status()).toBe(200);
    const patchedItems = (await patched.json()).items as { id: string; aliases: string[] }[];
    expect(patchedItems.find((i) => i.id === stored.id)?.aliases).toEqual([RL_ALIAS_ADDED, RL_ALIAS_SEEDED]);

    // The pure resolver, against the seeded Kela catalog row read from the
    // DB (name "Platform", aliases Platform General / Platform- General / API).
    const kelaCatalog = await withTestDb((db) =>
      db.productLine.findMany({
        where: { workspaceId: kelaWorkspaceId },
        select: { name: true, aliases: true },
      })
    );
    const platform = kelaCatalog.find((r) => r.name === "Platform");
    expect(platform, "seed should hold the Kela Platform row").toBeTruthy();
    expect(platform!.aliases).toEqual(["Platform General", "Platform- General", "API"]);
    const resolver = buildProductLineResolver(kelaCatalog);
    expect(resolver.resolve("Platform")).toBe("Platform");
    expect(resolver.resolve("Platform- General")).toBe("Platform");
    expect(resolver.resolve("Platform General")).toBe("Platform");
    expect(resolver.resolve("  platform-general ")).toBe("Platform");
    expect(resolver.resolve("API")).toBe("Platform");
    expect(resolver.resolve("api")).toBe("Platform");
    expect(resolver.resolve("Mobile App")).toBeUndefined();
    expect(resolver.resolve("")).toBeUndefined();
    expect(resolver.spellings("platform")).toEqual([
      "Platform",
      "Platform General",
      "Platform- General",
      "API",
    ]);
    expect(resolver.spellings("Nope")).toEqual(["Nope"]);
  });

  test("JK2 Jira status on ideas: the Jira Status filter, Done-without-ticket hidden by default, status chip + ZEN label on rows, raw Jira issue fields and All fields in the drawer", async ({
    page,
  }) => {
    await loginAsKelaQa(page);
    await gotoKelaIdeas(page);

    // Default scope: the Done idea a ticket asks for shows (Updated), with
    // the numeric ticket id as ZEN-<id> and the Jira status chip.
    const doneTicketRow = ideaRow(page, DONE_TICKET_TITLE);
    await expect(doneTicketRow).toBeVisible();
    await expect(doneTicketRow.getByText(`ZEN-${TICKET_DONE}`, { exact: true })).toBeVisible();
    await expect(doneTicketRow.getByText(JIRA_DONE_TICKET, { exact: true })).toBeVisible();
    await expect(doneTicketRow.locator('span[title="Status in Jira"]')).toHaveText("Done");

    // Status: All reveals the unchanged backlog — except the Done issue no
    // ticket asks for, which stays hidden until Jira Status says otherwise.
    await pickStatus(page, "All");
    const backlogRow = ideaRow(page, BACKLOG_TITLE);
    await expect(backlogRow).toBeVisible();
    await expect(backlogRow.locator('span[title="Status in Jira"]')).toHaveText("Backlog");
    await expect(ideaRow(page, DONE_TITLE)).toHaveCount(0);

    // Jira Status lists the pulled statuses (sorted); picking Done shows the
    // shipped ideas only; the chip clears it.
    await page.getByRole("button", { name: /^Jira Status/ }).click();
    const options = popover(page).getByRole("button");
    await expect(options.filter({ hasText: /^Backlog$/ })).toHaveCount(1);
    await expect(options.filter({ hasText: /^Done$/ })).toHaveCount(1);
    await popover(page).getByRole("button", { name: "Done", exact: true }).click();
    await closePopover(page);
    const doneChip = page.getByRole("button", { name: "Jira: Done ✕" });
    await expect(doneChip).toBeVisible();
    await expect(ideaRow(page, DONE_TITLE)).toBeVisible();
    await expect(doneTicketRow).toBeVisible();
    await expect(backlogRow).toHaveCount(0);
    await expect(ideaRow(page, APPROVED_ALPHA_TITLE)).toHaveCount(0);
    await doneChip.click();
    await expect(doneChip).toHaveCount(0);
    await expect(backlogRow).toBeVisible();
    await expect(ideaRow(page, DONE_TITLE)).toHaveCount(0);

    // Drawer → the Jira source → the raw issue: the PM's fields on top, the
    // product line labelled with the mapped Jira field ("Module" for Kela).
    await backlogRow.click();
    const drawer = page.locator("div.fixed.bottom-0.right-0.top-0");
    await expect(drawer.getByRole("heading", { name: BACKLOG_TITLE })).toBeVisible();
    await drawer.getByRole("button", { name: new RegExp(JIRA_BACKLOG) }).click();
    const issueTag = drawer.getByText(`Jira issue ${JIRA_BACKLOG}`, { exact: true });
    await expect(issueTag).toBeVisible();
    await expect(field(page, drawer, "Module")).toContainText("Platform");
    await expect(field(page, drawer, "Status")).toContainText("Backlog");
    await expect(field(page, drawer, "Assignee")).toContainText(JIRA_ASSIGNEE);
    await expect(field(page, drawer, "Reporter")).toContainText(JIRA_REPORTER);
    await expect(field(page, drawer, "Created")).toContainText("Mar 5, 2026");
    await expect(drawer.getByText("Product line", { exact: true })).toHaveCount(0);
    await expect(drawer.getByText(`QA fixture Jira issue ${JIRA_BACKLOG} — description text.`)).toBeVisible();

    // All fields: collapsed by default; expanded it lists every field, type
    // and priority included (they live only here).
    const allFields = drawer.getByRole("button", { name: /^All fields \(\d+\)$/ });
    await expect(allFields).toHaveText("All fields (10)");
    await expect(allFields).toHaveAttribute("aria-expanded", "false");
    await expect(drawer.locator("dl")).toHaveCount(0);
    await allFields.click();
    await expect(allFields).toHaveAttribute("aria-expanded", "true");
    const dl = drawer.locator("dl");
    await expect(dl.locator("dt")).toHaveText([
      "Key",
      "Type",
      "Status",
      "Priority",
      "Module",
      "Reporter",
      "Assignee",
      "Created",
      "Link",
    ]);
    await expect(dl.locator("dd").nth(0)).toHaveText(JIRA_BACKLOG);
    await expect(dl.locator("dd").nth(1)).toHaveText("Story");
    await expect(dl.locator("dd").nth(3)).toHaveText("Medium");

    // Back to the idea.
    await drawer.getByTitle("Back to idea").click();
    await expect(drawer.getByRole("heading", { name: BACKLOG_TITLE })).toBeVisible();
    await expect(issueTag).toHaveCount(0);
  });

  test("JK3 Sync to Jira dialog: Ready / Nothing to sync sections with counts, disabled idle rows, Clear / Select all, scope hint, and the not-connected blocker on Preview", async ({
    page,
  }) => {
    await loginAsKelaQa(page);
    await gotoKelaIdeas(page);

    // Two approved ideas + a connection row → the button is live and reads
    // "Sync to Jira" (not "Jira Merge").
    await expect(page.getByRole("button", { name: "Jira Merge" })).toHaveCount(0);
    const syncButton = page.getByRole("button", { name: "Sync to Jira" });
    await expect(syncButton).toBeVisible();
    await expect(syncButton).toBeEnabled();
    await syncButton.click();

    const modal = page.locator("div.fixed.inset-0.z-50");
    await expect(modal.getByRole("heading", { name: "Sync to Jira" })).toBeVisible();

    // Ready: the two lines with an approved idea, every one selected by
    // default (no My Product Lines for this user) → header offers "Clear".
    const idleCount = await withTestDb(
      async (db) => (await db.productLine.count({ where: { workspaceId: kelaWorkspaceId } })) - 2
    );
    await expect(modal.getByText("Ready to sync · 2")).toBeVisible();
    await expect(modal.getByText(`Nothing to sync · ${idleCount}`)).toBeVisible();
    const lineRow = (name: string) => modal.getByRole("button").filter({ hasText: name });
    await expect(lineRow(LINE_ALPHA)).toBeEnabled();
    await expect(lineRow(LINE_ALPHA)).toContainText("1 approved");
    await expect(lineRow(LINE_BETA)).toBeEnabled();
    await expect(lineRow(LINE_BETA)).toContainText("1 approved");
    // Idle rows are disabled: the line with only a pending idea says so, the
    // seeded Platform line has no changes at all.
    await expect(lineRow(LINE_GAMMA)).toBeDisabled();
    await expect(lineRow(LINE_GAMMA)).toContainText("1 pending");
    await expect(lineRow("Platform")).toBeDisabled();
    await expect(lineRow("Platform")).toContainText("no changes");
    await expect(modal.getByText("2 approved changes will sync — 1 still pending stays here")).toBeVisible();
    const preview = modal.getByRole("button", { name: "Preview changes" });
    await expect(preview).toBeEnabled();

    // Clear → nothing selected: hint flips, Preview disabled, header offers
    // Select all; Select all restores everything.
    await modal.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(modal.getByText("Nothing approved in the selected product lines")).toBeVisible();
    await expect(preview).toBeDisabled();
    await modal.getByRole("button", { name: "Select all", exact: true }).click();
    await expect(modal.getByText("2 approved changes will sync — 1 still pending stays here")).toBeVisible();
    await expect(preview).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Clear", exact: true })).toBeVisible();

    // Deselecting one ready line narrows the hint (the pending idea is in
    // Gamma, outside a Beta-only scope, so no "still pending" tail) and the
    // header goes back to Select all.
    await lineRow(LINE_ALPHA).click();
    await expect(modal.getByText("1 approved change will sync", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Select all", exact: true })).toBeVisible();
    // Re-picking Alpha makes the scope the two explicit lines (not "every
    // line"), so Gamma's pending idea stays out of the hint.
    await lineRow(LINE_ALPHA).click();
    await expect(modal.getByText("2 approved changes will sync", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Clear", exact: true })).toBeVisible();

    // Preview without a usable Jira token: the blocker renders and the
    // confirm button never enables.
    await preview.click();
    await expect(modal.getByText(NOT_CONNECTED_BLOCKER)).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Confirm sync/ })).toBeDisabled();
    await expect(modal.getByRole("button", { name: /^Confirm merge/ })).toHaveCount(0);

    // Esc closes the dialog; nothing was written.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    const decisions = await withTestDb((db) =>
      db.idea.findMany({
        where: { workspaceId: kelaWorkspaceId, title: { in: [APPROVED_ALPHA_TITLE, APPROVED_BETA_TITLE] } },
        select: { decision: true },
      })
    );
    expect(decisions.map((d) => d.decision)).toEqual(["reviewed", "reviewed"]);
  });

  test("JK4 Admin → Ideas: Stats / Jira / Zendesk / AI groups, Jira pull has only the max-issues ceiling, select rows carry Create missing options, read-only Reporter/Assignee rows, PUT clamps pull.maxIssues", async ({
    page,
  }) => {
    await loginAsRoomLensAdmin(page);
    await page.goto("/admin/ideas");
    await expect(page.getByRole("heading", { name: "Ideas", exact: true })).toBeVisible();

    // The four groups, in order.
    const groups = page.locator("h2.text-base");
    await expect(groups).toHaveText(["Stats", "Jira", "Zendesk", "AI"]);

    // Anchor on client-fetched content before touching the org <select>
    // (hydration race: a pre-hydration selectOption is a DOM change React
    // never sees).
    const runsCard = page.locator("section.rounded-xl", { has: page.getByRole("heading", { name: "Import runs" }) });
    await expect(
      runsCard.locator("tbody tr").first().or(runsCard.getByText("No imports yet for this organization."))
    ).toBeVisible();
    await page
      .locator("label", { hasText: "Organization" })
      .locator("select")
      .selectOption({ label: `Kela QA (${QA_KELA.slug})` });

    // Jira pull: exactly one control — the per-project ceiling, at the seeded 10000.
    const pull = page.locator("section.rounded-xl", { has: page.getByRole("heading", { name: "Jira pull" }) });
    await expect(pull).toBeVisible();
    await expect(pull.getByText("Max issues per project (ceiling 10,000)")).toBeVisible();
    await expect(pull.locator("input")).toHaveCount(1);
    await expect(pull.locator("input")).toHaveValue("10000");
    await expect(pull.locator("input")).toHaveAttribute("max", "10000");

    // Field mapping, Kela's config: Product Line → Module (single select)
    // with the Create missing options toggle; Votes (number) without it;
    // Customers as prefixed Labels by default (2026-10-20: no admin right
    // needed) — a type switch, a prefix, no Create missing options.
    const productLine = fieldRow(page, "Product Line");
    await expect(productLine.locator('input[type="text"]')).toHaveValue("Module");
    await expect(productLine.getByText("Single select")).toBeVisible();
    await expect(productLine.getByText("Set only when empty (never replace a human's value)")).toBeVisible();
    await expect(productLine.getByText("Create missing options")).toBeVisible();
    await expect(productLine.getByRole("checkbox").nth(1)).not.toBeChecked();
    await expect(fieldRow(page, "Votes").getByText("Create missing options")).toHaveCount(0);
    const customers = fieldRow(page, "Customers");
    await expect(customers.locator("select")).toHaveValue("labels");
    await expect(customers.locator('input[type="text"]').nth(1)).toHaveValue("cs_");
    await expect(customers.getByText("Create missing options")).toHaveCount(0);

    // Read-only rows: Kela's P_Reporter / P_Assignee, text type, read policy,
    // no create-options toggle.
    for (const [label, jiraField] of [
      ["Reporter", "P_Reporter"],
      ["Assignee", "P_Assignee"],
    ] as const) {
      const row = fieldRow(page, label);
      await expect(row.locator('input[type="text"]')).toHaveValue(jiraField);
      await expect(row.getByText("Text", { exact: true })).toBeVisible();
      await expect(row.getByText(READ_POLICY)).toBeVisible();
      await expect(row.getByText("Create missing options")).toHaveCount(0);
    }

    // PUT normalizes pull.maxIssues through mergeIdeasJiraConfig — the same
    // function the pull reads: above the ceiling → 10000, fraction → floor,
    // non-positive → the default.
    const put = (pull: unknown) =>
      page.request.put(`/api/admin/organizations/${kelaOrgId}/ideas-config`, { data: { pull } });
    const over = await put({ maxIssues: 99_999 });
    expect(over.status()).toBe(200);
    expect((await over.json()).config.pull.maxIssues).toBe(10_000);
    const stored = await withTestDb(async (db) => {
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: kelaWorkspaceId } });
      return (ws.ideasConfig as { pull: { maxIssues: number } }).pull.maxIssues;
    });
    expect(stored).toBe(10_000);
    expect((await (await put({ maxIssues: 250.7 })).json()).config.pull.maxIssues).toBe(250);
    expect((await (await put({ maxIssues: 0 })).json()).config.pull.maxIssues).toBe(10_000);
    expect((await (await put("garbage")).json()).config.pull.maxIssues).toBe(10_000);

    // Restore the seeded partial so no other test inherits a replaced config.
    await withTestDb((db) =>
      db.workspace.update({
        where: { id: kelaWorkspaceId },
        data: { ideasConfig: (kelaSeededConfig ?? {}) as Prisma.InputJsonValue },
      })
    );
  });

});
