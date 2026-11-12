/**
 * A collector bundle uploaded as one zip (Admin → Competitors → Import
 * pages): the folder bundle.ts describes — manifest.json plus the text files
 * it names — zipped as it is. Read in memory only; nothing is written to
 * disk. Only the manifest and the files it names are unpacked.
 *
 * The manifest is at the zip root, or inside one top-level folder (zipping a
 * folder on a Mac wraps it in that folder). `__MACOSX/` and `.DS_Store` are
 * ignored.
 */
import { unzipSync } from "fflate";
import { bundleEntryPath, parseBundleManifest, type Bundle } from "./bundle";

/**
 * The largest zip accepted. Production serves the app from Cloud Run, which
 * refuses a request over 32 MB before it reaches the app; this leaves room
 * for the form around the file. next.config.ts (proxyClientMaxBodySize) lets
 * a body of this size through the proxy whole.
 */
export const MAX_ZIP_BYTES = 30 * 1024 * 1024;
/** The largest total size of a zip's files once unpacked, as the zip states it. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** The most entries (files and folders) a zip may hold. */
export const MAX_ZIP_ENTRIES = 5_000;

export interface ZipLimits {
  maxZipBytes: number;
  maxUnpackedBytes: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxZipBytes: MAX_ZIP_BYTES, maxUnpackedBytes: MAX_UNPACKED_BYTES, maxEntries: MAX_ZIP_ENTRIES };

const MANIFEST_NAME = "manifest.json";

export type BundleZipProblem = "too_large" | "not_zip" | "no_manifest" | "bad_manifest" | "bad_path";

/** Why an uploaded zip was refused. `message` is shown to the admin as it is. */
export class BundleZipError extends Error {
  constructor(
    readonly problem: BundleZipProblem,
    message: string,
  ) {
    super(message);
    this.name = "BundleZipError";
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function ignored(name: string): boolean {
  return name.endsWith("/") || name.startsWith("__MACOSX/") || name === ".DS_Store" || name.endsWith("/.DS_Store");
}

/** The entries of a zip whose names `wanted` accepts, unpacked. Throws what fflate throws on a file that is not a zip. */
function unpack(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, Uint8Array> {
  return new Map(Object.entries(unzipSync(bytes, { filter: (entry) => wanted(entry.name) })));
}

/**
 * Read a bundle from the bytes of a zip. Throws BundleZipError when the file
 * is too large, is not a zip, holds no manifest, the manifest is not a bundle
 * manifest, or a `file` path is absolute or leaves the bundle. A `file` the
 * zip does not hold is not an error: it is listed in `missing` and its page
 * has no text.
 */
export function readBundleZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_LIMITS): Bundle {
  if (bytes.length > limits.maxZipBytes) throw new BundleZipError("too_large", `The zip is larger than ${megabytes(limits.maxZipBytes)}.`);
  // Every zip starts with a file entry ("PK\x03\x04"), or with the end record when it is empty ("PK\x05\x06").
  const zipStart = bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
  if (!zipStart) throw new BundleZipError("not_zip", "This file is not a zip.");

  // First the list of entries only (nothing is unpacked): the limits are checked on what the zip says it holds.
  // Unpacking never writes past the size an entry states, so the stated sizes are a real ceiling.
  const names: string[] = [];
  let unpacked = 0;
  try {
    unzipSync(bytes, {
      filter: (entry) => {
        names.push(entry.name);
        unpacked += entry.originalSize;
        if (names.length > limits.maxEntries) throw new BundleZipError("too_large", `The zip holds more than ${limits.maxEntries.toLocaleString("en-US")} files.`);
        if (unpacked > limits.maxUnpackedBytes) throw new BundleZipError("too_large", `The zip unpacks to more than ${megabytes(limits.maxUnpackedBytes)}.`);
        return false;
      },
    });
  } catch (e) {
    if (e instanceof BundleZipError) throw e;
    throw new BundleZipError("not_zip", "This file could not be read as a zip.");
  }

  const usable = new Set(names.filter((n) => !ignored(n)));
  let root = "";
  if (!usable.has(MANIFEST_NAME)) {
    const nested = [...usable].filter((n) => n.split("/").length === 2 && n.endsWith(`/${MANIFEST_NAME}`));
    if (nested.length === 0) throw new BundleZipError("no_manifest", `The zip has no ${MANIFEST_NAME} (at its top, or inside one folder).`);
    if (nested.length > 1) throw new BundleZipError("no_manifest", `The zip has more than one folder with a ${MANIFEST_NAME}. Zip one bundle folder.`);
    root = nested[0].slice(0, -MANIFEST_NAME.length);
  }

  const manifestBytes = unpack(bytes, (n) => n === root + MANIFEST_NAME).get(root + MANIFEST_NAME);
  if (!manifestBytes) throw new BundleZipError("no_manifest", `The zip has no ${MANIFEST_NAME} (at its top, or inside one folder).`);
  const decoder = new TextDecoder("utf-8");
  const manifestJson = decoder.decode(manifestBytes);
  /** The manifest's pages, each `file` read through `read` (which gets the file's entry name in the zip). */
  const parse = (read: (entry: string) => string | null): Bundle => {
    try {
      return parseBundleManifest(manifestJson, (file) => {
        const path = bundleEntryPath(file);
        if (path === null) throw new BundleZipError("bad_path", `The manifest names a file outside the bundle: ${file}`);
        return read(root + path);
      });
    } catch (e) {
      if (e instanceof BundleZipError) throw e;
      throw new BundleZipError("bad_manifest", `${MANIFEST_NAME} is not a bundle manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // The manifest is parsed twice: once to learn which files it names, then, with exactly those unpacked, for the pages.
  const named = new Set<string>();
  parse((entry) => {
    if (usable.has(entry)) named.add(entry);
    return "";
  });
  const texts = unpack(bytes, (n) => named.has(n));
  return parse((entry) => {
    const text = texts.get(entry);
    return text ? decoder.decode(text) : null;
  });
}
