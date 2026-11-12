import { createHash, createHmac, randomBytes } from "node:crypto";
import { db } from "../db";
import { sendEmail } from "../mailer";
import { ACTIVE_SCAN_STATUSES, KEY_ROTATE_DAYS, KEY_ROTATION_GRACE_MS, LOCAL_ALERT_MS, SCAN_TOKEN_GRACE_MS, STALE_MS, STATION_OFF_ALERT_EVERY_MS, STATION_ONLINE_MS } from "./config";
import { lastStationOffAlert, noteStationOffAlert, now } from "./settings";

/**
 * The LOCAL lane (Website Scanning PRD 2026-11-04): a scan the remote lane
 * could not or may not run waits for a PM's machine. That machine is a
 * server, not a user — it holds a machine key with no expiry, created once in
 * Administration, rotated by the poller itself every 30 days, revoked in
 * Administration when a Mac is lost or retired. For now Daniel's Mac, as
 * PM-OS operator, serves every workspace.
 *
 *   machine key  → may only ask "what is waiting" (and rotate itself)
 *   scan token   → issued per waiting scan, may only post pages into that
 *                  scan and mark it done; valid while the scan is pending or
 *                  running and for 15 minutes after it ended
 *
 * Customers never see any of this: their row says "Scan pending".
 */

export const SUPPORT_EMAIL = "support@pm-os.io";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

// ————— Machine keys —————

export interface ScannerKeyRow {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
}

export async function listScannerKeys(): Promise<ScannerKeyRow[]> {
  const rows = await db.scannerKey.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, rotatedAt: k.rotatedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null }));
}

/** Create a machine key. The secret is returned ONCE; only its hash is stored. */
export async function createScannerKey(label: string, createdById: string | null): Promise<{ id: string; secret: string }> {
  const secret = newSecret("pmosk");
  const row = await db.scannerKey.create({ data: { label: label.trim().slice(0, 80) || "Local station", keyHash: sha(secret), createdById }, select: { id: true } });
  return { id: row.id, secret };
}

export async function revokeScannerKey(id: string): Promise<boolean> {
  const r = await db.scannerKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count > 0;
}

export interface VerifiedKey {
  id: string;
  label: string;
  /** True when the key is older than KEY_ROTATE_DAYS: the poller should rotate on this check-in. */
  rotateDue: boolean;
}

/** A machine key from a bearer header, or null. A previous key still works for the rotation grace window. */
export async function verifyScannerKey(bearer: string | null | undefined): Promise<VerifiedKey | null> {
  const secret = bearer?.replace(/^Bearer\s+/i, "").trim();
  if (!secret || !secret.startsWith("pmosk_")) return null;
  const h = sha(secret);
  const t = await now();
  const key = await db.scannerKey.findFirst({ where: { revokedAt: null, OR: [{ keyHash: h }, { previousKeyHash: h, OR: [{ previousValidUntil: null }, { previousValidUntil: { gt: t } }] }] } });
  if (!key) return null;
  // The previous key stays valid until the NEW key is first used; only then does its grace window start (Tomer's
  // review: a rotation answer the poller never received must not lock the station out).
  const firstUseOfNewKey = key.keyHash === h && key.previousKeyHash && key.previousValidUntil === null;
  await db.scannerKey.update({ where: { id: key.id }, data: { lastUsedAt: t, ...(firstUseOfNewKey ? { previousValidUntil: new Date(t.getTime() + KEY_ROTATION_GRACE_MS) } : {}) } });
  const since = key.rotatedAt ?? key.createdAt;
  return { id: key.id, label: key.label, rotateDue: t.getTime() - since.getTime() > KEY_ROTATE_DAYS * 86_400_000 };
}

/** Rotate: a fresh secret replaces the key; the old one keeps working until the new one is first used, then for a grace window. */
export async function rotateScannerKey(id: string): Promise<{ secret: string }> {
  const t = await now();
  const key = await db.scannerKey.findUniqueOrThrow({ where: { id }, select: { keyHash: true } });
  const secret = newSecret("pmosk");
  await db.scannerKey.update({ where: { id }, data: { keyHash: sha(secret), previousKeyHash: key.keyHash, previousValidUntil: null, rotatedAt: t } });
  return { secret };
}

/** Any station enrolled? Without one, no scan should be parked in the local lane (Kela on day one). */
export async function hasActiveScannerKey(): Promise<boolean> {
  return (await db.scannerKey.count({ where: { revokedAt: null } })) > 0;
}

// ————— Scan tokens —————

function serverSecret(): string {
  const s = process.env.SESSION_SECRET?.trim();
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

/**
 * One token per scan, the same at every check-in: derived from the request (HMAC with the server secret), so
 * nothing secret is stored and a scan listed 96 times a day leaves one live token, not 96 (Tomer's review). It is
 * valid while the scan is pending or running and for 15 minutes after it ended (PRD), whichever check-in issued it.
 */
export async function issueScanToken(scanId: string): Promise<string> {
  const req = await db.localScanRequest.findUnique({ where: { scanId }, select: { id: true, createdAt: true } });
  const seed = req ? `${req.id}:${req.createdAt.getTime()}` : scanId;
  const secret = `pmost_${createHmac("sha256", serverSecret()).update(seed).digest("base64url")}`;
  const tokenHash = sha(secret);
  await db.scanToken.upsert({ where: { tokenHash }, create: { scanId, tokenHash }, update: {} });
  return secret;
}

/** Tokens of scans that ended more than the grace window ago are deleted (hourly tick). */
export async function cleanupScanTokens(t: Date): Promise<number> {
  const cutoff = new Date(t.getTime() - SCAN_TOKEN_GRACE_MS);
  const r = await db.scanToken.deleteMany({ where: { scan: { status: { notIn: [...ACTIVE_SCAN_STATUSES] }, finishedAt: { lt: cutoff } } } });
  return r.count;
}

/** The scan a token may post into, or null: unknown token, or its scan ended more than the grace window ago. */
export async function verifyScanToken(bearer: string | null | undefined, scanId: string): Promise<{ scanId: string; status: string } | null> {
  const secret = bearer?.replace(/^Bearer\s+/i, "").trim();
  if (!secret || !secret.startsWith("pmost_")) return null;
  const tok = await db.scanToken.findUnique({ where: { tokenHash: sha(secret) }, select: { scanId: true, scan: { select: { status: true, finishedAt: true } } } });
  if (!tok || tok.scanId !== scanId) return null;
  const t = await now();
  const active = (ACTIVE_SCAN_STATUSES as readonly string[]).includes(tok.scan.status);
  if (!active && (!tok.scan.finishedAt || t.getTime() - tok.scan.finishedAt.getTime() > SCAN_TOKEN_GRACE_MS)) return null;
  return { scanId: tok.scanId, status: tok.scan.status };
}

// ————— Requests —————

/** Park a scan in the local lane. The scan row becomes "pending_local"; the source shows "pending". */
export async function createLocalRequest(scanId: string): Promise<void> {
  const scan = await db.competitorScan.findUniqueOrThrow({ where: { id: scanId }, select: { workspaceId: true, sourceId: true } });
  await db.$transaction([
    db.competitorScan.update({ where: { id: scanId }, data: { status: "pending_local", lane: "local" } }),
    db.localScanRequest.upsert({ where: { scanId }, create: { workspaceId: scan.workspaceId, scanId, sourceId: scan.sourceId, state: "waiting" }, update: { state: "waiting", startedAt: null, finishedAt: null, keyId: null } }),
    db.competitorSource.update({ where: { id: scan.sourceId }, data: { lastStatus: "pending" } }),
  ]);
  // The scan is parked whatever happens here: an email that cannot be sent never fails a scan.
  try {
    await alertStationOff(scanId);
  } catch (e) {
    console.error("[competitors] station-off alert failed", scanId, e);
  }
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Is a station on? Yes when a machine key checked in within STATION_ONLINE_MS
 * (the poller checks in every 15 minutes), or when a station is reading a scan
 * right now — it does not check in while it reads, its scan's heartbeat is the
 * sign of life.
 */
export async function stationStatus(t: Date): Promise<{ online: boolean; lastContact: Date | null }> {
  const key = await db.scannerKey.findFirst({ where: { revokedAt: null, lastUsedAt: { not: null } }, orderBy: { lastUsedAt: "desc" }, select: { lastUsedAt: true } });
  const lastContact = key?.lastUsedAt ?? null;
  if (lastContact && t.getTime() - lastContact.getTime() <= STATION_ONLINE_MS) return { online: true, lastContact };
  // Heartbeats are wall-clock times (not the test clock), so they are compared with the wall clock.
  const reading = await db.localScanRequest.findFirst({ where: { state: "running", scan: { status: "running", heartbeatAt: { gt: new Date(Date.now() - STALE_MS) } } }, select: { id: true } });
  return { online: !!reading, lastContact };
}

/**
 * A scan was just parked in the local lane (a new competitor, Rescan, the
 * schedule): when no station is on, support hears about it now instead of
 * after 24 hours (Daniel 2026-11-11). At most one email per
 * STATION_OFF_ALERT_EVERY_MS, so a schedule that parks twenty scans sends one.
 * The 24-hour email per request stays. Returns true when an email went out.
 */
export async function alertStationOff(scanId: string): Promise<boolean> {
  const t = await now();
  const station = await stationStatus(t);
  if (station.online) return false;
  const last = await lastStationOffAlert();
  // A last alert "in the future" (the test clock moved back) does not hold the next one.
  if (last && last.at.getTime() <= t.getTime() && t.getTime() - last.at.getTime() < STATION_OFF_ALERT_EVERY_MS) return false;
  const r = await db.localScanRequest.findUnique({
    where: { scanId },
    include: { source: { select: { url: true, competitor: { select: { name: true, workspace: { select: { organization: { select: { name: true } } } } } } } } },
  });
  if (!r) return false;
  const waiting = await db.localScanRequest.count({ where: { state: "waiting" } });
  const org = r.source.competitor.workspace.organization.name;
  await sendEmail({
    to: SUPPORT_EMAIL,
    subject: `[PM-OS] Local station is off — scan waiting: ${r.source.competitor.name} (${org})`,
    text: [
      `A competitor scan just started and no local station is on to read it.`,
      ``,
      `Organization: ${org}`,
      `Competitor:   ${r.source.competitor.name} — ${r.source.url}`,
      `Station last checked in: ${station.lastContact ? station.lastContact.toISOString() : "never"}`,
      `Scans waiting now: ${waiting}`,
      ``,
      `What to do: make sure the local station is awake (charger, lid open, no sleep when the display is off) and the poller is running (launchctl list | grep pm-os). The scan keeps waiting; nothing is lost.`,
      `This email is sent at most once an hour; a scan still waiting after 24 hours gets its own email.`,
      `Scan log: ${appUrl()}/admin/competitors`,
    ].join("\n"),
  });
  await noteStationOffAlert(t, scanId);
  return true;
}

export interface WaitingScan {
  scanId: string;
  token: string;
  /** The site to read, as the competitor was added. */
  siteUrl: string;
  host: string;
  competitorName: string;
  workspaceId: string;
  /** Pages the previous scans know — a hint for the runner; the server decides new/changed/removed on hand-in. */
  knownUrls: string[];
  /** The time limit the runner must respect (no page limit, Daniel 2026-11-09). */
  ceiling: { ms: number };
  waitingSince: string;
}

/**
 * What a station should scan now: every waiting request, oldest first, each
 * with a fresh scan token. Requests are not claimed here (the poller runs
 * them one at a time and may show a dialog first); `startLocalScan` claims.
 */
export async function listWaiting(ceilingValue: { ms: number }): Promise<WaitingScan[]> {
  const reqs = await db.localScanRequest.findMany({
    where: { state: "waiting", scan: { status: "pending_local" } },
    orderBy: { createdAt: "asc" },
    include: { scan: { select: { id: true, workspaceId: true } }, source: { select: { url: true, competitor: { select: { name: true, host: true, deletedAt: true } } } } },
  });
  const out: WaitingScan[] = [];
  for (const r of reqs) {
    if (r.source.competitor.deletedAt) continue;
    const known = await db.sourcePage.findMany({ where: { sourceId: r.sourceId, state: { in: ["present", "missing", "unlinked"] } }, select: { url: true }, take: 5000 });
    out.push({
      scanId: r.scan.id,
      token: await issueScanToken(r.scan.id),
      siteUrl: r.source.url,
      host: r.source.competitor.host,
      competitorName: r.source.competitor.name,
      workspaceId: r.scan.workspaceId,
      knownUrls: known.map((k) => k.url),
      ceiling: ceilingValue,
      waitingSince: r.createdAt.toISOString(),
    });
  }
  return out;
}

/** The station starts reading: the scan is "running" from now on (heartbeats come with every page). Only a WAITING request can be claimed: two overlapping check-ins never both run one scan. */
export async function startLocalScan(scanId: string, keyId: string | null): Promise<boolean> {
  const t = await now();
  const r = await db.localScanRequest.updateMany({ where: { scanId, state: "waiting" }, data: { state: "running", startedAt: t, keyId } });
  if (!r.count) return false;
  await db.competitorScan.update({ where: { id: scanId }, data: { status: "running", lane: "local", startedAt: t, heartbeatAt: new Date() } });
  await db.competitorSource.update({ where: { id: (await db.competitorScan.findUniqueOrThrow({ where: { id: scanId }, select: { sourceId: true } })).sourceId }, data: { lastStatus: "running" } });
  return true;
}

/** A stale local scan goes back to waiting so the next poll resumes it (its read pages stay). */
export async function requeueLocalScan(scanId: string): Promise<void> {
  await db.localScanRequest.updateMany({ where: { scanId }, data: { state: "waiting", startedAt: null } });
  await db.competitorScan.update({ where: { id: scanId }, data: { status: "pending_local" } });
}

/** Why a station stopped in the middle of a scan, as the station itself reports it at its next check-in. */
export const STATION_STOP_REASONS: Record<string, string> = {
  network: "the network was lost",
  shutdown: "the Mac shut down or the station was stopped",
  crash: "the station crashed or lost power",
  error: "the station hit an error",
};

/**
 * A station checks in holding the saved place of a scan it did not finish (Daniel 2026-11-12): the scan goes back to
 * waiting at once — no 10-minute stale wait — and its log says why it stopped, when, and how far it got. Only the
 * station that took the scan may ask, and only while the scan is still being read. Returns true when it was requeued.
 */
export async function resumeLocalScan(scanId: string, keyId: string, report: { reason: string; stoppedAt: string | null; pagesRead: number; pagesLeft: number }): Promise<boolean> {
  const req = await db.localScanRequest.findUnique({ where: { scanId }, select: { state: true, keyId: true, scan: { select: { status: true, lane: true, log: true } } } });
  if (!req || req.scan.lane !== "local") return false;
  if (req.keyId && req.keyId !== keyId) return false;
  const running = req.state === "running" && req.scan.status === "running";
  // Already back to waiting (the stale sweep got there first): only the reason is added to the log.
  const requeued = req.state === "waiting" && req.scan.status === "pending_local";
  if (!running && !requeued) return false;
  const why = STATION_STOP_REASONS[report.reason] ?? STATION_STOP_REASONS.crash;
  const at = report.stoppedAt && !Number.isNaN(Date.parse(report.stoppedAt)) ? new Date(report.stoppedAt).toISOString() : null;
  const line = {
    at: new Date().toISOString(),
    level: "warn" as const,
    msg: `The station stopped in the middle of the scan${at ? ` at ${at}` : ""}: ${why}. ${report.pagesRead} pages were already read, ${report.pagesLeft} left — it continues from the page it stopped on.`,
  };
  const earlier = Array.isArray(req.scan.log) ? (req.scan.log as unknown as { msg?: string }[]) : [];
  // One line per stop: a station that checks in twice before it can start (PM-OS busy) does not repeat it.
  if (!earlier.some((l) => l.msg === line.msg)) await db.competitorScan.update({ where: { id: scanId }, data: { log: [...earlier, line] as never } });
  if (running) await requeueLocalScan(scanId);
  console.warn(`[competitors] scan ${scanId}: ${line.msg}`);
  return running;
}

export async function finishLocalRequest(scanId: string): Promise<void> {
  await db.localScanRequest.updateMany({ where: { scanId }, data: { state: "done", finishedAt: await now() } });
}

/** Deleting a competitor cancels its waiting request (PRD). */
export async function cancelLocalRequests(sourceIds: string[]): Promise<number> {
  if (!sourceIds.length) return 0;
  const t = await now();
  const reqs = await db.localScanRequest.findMany({ where: { sourceId: { in: sourceIds }, state: { in: ["waiting", "running"] } }, select: { scanId: true } });
  if (!reqs.length) return 0;
  await db.$transaction([
    db.localScanRequest.updateMany({ where: { scanId: { in: reqs.map((r) => r.scanId) } }, data: { state: "cancelled", finishedAt: t } }),
    db.competitorScan.updateMany({ where: { id: { in: reqs.map((r) => r.scanId) } }, data: { status: "cancelled", finishedAt: t, badge: null, error: "the competitor was removed" } }),
  ]);
  return reqs.length;
}

/**
 * Requests older than 24 hours email support once and keep waiting (the Mac
 * is asleep, Chrome is closed, nobody is listening). Returns how many emails
 * went out.
 */
export async function alertOldRequests(appUrl: string): Promise<number> {
  const t = await now();
  const cutoff = new Date(t.getTime() - LOCAL_ALERT_MS);
  const old = await db.localScanRequest.findMany({
    where: { state: "waiting", alertedAt: null, createdAt: { lt: cutoff } },
    include: { source: { select: { url: true, competitor: { select: { name: true, workspace: { select: { organization: { select: { name: true } } } } } } } } },
  });
  let sent = 0;
  for (const r of old) {
    const hours = Math.round((t.getTime() - r.createdAt.getTime()) / 3600_000);
    const org = r.source.competitor.workspace.organization.name;
    try {
      await sendEmail({
        to: SUPPORT_EMAIL,
        subject: `[PM-OS] Competitor scan waiting ${hours} h: ${r.source.competitor.name} (${org})`,
        text: [
          `A competitor scan has been waiting for the local station for ${hours} hours.`,
          ``,
          `Organization: ${org}`,
          `Competitor:   ${r.source.competitor.name} — ${r.source.url}`,
          `Waiting since: ${r.createdAt.toISOString()}`,
          ``,
          `What to do: make sure the local station is awake (charger, lid open, no sleep when the display is off) and the poller is running (launchctl list | grep pm-os). The request keeps waiting; nothing is lost.`,
          `Scan log: ${appUrl}/admin/competitors`,
        ].join("\n"),
      });
      sent++;
    } catch (e) {
      console.error("[competitors] local-lane alert failed", r.scanId, e);
      continue;
    }
    await db.localScanRequest.update({ where: { id: r.id }, data: { alertedAt: t } });
  }
  return sent;
}
