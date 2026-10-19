import type { CSSProperties } from "react";

/**
 * The curated chip palette for catalog entries (product lines, customers):
 * twenty-four tints in the monday.com spirit (livelier, more choice —
 * Daniel 2026-10-19) that stay legible on white and next to each other, so
 * every organization's chips read as one system. Catalog rows store the
 * palette id, never a hex. The original twelve ids are kept (stored rows),
 * only retinted.
 */
export interface ChipColor {
  id: string;
  label: string;
  /** Chip tint (translucent) and text color — legible on white. */
  bg: string;
  fg: string;
  /** The solid, saturated color shown in pickers and dots (monday.com hexes). */
  swatch: string;
}

export const CHIP_PALETTE: readonly ChipColor[] = [
  // Blues — light to dark
  { id: "sky", label: "Chili blue", swatch: "#66ccff", bg: "rgba(102,204,255,.28)", fg: "#0b6aa0" },
  { id: "teal", label: "Aquamarine", swatch: "#4eccc6", bg: "rgba(78,204,198,.26)", fg: "#0f7a6a" },
  { id: "steel", label: "River", swatch: "#68a1bd", bg: "rgba(104,161,189,.26)", fg: "#2f5676" },
  { id: "cyan", label: "Dark blue", swatch: "#0086c0", bg: "rgba(0,134,192,.2)", fg: "#0b6e8f" },
  { id: "blue", label: "Bright blue", swatch: "#0073ea", bg: "rgba(0,115,234,.16)", fg: "#0a5bc4" },
  { id: "navy", label: "Navy", swatch: "#225091", bg: "rgba(34,80,145,.18)", fg: "#1f3f86" },
  // Greens and yellows — light to dark
  { id: "mint", label: "Bright green", swatch: "#9cd326", bg: "rgba(156,211,38,.3)", fg: "#4a7a0f" },
  { id: "green", label: "Done green", swatch: "#00c875", bg: "rgba(0,200,117,.22)", fg: "#0f7a3f" },
  { id: "grass", label: "Grass green", swatch: "#037f4c", bg: "rgba(3,127,76,.2)", fg: "#0a6a3f" },
  { id: "lime", label: "Saladish", swatch: "#cab641", bg: "rgba(202,182,65,.32)", fg: "#6a5e12" },
  { id: "yellow", label: "Egg yolk", swatch: "#ffcb00", bg: "rgba(255,203,0,.3)", fg: "#8a6200" },
  { id: "amber", label: "Working orange", swatch: "#fdab3d", bg: "rgba(253,171,61,.3)", fg: "#8a5a00" },
  // Oranges, reds and pinks — light to dark
  { id: "peach", label: "Sunset", swatch: "#ff7575", bg: "rgba(255,117,117,.26)", fg: "#a0433a" },
  { id: "orange", label: "Dark orange", swatch: "#ff642e", bg: "rgba(255,100,46,.22)", fg: "#9a3f10" },
  { id: "red", label: "Stuck red", swatch: "#e2445c", bg: "rgba(226,68,92,.2)", fg: "#a32a2a" },
  { id: "crimson", label: "Dark red", swatch: "#bb3354", bg: "rgba(187,51,84,.22)", fg: "#8a1f3a" },
  { id: "pink", label: "Lipstick", swatch: "#ff5ac4", bg: "rgba(255,90,196,.22)", fg: "#a0246a" },
  { id: "magenta", label: "Sofia pink", swatch: "#ff158a", bg: "rgba(255,21,138,.18)", fg: "#9a0f5e" },
  // Purples and neutrals — light to dark
  { id: "purple", label: "Purple", swatch: "#a25ddc", bg: "rgba(162,93,220,.22)", fg: "#5e2d9a" },
  { id: "violet", label: "Dark purple", swatch: "#784bd1", bg: "rgba(120,75,209,.22)", fg: "#4a2d8f" },
  { id: "indigo", label: "Indigo", swatch: "#5559df", bg: "rgba(85,89,223,.22)", fg: "#3f47b8" },
  { id: "lavender", label: "Berry", swatch: "#7e3b8a", bg: "rgba(126,59,138,.2)", fg: "#5a2a66" },
  { id: "brown", label: "Brown", swatch: "#7f5347", bg: "rgba(127,83,71,.22)", fg: "#6e4a2a" },
  { id: "slate", label: "American gray", swatch: "#808080", bg: "#e6eaf1", fg: "#4a5b74" },
];

const BY_ID = new Map(CHIP_PALETTE.map((c) => [c.id, c]));

export function isChipColorId(v: unknown): v is string {
  return typeof v === "string" && BY_ID.has(v);
}

/** Inline style for a chip carrying a palette color; `fallback` when the entry has none. */
export function chipStyle(
  colorId: string | null | undefined,
  fallback: ChipColor,
): CSSProperties {
  const c = (colorId && BY_ID.get(colorId)) || fallback;
  return { background: c.bg, color: c.fg };
}

/** The solid swatch color for a palette id; `fallback`'s when the entry has none. */
export function swatchColor(colorId: string | null | undefined, fallback: ChipColor): string {
  return ((colorId && BY_ID.get(colorId)) || fallback).swatch;
}

/** Neutral defaults for chips whose catalog entry has no color (or isn't cataloged). */
export const PRODUCT_CHIP_DEFAULT: ChipColor = {
  id: "",
  label: "",
  bg: "var(--background)",
  fg: "var(--primary)",
  swatch: "var(--primary)",
};
export const CUSTOMER_CHIP_DEFAULT: ChipColor = BY_ID.get("teal")!;

/** The least-used palette color (ties → palette order) — new rows get one automatically. */
export function nextChipColor(used: (string | null | undefined)[]): string {
  const counts = new Map(CHIP_PALETTE.map((c) => [c.id, 0]));
  for (const u of used) if (u && counts.has(u)) counts.set(u, (counts.get(u) ?? 0) + 1);
  let best = CHIP_PALETTE[0].id;
  let bestCount = Infinity;
  for (const c of CHIP_PALETTE) {
    const n = counts.get(c.id) ?? 0;
    if (n < bestCount) {
      best = c.id;
      bestCount = n;
    }
  }
  return best;
}

/**
 * A stable palette color for names that carry none in the catalog (e.g.
 * reporters): the same name always gets the same tint, on every screen.
 */
export function paletteColorFor(name: string): ChipColor {
  let h = 7;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHIP_PALETTE[h % CHIP_PALETTE.length];
}
