import { expect, test, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { loginAsKelaQa, QA_KELA, withTestDb } from "./helpers";

/**
 * REV-14 — customer and Jira text is rendered as text, never as HTML
 * (release QA 3.0.0, Dana, 2026-10-14).
 *
 * Why this exists: 3.0.0 added two rendering surfaces for text PM-OS does
 * not author — the raw Jira issue's description (ADF → markdown → React
 * Markdown, src/lib/jira-adf.ts + UmMarkdown) and clickable URLs inside the
 * raw Zendesk ticket text (Linkified in IdeaDrawer). Kela is a security
 * company whose Jira and Zendesk text lands in these views; a stored XSS
 * through either would cost more trust than any other defect this release
 * could ship. The silent failure this catches: someone adds rehype-raw /
 * dangerouslySetInnerHTML / a custom urlTransform to make Jira formatting
 * "look right" and raw HTML or javascript: links start executing.
 *
 * One test, three surfaces, in the Kela QA org (ideas on per org from the
 * seed). Fixtures are Prisma-seeded exactly as the import persists them
 * (ticket body as typed, Jira body as the ADF converter emits markdown,
 * idea details as the model writes markdown). Each surface has a positive
 * control (a heading / bold / an https link really renders) so an empty
 * drawer cannot pass vacuously. Nothing here calls PMOS AI or Jira.
 *
 * Assertions per surface:
 * - the literal `<script>…</script>` text is visible as text;
 * - no <script> or <img> element exists inside the rendered container;
 * - an https link renders as a link; a javascript: markdown link has no
 *   javascript: href;
 * - window.__qaXss is still undefined at the end (no payload ran).
 *
 * State discipline: beforeAll deletes and recreates the QA-XS rows (ticket
 * 4799, issue KXS-1, one idea); afterAll deletes them. Shares the Kela QA
 * org with ideas-jira-kela.spec.ts but touches only QA-XS-prefixed rows.
 */

const TICKET_ID = "4799";
const JIRA_KEY = "KXS-1";
const IDEA_TITLE = "QA-XS idea <b>title</b>";
const TICKET_SUBJECT = "QA-XS ticket <i>subject</i>";
const JIRA_TITLE = "QA-XS jira <u>title</u>";

const TICKET_URL = "https://example.com/qa-xs/ticket?x=1";
const JIRA_SAFE_URL = "https://example.com/qa-xs/jira";
const IDEA_URL = "https://example.com/qa-xs/idea";
// Bare URLs (no markdown link syntax) must render clickable too — Jira
// bodies and "Supported tickets" lists are mostly bare.
const IDEA_BARE_URL = "https://example.com/qa-xs/idea-bare?x=1";
const JIRA_BARE_URL = "https://example.com/qa-xs/jira-bare";

const SCRIPT_TICKET = `<script>window.__qaXss = "ticket"</script>`;
const SCRIPT_JIRA = `<script>window.__qaXss = "jira"</script>`;
const SCRIPT_IDEA = `<script>window.__qaXss = "idea"</script>`;
const IMG_PAYLOAD = `<img src=x onerror="window.__qaXss='img'">`;

const TICKET_BODY = `QA-XS body as typed ${SCRIPT_TICKET} ${IMG_PAYLOAD} docs at ${TICKET_URL} end.`;
const JIRA_BODY = [
  `**QA-XS bold lead**`,
  ``,
  `${SCRIPT_JIRA} ${IMG_PAYLOAD}`,
  ``,
  `[safe link](${JIRA_SAFE_URL}) and [evil link](javascript:window.__qaXss='href')`,
  ``,
  `Bare ${JIRA_BARE_URL}, pasted.`,
].join("\n");
// A line that starts with <script> opens a CommonMark HTML block that swallows
// the rest of its paragraph (rendered as text, which is the point) — so the
// link positive control lives in its own paragraph.
const IDEA_DETAILS = [
  `## QA-XS The Problem`,
  ``,
  `${SCRIPT_IDEA} ${IMG_PAYLOAD}`,
  ``,
  `See [the doc](${IDEA_URL}).`,
  ``,
  `Supported tickets: ${IDEA_BARE_URL}.`,
].join("\n");

let workspaceId: string;

async function deleteFixtures(db: PrismaClient) {
  await db.idea.deleteMany({ where: { workspaceId, title: IDEA_TITLE } });
  await db.zendeskTicketRaw.deleteMany({ where: { workspaceId, externalId: TICKET_ID } });
  await db.jiraIdeaSnapshot.deleteMany({ where: { workspaceId, key: JIRA_KEY } });
}

test.describe("Ideas — customer and Jira text is escaped (REV-14)", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const kela = await db.organization.findUnique({
        where: { slug: QA_KELA.slug },
        include: { workspace: true },
      });
      if (!kela?.workspace) throw new Error("Kela QA org missing — run `npm run test:db:setup`.");
      workspaceId = kela.workspace.id;
      await deleteFixtures(db);

      const ticket = await db.zendeskTicketRaw.create({
        data: {
          workspaceId,
          externalId: TICKET_ID,
          subject: TICKET_SUBJECT,
          body: TICKET_BODY,
          requester: "Rivka Stern (QA)",
          tags: ["qa-fixture"],
          raw: {},
          catalogKind: "fr",
          catalogReason: "QA fixture verdict",
        },
      });
      await db.jiraIdeaSnapshot.create({
        data: {
          workspaceId,
          key: JIRA_KEY,
          title: JIRA_TITLE,
          body: JIRA_BODY,
          status: "Backlog",
          components: ["Platform"],
          issueType: "Story",
          priority: "Medium",
          reporter: "Noa Reporter (QA)",
          assignee: "Eitan Assignee (QA)",
          sourceCreatedAt: new Date("2026-03-05T12:00:00.000Z"),
        },
      });
      // A ticket matched to an existing Jira issue this import: both source
      // kinds on one idea, so one drawer reaches all three surfaces.
      await db.idea.create({
        data: {
          workspaceId,
          title: IDEA_TITLE,
          details: IDEA_DETAILS,
          products: ["Platform"],
          batchStatus: "updated",
          decision: "pending",
          origin: "jira",
          existingVotes: 1,
          newVotes: 1,
          sources: {
            create: [
              { kind: "jira", jiraKey: JIRA_KEY },
              { kind: "zendesk", ticketId: ticket.id },
            ],
          },
        },
      });
    });
  });

  test.afterAll(async () => {
    await withTestDb(deleteFixtures);
  });

  const drawerOf = (page: Page) => page.locator("div.fixed.bottom-0.right-0.top-0");

  test("REV-14 idea text, raw Jira description and raw Zendesk ticket text render as text: no script/img elements, no javascript: hrefs, https links kept", async ({
    page,
  }) => {
    await loginAsKelaQa(page);
    await page.goto("/ideas");
    await expect(page.getByRole("heading", { name: "Ideas" })).toBeVisible();

    const row = page.locator("div.cursor-pointer", { hasText: "QA-XS idea" });
    await expect(row).toBeVisible();
    // The title's tags are text, not markup.
    await expect(row.getByText(IDEA_TITLE, { exact: true })).toBeVisible();
    await expect(row.locator("b")).toHaveCount(0);

    // ——— Surface 1: idea details (markdown, .idea-text) ———
    await row.click();
    const drawer = drawerOf(page);
    await expect(drawer.getByRole("heading", { name: IDEA_TITLE })).toBeVisible();
    const ideaText = drawer.locator(".idea-text");
    await expect(ideaText).toBeVisible();
    await expect(ideaText.getByRole("heading", { name: "QA-XS The Problem" })).toBeVisible(); // positive control
    await expect(ideaText.getByText(SCRIPT_IDEA, { exact: false })).toBeVisible();
    await expect(ideaText.getByText(IMG_PAYLOAD, { exact: false })).toBeVisible();
    await expect(ideaText.locator("script, img")).toHaveCount(0);
    await expect(ideaText.locator(`a[href="${IDEA_URL}"]`)).toHaveText("the doc");
    // A bare URL is a link whose text is the URL; the trailing "." stays outside.
    await expect(ideaText.locator(`a[href="${IDEA_BARE_URL}"]`)).toHaveText(IDEA_BARE_URL);

    // ——— Surface 2: raw Jira issue description (ADF → markdown, .source-text) ———
    await drawer.getByRole("button", { name: new RegExp(JIRA_KEY) }).click();
    await expect(drawer.getByText(`Jira issue ${JIRA_KEY}`, { exact: true })).toBeVisible();
    await expect(drawer.getByText(JIRA_TITLE, { exact: true })).toBeVisible();
    await expect(drawer.locator("u")).toHaveCount(0);
    const jiraText = drawer.locator(".source-text");
    await expect(jiraText).toBeVisible();
    await expect(jiraText.locator("strong")).toHaveText("QA-XS bold lead"); // positive control
    await expect(jiraText.getByText(SCRIPT_JIRA, { exact: false })).toBeVisible();
    await expect(jiraText.getByText(IMG_PAYLOAD, { exact: false })).toBeVisible();
    await expect(jiraText.locator("script, img")).toHaveCount(0);
    await expect(jiraText.getByRole("link", { name: "safe link" })).toHaveAttribute("href", JIRA_SAFE_URL);
    await expect(jiraText.locator(`a[href="${JIRA_BARE_URL}"]`)).toHaveText(JIRA_BARE_URL);
    const evil = jiraText.getByText("evil link", { exact: true });
    await expect(evil).toBeVisible();
    // React Markdown's default urlTransform drops unsafe protocols: the link
    // renders with no href (or an empty one) — never javascript:.
    const evilHref = await jiraText.locator("a", { hasText: "evil link" }).first().getAttribute("href").catch(() => null);
    expect(evilHref ?? "", "javascript: href must not survive").not.toMatch(/^\s*javascript:/i);

    // ——— Surface 3: raw Zendesk ticket text (Linkified) ———
    await drawer.getByTitle("Back to idea").click();
    await expect(drawer.getByRole("heading", { name: IDEA_TITLE })).toBeVisible();
    await drawer.getByRole("button", { name: new RegExp(TICKET_ID) }).click();
    await expect(drawer.getByText(`Zendesk ticket ${TICKET_ID}`)).toBeVisible();
    await expect(drawer.getByText(TICKET_SUBJECT, { exact: true })).toBeVisible();
    await expect(drawer.locator("i")).toHaveCount(0);
    const ticketText = drawer.locator("div.whitespace-pre-wrap", { hasText: "QA-XS body as typed" });
    await expect(ticketText).toBeVisible();
    await expect(ticketText).toContainText(SCRIPT_TICKET);
    await expect(ticketText).toContainText(IMG_PAYLOAD);
    await expect(ticketText.locator("script, img")).toHaveCount(0);
    const ticketLink = ticketText.locator(`a[href="${TICKET_URL}"]`); // positive control
    await expect(ticketLink).toHaveText(TICKET_URL);
    await expect(ticketLink).toHaveAttribute("rel", /noopener/);

    // No payload ran anywhere on the page.
    expect(await page.evaluate(() => (window as unknown as { __qaXss?: string }).__qaXss)).toBeUndefined();
  });
});
