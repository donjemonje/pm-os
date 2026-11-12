import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { bundleEntryPath, parseBundleManifest, readBundleManifest } from "@/lib/competitors/bundle";
import { BundleZipError, MAX_UNPACKED_BYTES, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, readBundleZip, type BundleZipProblem, type ZipLimits } from "@/lib/competitors/bundle-zip";

/**
 * Collector bundles: the manifest parser the command line and the admin
 * upload share (bundle.ts), and the zip the admin uploads (bundle-zip.ts).
 * Pure — the zips are built in memory.
 */

const HOST = "rival.example";

function manifest(sources: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ competitor: HOST, sources, ...extra });
}

/** A reader over a map of file → text; a file that is not in the map is not in the bundle. */
function reader(files: Record<string, string>) {
  return (file: string) => (file in files ? files[file] : null);
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

function problemOf(run: () => unknown): BundleZipProblem | "none" {
  try {
    run();
  } catch (e) {
    if (e instanceof BundleZipError) return e.problem;
    throw e;
  }
  return "none";
}

const LIMITS: ZipLimits = { maxZipBytes: MAX_ZIP_BYTES, maxUnpackedBytes: MAX_UNPACKED_BYTES, maxEntries: MAX_ZIP_ENTRIES };

describe("parseBundleManifest", () => {
  it("reads a page whose text is in the manifest", () => {
    const b = parseBundleManifest(
      manifest([{ type: "documents", url: " https://assets.rival.example ", pages: [{ url: "https://rival.example/a.pdf", title: "A", text: "inline text", kind: "document", observedAt: "2026-03-10" }] }], { competitor: "  Rival.Example ", workspace: " ws-1 " }),
      reader({}),
    );
    expect(b.host).toBe(HOST);
    expect(b.workspace).toBe("ws-1");
    expect(b.sources).toEqual([
      { type: "documents", url: "https://assets.rival.example", pages: [{ url: "https://rival.example/a.pdf", title: "A", text: "inline text", kind: "document", observedAt: "2026-03-10" }] },
    ]);
    expect(b.skipped).toEqual([]);
    expect(b.missing).toEqual([]);
  });

  it("reads a page whose text is in a file, through the reader, with the path as the manifest writes it", () => {
    const asked: string[] = [];
    const b = parseBundleManifest(manifest([{ type: "helpcenter", pages: [{ url: "https://rival.example/help/1", file: "texts/1.txt", text: "ignored when a file is named" }] }]), (file) => {
      asked.push(file);
      return "text from the file";
    });
    expect(asked).toEqual(["texts/1.txt"]);
    expect(b.sources[0].pages[0].text).toBe("text from the file");
    expect(b.sources[0].url).toBeNull();
    expect(b.sources[0].pages[0].observedAt).toBeNull();
  });

  it("leaves out a source whose type is not a known source type and names it", () => {
    const b = parseBundleManifest(
      manifest([
        { type: "carrier-pigeon", pages: [{ url: "https://rival.example/x", text: "x" }] },
        { pages: [] },
        { type: "website", pages: [{ url: "https://rival.example/", text: "home" }] },
      ]),
      reader({}),
    );
    expect(b.sources.map((s) => s.type)).toEqual(["website"]);
    expect(b.skipped).toEqual(["carrier-pigeon", "undefined"]);
  });

  it("keeps a page whose file the bundle does not hold, without text, and names the file", () => {
    const b = parseBundleManifest(
      manifest([
        {
          type: "website",
          pages: [
            { url: "https://rival.example/a", file: "texts/a.txt" },
            { url: "https://rival.example/b", file: "texts/b.txt" },
          ],
        },
      ]),
      reader({ "texts/a.txt": "page a" }),
    );
    expect(b.sources[0].pages.map((p) => p.text)).toEqual(["page a", ""]);
    expect(b.missing).toEqual(["texts/b.txt"]);
  });

  it("passes on what the reader throws (a path it refuses)", () => {
    const refuseOutside = (file: string) => {
      if (bundleEntryPath(file) === null) throw new Error(`outside the bundle: ${file}`);
      return "text";
    };
    expect(() => parseBundleManifest(manifest([{ type: "website", pages: [{ url: "https://rival.example/a", file: "../secrets.txt" }] }]), refuseOutside)).toThrow("outside the bundle: ../secrets.txt");
    expect(() => parseBundleManifest(manifest([{ type: "website", pages: [{ url: "https://rival.example/a", file: "texts/a.txt" }] }]), refuseOutside)).not.toThrow();
  });

  it("refuses a manifest without a competitor host or without sources, and text that is not JSON", () => {
    expect(() => parseBundleManifest(JSON.stringify({ sources: [] }), reader({}))).toThrow("manifest needs `competitor` (host) and `sources`");
    expect(() => parseBundleManifest(JSON.stringify({ competitor: HOST }), reader({}))).toThrow("manifest needs `competitor` (host) and `sources`");
    expect(() => parseBundleManifest("null", reader({}))).toThrow("manifest needs `competitor` (host) and `sources`");
    expect(() => parseBundleManifest("{ not json", reader({}))).toThrow(SyntaxError);
  });
});

describe("readBundleManifest (the command line's --import)", () => {
  it("reads the manifest from disk, each file relative to the manifest, and fails on a file that is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "pmos-bundle-"));
    try {
      mkdirSync(join(dir, "bundle", "texts"), { recursive: true });
      writeFileSync(join(dir, "shared.txt"), "text beside the bundle folder");
      writeFileSync(join(dir, "bundle", "texts", "a.txt"), "page a");
      const path = join(dir, "bundle", "manifest.json");
      const pages = [
        { url: "https://rival.example/a", file: "texts/a.txt" },
        // On our own disk a manifest may point anywhere, as it always could.
        { url: "https://rival.example/b", file: "../shared.txt" },
        { url: "https://rival.example/c", text: "inline" },
      ];
      writeFileSync(path, manifest([{ type: "website", pages }, { type: "carrier-pigeon", pages: [] }]));
      const b = readBundleManifest(path);
      expect(b.host).toBe(HOST);
      expect(b.sources[0].pages.map((p) => p.text)).toEqual(["page a", "text beside the bundle folder", "inline"]);
      expect(b.skipped).toEqual(["carrier-pigeon"]);
      expect(b.missing).toEqual([]);

      writeFileSync(path, manifest([{ type: "website", pages: [{ url: "https://rival.example/x", file: "texts/not-there.txt" }] }]));
      expect(() => readBundleManifest(path)).toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bundleEntryPath", () => {
  it("keeps a path inside the bundle, in one spelling", () => {
    expect(bundleEntryPath("texts/a.txt")).toBe("texts/a.txt");
    expect(bundleEntryPath("./texts//a.txt")).toBe("texts/a.txt");
    expect(bundleEntryPath("texts/../other/a.txt")).toBe("other/a.txt");
    expect(bundleEntryPath("texts\\a.txt")).toBe("texts/a.txt");
  });

  it("refuses a path that is absolute or leaves the bundle", () => {
    for (const file of ["/etc/passwd", "\\\\server\\share\\a.txt", "C:\\texts\\a.txt", "c:/texts/a.txt", "../a.txt", "texts/../../a.txt", "..", "", "."]) {
      expect(bundleEntryPath(file), file).toBeNull();
    }
  });
});

describe("readBundleZip", () => {
  const SOURCES = [
    {
      type: "website",
      pages: [
        { url: "https://rival.example/", file: "texts/home.txt" },
        { url: "https://rival.example/pricing", text: "inline pricing" },
      ],
    },
  ];

  it("reads a bundle whose manifest is at the top of the zip", () => {
    const b = readBundleZip(zip({ "manifest.json": manifest(SOURCES), "texts/home.txt": "home text" }));
    expect(b.host).toBe(HOST);
    expect(b.sources[0].pages.map((p) => p.text)).toEqual(["home text", "inline pricing"]);
    expect(b.missing).toEqual([]);
  });

  it("reads a bundle wrapped in one top-level folder, the paths relative to the manifest", () => {
    const b = readBundleZip(zip({ "rival-2026-11/manifest.json": manifest(SOURCES), "rival-2026-11/texts/home.txt": "home text", "texts/home.txt": "not this one" }));
    expect(b.sources[0].pages[0].text).toBe("home text");
    expect(b.missing).toEqual([]);
  });

  it("ignores what a Mac adds to a zipped folder", () => {
    const b = readBundleZip(
      zip({
        "__MACOSX/rival/._manifest.json": "resource fork",
        "__MACOSX/rival/manifest.json": "not a manifest",
        "rival/.DS_Store": "finder",
        ".DS_Store": "finder",
        "rival/manifest.json": manifest(SOURCES),
        "rival/texts/home.txt": "home text",
      }),
    );
    expect(b.sources[0].pages[0].text).toBe("home text");
  });

  it("reads a manifest saved with a byte-order mark", () => {
    const b = readBundleZip(zip({ "manifest.json": `\uFEFF${manifest(SOURCES)}`, "texts/home.txt": "home text" }));
    expect(b.host).toBe(HOST);
  });

  it("names a file the zip does not hold and keeps its page without text", () => {
    const b = readBundleZip(zip({ "bundle/manifest.json": manifest(SOURCES) }));
    expect(b.missing).toEqual(["texts/home.txt"]);
    expect(b.sources[0].pages.map((p) => p.text)).toEqual(["", "inline pricing"]);
  });

  it("refuses a file path that is absolute or leaves the bundle", () => {
    for (const file of ["../outside.txt", "/etc/passwd", "texts/../../outside.txt"]) {
      const bytes = zip({ "bundle/manifest.json": manifest([{ type: "website", pages: [{ url: "https://rival.example/", file }] }]), "outside.txt": "outside the bundle folder" });
      expect(problemOf(() => readBundleZip(bytes)), file).toBe("bad_path");
    }
  });

  it("refuses a file that is not a zip", () => {
    expect(problemOf(() => readBundleZip(strToU8(manifest(SOURCES))))).toBe("not_zip");
    expect(problemOf(() => readBundleZip(new Uint8Array(0)))).toBe("not_zip");
    // Starts like a zip and is cut short.
    expect(problemOf(() => readBundleZip(zip({ "manifest.json": manifest(SOURCES) }).slice(0, 40)))).toBe("not_zip");
  });

  it("refuses a zip without a manifest, or with a manifest deeper than one folder, or with two bundle folders", () => {
    expect(problemOf(() => readBundleZip(zip({ "texts/home.txt": "home text" })))).toBe("no_manifest");
    expect(problemOf(() => readBundleZip(zip({})))).toBe("no_manifest");
    expect(problemOf(() => readBundleZip(zip({ "a/b/manifest.json": manifest(SOURCES) })))).toBe("no_manifest");
    expect(problemOf(() => readBundleZip(zip({ "a/manifest.json": manifest(SOURCES), "b/manifest.json": manifest(SOURCES) })))).toBe("no_manifest");
    expect(problemOf(() => readBundleZip(zip({ "__MACOSX/manifest.json": manifest(SOURCES) })))).toBe("no_manifest");
  });

  it("refuses a manifest that is not a bundle manifest", () => {
    expect(problemOf(() => readBundleZip(zip({ "manifest.json": "{ not json" })))).toBe("bad_manifest");
    expect(problemOf(() => readBundleZip(zip({ "manifest.json": JSON.stringify({ sources: [] }) })))).toBe("bad_manifest");
  });

  it("unpacks only the manifest and the files it names", () => {
    const bytes = zip({ "manifest.json": manifest(SOURCES), "texts/home.txt": "home text", "not-named.bin": "some other file ".repeat(50) });
    // Break the packed data of the entry the manifest does not name: unpacking it fails, so a reader that touched it would fail too.
    const name = strToU8("not-named.bin");
    const at = bytes.findIndex((_, i) => name.every((c, j) => bytes[i + j] === c));
    bytes[at + name.length] = 0xff;
    expect(() => unzipSync(bytes)).toThrow();
    const b = readBundleZip(bytes);
    expect(b.sources[0].pages[0].text).toBe("home text");
  });

  it("refuses a zip over the size limit", () => {
    const bytes = zip({ "manifest.json": manifest(SOURCES), "texts/home.txt": "home text" });
    expect(problemOf(() => readBundleZip(bytes, { ...LIMITS, maxZipBytes: bytes.length }))).toBe("none");
    expect(problemOf(() => readBundleZip(bytes, { ...LIMITS, maxZipBytes: bytes.length - 1 }))).toBe("too_large");
  });

  it("refuses a zip that unpacks to more than the limit, counting every entry", () => {
    const bytes = zip({ "manifest.json": manifest(SOURCES), "texts/home.txt": "home text", "padding.txt": "a".repeat(10_000) });
    expect(bytes.length).toBeLessThan(2_000);
    expect(problemOf(() => readBundleZip(bytes, { ...LIMITS, maxUnpackedBytes: 5_000 }))).toBe("too_large");
    expect(problemOf(() => readBundleZip(bytes, { ...LIMITS, maxUnpackedBytes: 20_000 }))).toBe("none");
  });

  it("refuses a zip with more entries than the limit", () => {
    const bytes = zip({ "manifest.json": manifest(SOURCES), "texts/home.txt": "home text", "texts/extra.txt": "extra" });
    expect(problemOf(() => readBundleZip(bytes, { ...LIMITS, maxEntries: 3 }))).toBe("none");
    expect(problemOf(() => readBundleZip(bytes, { ...LIMITS, maxEntries: 2 }))).toBe("too_large");
  });

  it("holds the limits the upload states", () => {
    expect(MAX_ZIP_BYTES).toBe(30 * 1024 * 1024);
    expect(MAX_UNPACKED_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_ZIP_ENTRIES).toBe(5_000);
    const tooMany = zipSync(Object.fromEntries(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => [`f${i}.txt`, new Uint8Array(0)])));
    expect(problemOf(() => readBundleZip(tooMany))).toBe("too_large");
  });
});
