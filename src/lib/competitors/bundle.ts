/**
 * Collector bundles — pages a collector gathered for a competitor (a manual
 * scan, a browser-side collector, a later connector), handed to the pipeline
 * as if the scanner had fetched them. A bundle is a folder with a manifest:
 *
 *   {
 *     "competitor": "recordedfuture.com",          // the competitor's host (as added in Settings)
 *     "workspace": "<workspaceId>",                 // optional; required when the host is in several workspaces
 *     "sources": [{
 *       "type": "documents",                        // one of SOURCE_TYPES
 *       "url": "https://assets.example.com",        // optional: the source's own address
 *       "pages": [{ "url": "https://…/x.pdf", "title": "…", "file": "texts/x.txt" | "text": "…",
 *                   "kind": "document", "observedAt": "2026-03-10" }]
 *     }]
 *   }
 *
 * `file` paths are relative to the manifest. The CLI `--import` reads one
 * manifest; a Scan run in bundle mode reads COMPETITORS_BUNDLE_DIR/<host>/
 * manifest.json for each competitor. pm-os never keeps a bundle: it stores
 * the pages and runs the same pipeline as a website crawl.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSourceType, type SourceType } from "./config";
import type { CollectedPage } from "./import";

interface ManifestPage extends Omit<CollectedPage, "text"> {
  text?: string;
  file?: string;
}

interface Manifest {
  competitor?: string;
  workspace?: string;
  sources?: { type?: string; url?: string; pages?: ManifestPage[] }[];
}

export interface BundleSource {
  type: SourceType;
  url: string | null;
  pages: CollectedPage[];
}

export interface Bundle {
  host: string;
  workspace: string | null;
  sources: BundleSource[];
  /** Source types in the manifest that are not SOURCE_TYPES (left out). */
  skipped: string[];
}

/** Read one manifest and the page texts it points to. Throws when the manifest is not a bundle. */
export function readBundleManifest(manifestPath: string): Bundle {
  const path = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const base = dirname(path);
  const host = (manifest.competitor ?? "").trim().toLowerCase();
  if (!host || !Array.isArray(manifest.sources)) throw new Error("manifest needs `competitor` (host) and `sources`");
  const sources: BundleSource[] = [];
  const skipped: string[] = [];
  for (const src of manifest.sources) {
    if (!isSourceType(src.type)) {
      skipped.push(String(src.type));
      continue;
    }
    sources.push({
      type: src.type,
      url: src.url?.trim() || null,
      pages: (src.pages ?? []).map((p) => ({
        url: p.url,
        title: p.title,
        kind: p.kind,
        observedAt: p.observedAt ?? null,
        text: p.file ? readFileSync(resolve(base, p.file), "utf8") : p.text ?? "",
      })),
    });
  }
  return { host, workspace: manifest.workspace?.trim() || null, sources, skipped };
}

/** The folder a Scan run in bundle mode reads from (COMPETITORS_BUNDLE_DIR), or null when unset. */
export function bundleDir(): string | null {
  const v = process.env.COMPETITORS_BUNDLE_DIR?.trim();
  return v ? resolve(v) : null;
}

/** The bundle prepared for a competitor's host under the bundle folder, or null when there is none. */
export function bundleForHost(host: string): Bundle | null {
  const dir = bundleDir();
  if (!dir) return null;
  const manifest = join(dir, host.trim().toLowerCase(), "manifest.json");
  if (!existsSync(manifest)) return null;
  return readBundleManifest(manifest);
}

/** True when a bundle folder holds a manifest for this host (no read — used to plan a run). */
export function hasBundleForHost(host: string): boolean {
  const dir = bundleDir();
  return Boolean(dir && existsSync(join(dir, host.trim().toLowerCase(), "manifest.json")));
}
