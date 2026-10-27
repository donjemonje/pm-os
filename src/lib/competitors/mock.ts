import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

/**
 * Demo/mock profile data for a competitor, read from a folder OUTSIDE the app
 * repo (`COMPETITORS_MOCK_DIR`, e.g. pmos-office/mock/competitors — gitignored
 * there). Lets the Profile page show every section of the C2 design (timeline,
 * people, UI gallery, deep dives, risk) before the sources that produce them
 * exist. Never read in production; when the env is unset or the file is
 * missing the profile shows only real data.
 *
 * File: `<dir>/<host>.json` (shape below); images under `<dir>/<host>/…`,
 * served by /api/competitors/mock-asset.
 */

export type MockTag = { label: string; kind: "int" | "pos" | "gtm" };
export type MockFact = { label: string; value: string; source: string; tone?: "warn" };
export type MockTimelineEvent = {
  date: string;
  title: string;
  type: "company" | "funding" | "domain" | "capability" | "hr" | "website";
  projected?: boolean;
  confidence?: number;
};
export type MockProduct = { code: string; name: string; domain: string; since?: string; tier?: string; capabilities: string[] };
export type MockMedia = { label: string; kind: "Screenshot" | "Video" | "Tutorial" | "Image"; caption: string; image?: string };
export type MockEvidence = { kind: string; kindTone?: "int" | "pos" | "gtm"; text: string; date: string };
export type MockDeepDive = {
  summary: string;
  sources: { label: string; tone?: "int" | "pos" | "gtm" }[];
  scope?: string;
  packaging?: string;
  confidence?: string;
  media?: MockMedia[];
  evidence?: MockEvidence[];
  risk?: { level: "high" | "medium" | "low"; text: string };
  differentiation?: string;
  standing?: { ideaTitle?: string; evidenceCount?: number };
};
export type MockChange = { title: string; source: string; date: string; impact: "high" | "medium" | "low" };
export type MockGalleryItem = { label: string; image?: string; kind?: string };

export interface MockProfile {
  host: string;
  about?: { ownership?: string; hq?: string; founded?: number; people?: string };
  tags?: MockTag[];
  risk?: { score: number; level: "high" | "medium" | "low"; note: string };
  facts?: MockFact[];
  timeline?: MockTimelineEvent[];
  products?: MockProduct[];
  deepDives?: Record<string, MockDeepDive>;
  changes?: MockChange[];
  people?: { window: string; hires: { team: string; n: number }[]; left?: { n: number; note: string }; leadership?: string };
  gallery?: MockGalleryItem[];
  sources?: { label: string; n: number | string }[];
  lastFullScan?: string;
}

export function mockDir(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const d = process.env.COMPETITORS_MOCK_DIR?.trim();
  return d && existsSync(d) ? d : null;
}

export function readMockProfile(host: string): MockProfile | null {
  const dir = mockDir();
  if (!dir) return null;
  const file = join(dir, `${host}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as MockProfile;
    return parsed && typeof parsed === "object" ? { ...parsed, host } : null;
  } catch {
    return null;
  }
}

/** Resolve a mock asset path safely inside the mock dir (no traversal). */
export function mockAssetPath(rel: string): string | null {
  const dir = mockDir();
  if (!dir) return null;
  const clean = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  if (clean.includes("..")) return null;
  const full = join(dir, clean);
  if (!full.startsWith(dir) || !existsSync(full)) return null;
  return full;
}

/** URL the client uses for a mock image. */
export function mockAssetUrl(rel: string): string {
  return `/api/competitors/mock-asset?f=${encodeURIComponent(rel)}`;
}
