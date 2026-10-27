import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

/**
 * The competitors media store: UI captures, images and clips referenced by
 * `CompetitorMedia.mediaPath` and `CapabilityInsight.media[].mediaPath`.
 * Today a directory (`COMPETITORS_MEDIA_DIR`), served by
 * /api/competitors/media; a bucket later with the same paths. Unset → every
 * media path is "not available" and the UI shows its placeholder.
 */

export function mediaDir(): string | null {
  const d = process.env.COMPETITORS_MEDIA_DIR?.trim();
  return d && existsSync(d) ? d : null;
}

/** Resolve a media path safely inside the store (no traversal). */
export function mediaFilePath(rel: string): string | null {
  const dir = mediaDir();
  if (!dir) return null;
  const clean = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  if (clean.includes("..") || clean.startsWith("/")) return null;
  const full = join(dir, clean);
  if (!full.startsWith(dir) || !existsSync(full)) return null;
  return full;
}

/** URL the client uses for a media path. */
export function mediaUrl(rel: string): string {
  return `/api/competitors/media?p=${encodeURIComponent(rel)}`;
}
