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
 * manifest from disk; Admin → Competitors → Import pages reads the same
 * folder as one zip (bundle-zip.ts). Both go through parseBundleManifest.
 * pm-os never keeps a bundle: it stores the pages and runs the same pipeline
 * as a website crawl.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  /** `file` paths the manifest names that the bundle does not hold. Their pages have no text, so the import drops them. */
  missing: string[];
}

/** The text of a `file` the manifest names (the path as written there), or null when the bundle does not hold it. */
export type ReadBundleText = (file: string) => string | null;

/**
 * A manifest (its JSON text) and the page texts it points to, read through
 * `readText`. Pure: the disk and the zip differ only in `readText`. Throws
 * when the text is not JSON or not a bundle manifest, and whatever `readText`
 * throws.
 */
export function parseBundleManifest(manifestJson: string, readText: ReadBundleText): Bundle {
  const manifest = JSON.parse(manifestJson) as Manifest | null;
  const host = typeof manifest?.competitor === "string" ? manifest.competitor.trim().toLowerCase() : "";
  if (!manifest || !host || !Array.isArray(manifest.sources)) throw new Error("manifest needs `competitor` (host) and `sources`");
  const sources: BundleSource[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const src of manifest.sources) {
    if (!isSourceType(src?.type)) {
      skipped.push(String(src?.type));
      continue;
    }
    const pages: CollectedPage[] = [];
    for (const p of Array.isArray(src.pages) ? src.pages : []) {
      if (!p || typeof p !== "object") throw new Error(`a page of the source "${src.type}" is not an object`);
      let text = p.text ?? "";
      if (p.file) {
        const read = readText(p.file);
        if (read === null) missing.push(p.file);
        text = read ?? "";
      }
      pages.push({ url: p.url, title: p.title, kind: p.kind, observedAt: p.observedAt ?? null, text });
    }
    sources.push({ type: src.type, url: src.url?.trim() || null, pages });
  }
  return { host, workspace: typeof manifest.workspace === "string" ? manifest.workspace.trim() || null : null, sources, skipped, missing };
}

/** Read one manifest from disk and the page texts it points to. Throws when the manifest is not a bundle or a text file is not there. */
export function readBundleManifest(manifestPath: string): Bundle {
  const path = resolve(manifestPath);
  const base = dirname(path);
  return parseBundleManifest(readFileSync(path, "utf8"), (file) => readFileSync(resolve(base, file), "utf8"));
}

/**
 * A manifest `file` path as a path inside the bundle root ("texts/x.txt"), or
 * null when it is absolute or leaves the root. For a bundle that is not a
 * folder on our own disk (an uploaded zip).
 */
export function bundleEntryPath(file: string): string | null {
  const path = file.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}
