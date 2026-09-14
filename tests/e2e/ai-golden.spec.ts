import { expect, test } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loginWithTotp, seedQaOrgWithUser, withTestDb } from "./helpers";

/**
 * @ai — the release golden run (release QA 2.0.0, docs/release-qa.md "AI
 * layer A1"). ONE live upload of the RoomLens golden corpus through the real
 * "Upload Zendesk CSV" button against real PMOS AI (Vertex, ADC on this
 * machine); every other case reads that run's output. Never runs in CI
 * (.github/workflows/e2e.yml passes --grep-invert @ai — no Vertex creds
 * there). Two attempts per release; a second miss is a finding, not a retry.
 *
 * Fixture: tests/fixtures/roomlens-golden-v2.csv (10 corpus tickets from
 * pmos-office/office/content/roomlens-seed-corpus-v2.md + QA ticket 031, a
 * deliberate two-ask ticket for the split stage, + row 032 with neither
 * subject nor body) and the per-stage answer key next to it
 * (roomlens-golden-v2.key.json — generated together, they cannot drift).
 *
 * Runs in its own QA org "QA Golden RoomLens" (slug qa-golden) with its own
 * TOTP user — the RoomLens QA workspace is shared by every other spec and
 * holds developer data on dev clones, so "empty workspace" is guaranteed by
 * construction, not by Clear import. The org is recreated in beforeAll and
 * deliberately NOT deleted in afterAll: Daniel's human read of the ten ideas
 * (release-qa.md "A2") happens on this output after the run.
 *
 * Steps (one test.step per inventory case so the report settles them):
 *   cost guard  — total AI calls ≤ key.maxAiCalls before anything else
 *   IMP-01  upload completes: batch completed, error null, imported 10,
 *           UI note says 1 empty row skipped, ≤ 180 s, ideas listed
 *   IMP-02  classify kind vs key on ≥ 8 of the 10 corpus tickets; only fr
 *           tickets became ideas
 *   IMP-03  parked kinds: bugs 2, needs-details 1, none has an idea
 *   IMP-04  ticket 031 split into ≥ 2 units; every child idea carries the
 *           parent's customer, reporter, and the ticket keeps module /
 *           why-build / insights / deal / type / url
 *   IMP-05  021 + 022 merged into one idea with 2 votes; zero false merges;
 *           idea count in range; no empty titles
 *   IMP-08  raw row of 021 (quoted multi-line body) stored byte-equal
 *   IMP-10  trace: every stage present, none in error, ledger rows == AI
 *           calls, cached share ≥ 70 % on classify + match, heartbeat moved
 *   IMP-11  truth customers → catalog; text-only names → suggested (not in
 *           catalog); "All customers" cell → affectsAllCustomers
 *   IMP-13  matchNotes per FR unit (idea, merged flag, reason); parked
 *           tickets carry none
 *   REV-01  status card "N of M awaiting review" moves after one approval
 *   IMP-06  second upload of the same file: 10 duplicates, 0 imported, no
 *           AI stage ran, no new ideas, no new ledger rows
 *
 * Assertions are threshold-style and read DB + API, never exact idea text.
 * Threshold checks (calls, duration, accuracy, cache share, ledger==calls)
 * are expect.soft so one miss is recorded without hiding the cases that
 * follow it; structural checks (merge pair, split, raw row) stay hard.
 * UI assertions are limited to what feature/face_lift_v2 does not touch
 * (upload button, import note, status-card text); chip/drawer rendering of
 * customers and PMOS AI reading (IMP-11/13 UI halves) are asserted from the
 * API state instead — a v2 selector change would be a TCR, not a finding.
 */

const FIXTURE = resolve(__dirname, "../fixtures/roomlens-golden-v2.csv");
const KEY = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/roomlens-golden-v2.key.json"), "utf8")
) as {
  ticketsSent: number;
  skippedRows: number;
  kinds: Record<string, string[]>;
  classifyMinCorrect: number;
  parked: { bugs: number; needsDetails: number };
  mustMerge: [string, string];
  multiProblemTicket: string;
  ideaCountRange: [number, number];
  truthCustomers: string[];
  textCustomers: Record<string, string>;
  allCustomersTicket: string;
  raw021: { subject: string; description: string };
  ticket031: { customer_name: string; module: string; requester: string };
  maxAiCalls: number;
  maxDurationMs: number;
  minCachedShare: number;
};

const ORG = { orgName: "QA Golden RoomLens", slug: "qa-golden" };
const GOLDEN_USER = {
  name: "QA Golden PM",
  email: "qa+golden@pm-os.io",
  password: "Golden-qa-pass1",
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", // synthetic, test-only
};
// Corpus prerequisite: Categorize's product lines (corpus doc, "Prerequisites").
const PRODUCT_LINES = [
  "Staging Engine", "Declutter", "Shop the Look", "Retailer Integrations",
  "Boards & Sharing", "Mobile Capture", "AR Preview", "Analytics", "Platform & API",
];
const UPLOAD_TIMEOUT_MS = 240_000;

interface ApiIdea {
  id: string;
  title: string;
  customers: string[];
  reporters: string[];
  zen: string[];
  decision: string;
  batch: string;
  newVotes: number;
}
interface ApiState {
  ideas: ApiIdea[];
  tickets: { id: string }[];
  customerCatalog: string[];
}
interface Stage {
  stage: string;
  kind: string;
  calls?: number;
  error?: string;
  tokens?: { input: number; cacheRead: number };
}

let workspaceId: string;

const lower = (s: string) => s.trim().toLowerCase();

test.describe("@ai golden run — one live upload of the RoomLens corpus", () => {
  test.beforeAll(async () => {
    await withTestDb(async (db) => {
      const seeded = await seedQaOrgWithUser(db, {
        ...ORG,
        // Prod-parity flags for an onboarded org: Ideas on, the off modules off.
        features: { ideas: true, dashboard: false, docs: false, chat: false },
        user: GOLDEN_USER,
      });
      workspaceId = seeded.workspaceId;
      await db.productLine.createMany({
        data: PRODUCT_LINES.map((name, position) => ({
          workspaceId, name, description: "", position,
        })),
      });
    });
  });

  test("@ai IMP-01/02/03/04/05/06/08/10/11/13 + REV-01: golden corpus through the real upload button", async ({ page }) => {
    // Two live uploads (≤ 240 s each) plus one TOTP login.
    test.setTimeout(600_000);

    await loginWithTotp(page, GOLDEN_USER);
    await page.goto("/ideas");
    await expect(page.getByText("No ideas yet")).toBeVisible();

    const importNote = (imported: number) =>
      page.getByText(new RegExp(`^Imported ${imported} tickets? from roomlens-golden-v2\\.csv`));
    const importError = page.getByText(/^Import failed/);

    const upload = async (imported: number) => {
      await page.locator('input[type="file"]').setInputFiles(FIXTURE);
      await expect(importNote(imported).or(importError)).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
      if (await importError.isVisible()) {
        throw new Error(`upload failed in the UI: ${await importError.innerText()}`);
      }
      return (await importNote(imported).innerText()).trim();
    };

    const latestBatch = () =>
      withTestDb((db) =>
        db.ideaBatch.findFirstOrThrow({ where: { workspaceId }, orderBy: { startedAt: "desc" } })
      );
    const apiState = async (): Promise<ApiState> => {
      const res = await page.request.get("/api/ideas");
      expect(res.status()).toBe(200);
      return res.json();
    };
    const aiCalls = (stages: Stage[]) =>
      stages.filter((s) => s.kind === "ai").reduce((n, s) => n + (s.calls ?? 0), 0);

    // ——— the one upload ———
    const note = await upload(KEY.ticketsSent);
    console.log(`[golden] ${note}`);
    const batch = await latestBatch();
    const trace = batch.trace as unknown as { stages: Stage[] } | null;
    const stages = trace?.stages ?? [];
    const stats = (batch.stats ?? {}) as Record<string, number>;
    console.log(
      `[golden] batch ${batch.id} ${batch.status} · ${stages.map((s) => `${s.stage}${s.calls ? `(${s.calls})` : ""}${s.error ? "!" : ""}`).join(" ")}`
    );

    await test.step("cost guard: total AI calls within budget", async () => {
      expect(stages.length, "trace has stages").toBeGreaterThan(0);
      expect.soft(aiCalls(stages), `AI calls ≤ ${KEY.maxAiCalls}`).toBeLessThanOrEqual(KEY.maxAiCalls);
    });

    const state = await apiState();
    const tickets = await withTestDb((db) =>
      db.zendeskTicketRaw.findMany({ where: { workspaceId }, include: { sources: true } })
    );
    const byExt = new Map(tickets.map((t) => [t.externalId, t]));
    const ideasBySource = new Map<string, ApiIdea[]>();
    for (const idea of state.ideas) for (const z of idea.zen) {
      ideasBySource.set(z, [...(ideasBySource.get(z) ?? []), idea]);
    }

    await test.step("IMP-01 upload completes: batch completed, counts, duration, ideas listed", async () => {
      expect(batch.status).toBe("completed");
      expect(batch.error).toBeNull();
      expect(stats.imported).toBe(KEY.ticketsSent);
      expect(note).toContain(`${KEY.skippedRows} empty row skipped`);
      expect(batch.completedAt).not.toBeNull();
      const durationMs = batch.completedAt!.getTime() - batch.startedAt.getTime();
      console.log(`[golden] duration ${(durationMs / 1000).toFixed(1)}s`);
      expect.soft(durationMs, "duration ≤ 180 s").toBeLessThanOrEqual(KEY.maxDurationMs);
      expect(tickets.length).toBe(KEY.ticketsSent);
      expect(state.ideas.length).toBeGreaterThan(0);
      await expect(page.getByText("No ideas yet")).toHaveCount(0);
      await expect(page.getByText(state.ideas[0].title, { exact: true }).first()).toBeVisible();
    });

    await test.step("IMP-02 classify kind matches the key on ≥ 8 of 10; only fr tickets became ideas", async () => {
      const verdicts = Object.entries(KEY.kinds).map(([ext, accepted]) => {
        const kind = byExt.get(ext)?.catalogKind ?? "<none>";
        return { ext, kind, ok: accepted.includes(kind) };
      });
      console.log(`[golden] classify: ${verdicts.map((v) => `${v.ext.slice(-3)}=${v.kind}${v.ok ? "" : "✗"}`).join(" ")}`);
      expect.soft(verdicts.filter((v) => v.ok).length, "classify accuracy").toBeGreaterThanOrEqual(KEY.classifyMinCorrect);
      for (const t of tickets) {
        if (t.catalogKind !== "fr") {
          expect(t.sources, `${t.externalId} (${t.catalogKind}) has no idea`).toHaveLength(0);
        } else {
          expect(t.sources.length, `${t.externalId} (fr) backs an idea`).toBeGreaterThan(0);
        }
      }
    });

    await test.step("IMP-03 parked kinds match the key and none has an idea", async () => {
      expect(stats.bugs).toBe(KEY.parked.bugs);
      expect(stats.needsDetails).toBe(KEY.parked.needsDetails);
      expect(tickets.filter((t) => t.catalogKind === "bug")).toHaveLength(KEY.parked.bugs);
      expect(tickets.filter((t) => t.catalogKind === "needs_details")).toHaveLength(KEY.parked.needsDetails);
      for (const t of tickets.filter((t) => t.catalogKind !== "fr")) {
        expect(ideasBySource.get(t.externalId) ?? []).toHaveLength(0);
        expect(t.matchNotes).toEqual([]);
      }
    });

    await test.step("IMP-04 the two-ask ticket splits and every child inherits the parent's attributes", async () => {
      const t = byExt.get(KEY.multiProblemTicket)!;
      expect(t.catalogKind).toBe("fr");
      const notes = t.matchNotes as { unit: string; ideaId: string }[];
      expect(notes.length, "split units").toBeGreaterThanOrEqual(2);
      for (const n of notes) expect(n.unit).toMatch(new RegExp(`^${KEY.multiProblemTicket}#\\d+$`));
      expect(stats.split).toBeGreaterThanOrEqual(1);
      const children = ideasBySource.get(KEY.multiProblemTicket) ?? [];
      expect(children.length).toBeGreaterThanOrEqual(2);
      for (const c of children) {
        expect(c.customers.map(lower)).toContain(lower(KEY.ticket031.customer_name));
        expect(c.reporters).toContain(KEY.ticket031.requester);
      }
      expect(t.customerName).toBe(KEY.ticket031.customer_name);
      expect(t.module).toBe(KEY.ticket031.module);
      expect(t.whyBuild).toBeTruthy();
      expect(t.insights).toBeTruthy();
      expect(t.dealRelated).toBe("Yes");
      expect(t.customerType).toBe("Customer");
      expect(t.url).toMatch(/^https:\/\//);
      expect(t.affectsAllCustomers).toBe(false);
    });

    await test.step("IMP-05 021 + 022 merge into one idea with 2 votes; zero false merges; count in range; no empty titles", async () => {
      const [a, b] = KEY.mustMerge;
      const ideasA = ideasBySource.get(a) ?? [];
      const ideasB = ideasBySource.get(b) ?? [];
      const shared = ideasA.filter((i) => ideasB.some((j) => j.id === i.id));
      expect(shared, `${a} and ${b} share an idea`).toHaveLength(1);
      expect(shared[0].newVotes).toBe(2);
      // Zero false merges: an idea's tickets are either exactly the pair or one ticket.
      for (const idea of state.ideas) {
        const distinctTickets = Array.from(new Set(idea.zen));
        const isPair = distinctTickets.length === 2 && distinctTickets.every((z) => KEY.mustMerge.includes(z));
        expect(isPair || distinctTickets.length <= 1, `false merge in "${idea.title}": ${distinctTickets.join(", ")}`).toBe(true);
        expect(idea.title.trim(), "idea title").not.toBe("");
      }
      const [min, max] = KEY.ideaCountRange;
      expect(state.ideas.length).toBeGreaterThanOrEqual(min);
      expect(state.ideas.length).toBeLessThanOrEqual(max);
    });

    await test.step("IMP-08 raw row stored exactly, including the quoted multi-line body", async () => {
      const raw = byExt.get(KEY.mustMerge[0])!.raw as Record<string, string>;
      expect(raw.subject).toBe(KEY.raw021.subject);
      expect(raw.description).toBe(KEY.raw021.description);
      expect(raw.description).toContain("\n\n");
    });

    await test.step("IMP-10 trace complete and clean, ledger == AI calls, cache ≥ 70 % on classify + match, heartbeat advanced", async () => {
      const names = stages.map((s) => s.stage);
      for (const s of ["dedupe", "jira-fetch", "prepare", "parse", "classify", "split", "match", "customers", "jira-sync", "write"]) {
        expect(names, `stage ${s} present`).toContain(s);
      }
      for (const s of stages) expect(s.error, `stage ${s.stage} error`).toBeUndefined();
      const ledgerRows = await withTestDb((db) =>
        db.ledgerEntry.count({
          where: { workspaceId, createdAt: { gte: batch.startedAt, lte: batch.completedAt! } },
        })
      );
      console.log(`[golden] ledger rows ${ledgerRows} · ai calls ${aiCalls(stages)}`);
      expect.soft(ledgerRows, "ledger rows == AI calls").toBe(aiCalls(stages));
      for (const name of ["classify", "match"]) {
        const s = stages.find((x) => x.stage === name)!;
        expect(s.tokens, `${name} tokens recorded`).toBeTruthy();
        const share = s.tokens!.cacheRead / Math.max(1, s.tokens!.input);
        console.log(`[golden] ${name} cached share ${(share * 100).toFixed(0)}%`);
        // Soft (2026-09-14 run: classify 60% on a cold org): a miss is recorded
        // and the cases after IMP-10 still get their own outcome. Threshold unchanged.
        expect.soft(share, `${name} cached share ≥ ${KEY.minCachedShare * 100}%`).toBeGreaterThanOrEqual(KEY.minCachedShare);
      }
      expect(batch.heartbeatAt.getTime()).toBeGreaterThan(batch.startedAt.getTime());
    });

    await test.step("IMP-11 truth customers → catalog; text-only names → suggested; all-customers cell → flag", async () => {
      const catalog = state.customerCatalog.map(lower);
      for (const name of KEY.truthCustomers) expect(catalog, `${name} in catalog`).toContain(lower(name));
      for (const [ext, name] of Object.entries(KEY.textCustomers)) {
        const ideas = ideasBySource.get(ext) ?? [];
        expect(ideas.length, `${ext} has an idea`).toBeGreaterThan(0);
        const named = ideas.flatMap((i) => i.customers).map(lower);
        expect(named, `${name} extracted from ${ext}`).toContain(lower(name));
        expect(catalog, `${name} stays a suggestion (not cataloged)`).not.toContain(lower(name));
      }
      expect(byExt.get(KEY.allCustomersTicket)!.affectsAllCustomers).toBe(true);
    });

    await test.step("IMP-13 PMOS AI reading: every FR unit has a note (idea, merged flag, reason)", async () => {
      const ideaIds = new Set(state.ideas.map((i) => i.id));
      for (const t of tickets.filter((t) => t.catalogKind === "fr")) {
        const notes = t.matchNotes as { unit: string; ideaId: string; merged: boolean; reason: string }[];
        expect(notes.length, `${t.externalId} notes`).toBeGreaterThan(0);
        for (const n of notes) {
          expect(ideaIds.has(n.ideaId), `${t.externalId} note points at a live idea`).toBe(true);
          expect(typeof n.merged).toBe("boolean");
          expect(typeof n.reason).toBe("string");
        }
      }
    });

    await test.step("REV-01 status card: 'N of M awaiting review' moves after one approval", async () => {
      const pending = state.ideas.filter((i) => i.decision === "pending" && !["unchanged", "deleted"].includes(i.batch));
      await page.reload();
      const card = page.getByText(/\d+ of \d+ awaiting review/);
      await expect(card).toBeVisible();
      const [, n0] = (await card.innerText()).match(/(\d+) of (\d+) awaiting review/)!;
      expect(Number(n0)).toBe(pending.length);
      // Approve an idea with no unresolved customer suggestion (the server refuses otherwise).
      const catalog = new Set(state.customerCatalog.map(lower));
      const target = pending.find((i) => i.customers.every((c) => catalog.has(lower(c))));
      expect(target, "an idea with no unresolved suggestion exists").toBeTruthy();
      const res = await page.request.post("/api/ideas/mutate", {
        data: { type: "decision", ideaId: target!.id, decision: "reviewed" },
      });
      expect(res.status(), await res.text()).toBe(200);
      await page.reload();
      await expect(page.getByText(new RegExp(`^${pending.length - 1} of \\d+ awaiting review$`))).toBeVisible();
    });

    // ——— second upload: dedupe runs before AI ———
    await test.step("IMP-06 re-upload is all duplicates: 0 imported, no AI stage, no new ideas/ledger rows", async () => {
      const ledgerBefore = await withTestDb((db) => db.ledgerEntry.count({ where: { workspaceId } }));
      const note2 = await upload(0);
      console.log(`[golden] ${note2}`);
      expect(note2).toContain(`${KEY.ticketsSent} already imported`);
      const batch2 = await latestBatch();
      expect(batch2.id).not.toBe(batch.id);
      expect(batch2.status).toBe("completed");
      const stats2 = (batch2.stats ?? {}) as Record<string, number>;
      expect(stats2.duplicates).toBe(KEY.ticketsSent);
      expect(stats2.imported).toBe(0);
      const stages2 = ((batch2.trace as unknown as { stages: Stage[] } | null)?.stages ?? []);
      expect(aiCalls(stages2), "no AI calls on a duplicate upload").toBe(0);
      const after = await apiState();
      expect(after.ideas.length).toBe(state.ideas.length);
      expect(after.tickets.length).toBe(KEY.ticketsSent);
      expect(await withTestDb((db) => db.ledgerEntry.count({ where: { workspaceId } }))).toBe(ledgerBefore);
    });
  });
});
