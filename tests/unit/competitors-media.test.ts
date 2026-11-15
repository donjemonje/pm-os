import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mediaDir, mediaFilePath, mediaUrl } from "@/lib/competitors/media";

/** The media store resolves paths only inside COMPETITORS_MEDIA_DIR (story 4, P-06 at unit level). */
describe("competitors media store", () => {
  let dir: string;
  const prev = process.env.COMPETITORS_MEDIA_DIR;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cmp-media-"));
    mkdirSync(join(dir, "acme.com"));
    writeFileSync(join(dir, "acme.com", "home.png"), "png");
    writeFileSync(join(dir, "..", "outside-cmp.png"), "png");
    process.env.COMPETITORS_MEDIA_DIR = dir;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.COMPETITORS_MEDIA_DIR;
    else process.env.COMPETITORS_MEDIA_DIR = prev;
  });

  it("serves a stored file by its relative path", () => {
    expect(mediaDir()).toBe(dir);
    expect(mediaFilePath("acme.com/home.png")).toBe(join(dir, "acme.com", "home.png"));
  });

  it("refuses every escape and every `..`, even one that lands inside the store", () => {
    for (const bad of ["../outside-cmp.png", "acme.com/../../outside-cmp.png", "../acme.com/home.png", "acme.com\\..\\..\\outside-cmp.png", "/etc/hosts", join(dir, "acme.com", "home.png"), "", "acme.com/missing.png"]) {
      expect(mediaFilePath(bad), bad).toBeNull();
    }
  });

  it("is off without a store", () => {
    process.env.COMPETITORS_MEDIA_DIR = join(dir, "does-not-exist");
    expect(mediaDir()).toBeNull();
    expect(mediaFilePath("acme.com/home.png")).toBeNull();
    process.env.COMPETITORS_MEDIA_DIR = dir;
  });

  it("builds the client URL", () => {
    expect(mediaUrl("acme.com/a b.png")).toBe("/api/competitors/media?p=acme.com%2Fa%20b.png");
  });
});
