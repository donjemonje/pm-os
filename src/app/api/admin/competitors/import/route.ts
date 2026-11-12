import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { BundleZipError, MAX_ZIP_BYTES, readBundleZip } from "@/lib/competitors/bundle-zip";
import type { Bundle } from "@/lib/competitors/bundle";
import { importPages } from "@/lib/competitors/import";
import { runScan } from "@/lib/competitors/scan";

/**
 * PM-OS Admin: import a collector bundle for one competitor of one
 * organization (Admin → Competitors → Import pages). The same flow as the
 * command line (`npm run competitors:scan -- --import <manifest>`), with the
 * folder uploaded as one zip and the competitor picked on the screen.
 *
 *   POST multipart form: organizationId, competitorId, file (the zip)
 *     → { competitorName, sources: [{ type, pages, dropped, scanId, status, error }], skipped, missing }
 *
 * The request runs the manifest's sources in order — store the pages, run the
 * scan, then the next source — and answers when the last scan has ended, so
 * the answer carries each scan's final status. It cannot hand the scans to
 * the runner and answer at once: an import is refused while a scan of the
 * organization is queued or running, so the second source can be stored only
 * after the first scan ended. A bundle scan fetches nothing and calls no
 * model (it stores each page and compares it with the stored one; the
 * analysis is its own queued run, started by the usual runner), so it takes
 * seconds, not minutes.
 *
 * The zip is read in memory and never written to disk.
 */

export interface AdminImportSource {
  type: string;
  /** Pages stored. */
  pages: number;
  /** Pages left out: no usable address, no text (a missing file), or the same address twice. */
  dropped: number;
  scanId: string | null;
  /** The scan's final status ("ok" | "partial" | "failed" | …), or why no scan was made: "no_pages" | "not_imported". */
  status: string;
  error: string | null;
}

export interface AdminImportResult {
  competitorName: string;
  sources: AdminImportSource[];
  /** Source types in the manifest that are not known source types. */
  skipped: string[];
  /** Files the manifest names that the zip does not hold. */
  missing: string[];
}

/** Room for the form around the file (boundaries, the two ids). */
const FORM_OVERHEAD_BYTES = 1024 * 1024;
const TOO_LARGE = `The zip is larger than ${Math.round(MAX_ZIP_BYTES / (1024 * 1024))} MB.`;
const RUNNING = "A scan is already running for this organization. Import again when it has finished.";

function refuse(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  // Refused before the body is read: a larger body does not reach the route whole.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_ZIP_BYTES + FORM_OVERHEAD_BYTES) return refuse(413, TOO_LARGE);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse(400, "The upload could not be read. Pick the zip and import again.");
  }
  const organizationId = form.get("organizationId");
  const competitorId = form.get("competitorId");
  const file = form.get("file");
  if (typeof organizationId !== "string" || !organizationId) return refuse(400, "Pick an organization.");
  if (typeof competitorId !== "string" || !competitorId) return refuse(400, "Pick a competitor.");
  if (!(file instanceof File)) return refuse(400, "Pick a zip file.");
  if (file.size > MAX_ZIP_BYTES) return refuse(413, TOO_LARGE);

  const workspace = await db.workspace.findUnique({ where: { organizationId }, select: { id: true } });
  if (!workspace) return refuse(404, "This organization was not found.");
  const competitor = await db.competitor.findFirst({ where: { id: competitorId, workspaceId: workspace.id, deletedAt: null }, select: { id: true, name: true, host: true } });
  if (!competitor) return refuse(404, "This competitor was not found in the organization.");

  let bundle: Bundle;
  try {
    bundle = readBundleZip(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    if (e instanceof BundleZipError) return refuse(e.problem === "too_large" ? 413 : 400, e.message);
    throw e;
  }
  // The picked competitor decides where the pages go; a bundle made for another site is never loaded into it.
  if (bundle.host !== competitor.host.toLowerCase()) {
    return refuse(422, `This bundle is for ${bundle.host}, and the competitor you picked is ${competitor.name} (${competitor.host}). Nothing was imported.`);
  }

  const sources: AdminImportSource[] = [];
  for (const [i, src] of bundle.sources.entries()) {
    const imported = await importPages({ workspaceId: workspace.id, competitorId: competitor.id, sourceType: src.type, sourceUrl: src.url, pages: src.pages, startedById: admin.id });
    if ("error" in imported) {
      if (imported.error === "no_competitor") return refuse(404, "This competitor was not found in the organization.");
      if (imported.error === "no_pages") {
        sources.push({ type: src.type, pages: 0, dropped: src.pages.length, scanId: null, status: "no_pages", error: null });
        continue;
      }
      // A scan of the organization is queued or running. Before the first source was stored: nothing happened, say so.
      if (!sources.some((s) => s.scanId)) return refuse(409, RUNNING);
      // After it (another scan started in between): what was stored stays; this source and the ones after it are not imported.
      for (const rest of bundle.sources.slice(i)) sources.push({ type: rest.type, pages: 0, dropped: 0, scanId: null, status: "not_imported", error: RUNNING });
      break;
    }
    await runScan(imported.scanId);
    const scan = await db.competitorScan.findUnique({ where: { id: imported.scanId }, select: { status: true, error: true } });
    sources.push({ type: src.type, pages: imported.pages, dropped: imported.dropped, scanId: imported.scanId, status: scan?.status ?? "failed", error: scan?.error ?? null });
  }

  if (!sources.some((s) => s.scanId)) {
    const dropped = sources.reduce((n, s) => n + s.dropped, 0);
    const why = [
      dropped ? `${dropped} page${dropped === 1 ? "" : "s"} had no usable web address or no text` : "",
      bundle.missing.length ? `${bundle.missing.length} file${bundle.missing.length === 1 ? "" : "s"} named in the manifest ${bundle.missing.length === 1 ? "is" : "are"} not in the zip` : "",
      bundle.skipped.length ? `source type${bundle.skipped.length === 1 ? "" : "s"} not known: ${bundle.skipped.join(", ")}` : "",
    ].filter(Boolean);
    return refuse(422, `The bundle has no usable pages. Nothing was imported${why.length ? ` (${why.join("; ")})` : ""}.`);
  }

  const result: AdminImportResult = { competitorName: competitor.name, sources, skipped: bundle.skipped, missing: bundle.missing };
  return NextResponse.json(result);
}
