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
  bg: string;
  fg: string;
}

export const CHIP_PALETTE: readonly ChipColor[] = [
  // Row 1 — blues / teals
  { id: "blue", label: "Bright blue", bg: "rgba(0,115,234,.16)", fg: "#0a5bc4" },
  { id: "navy", label: "Navy", bg: "rgba(34,80,160,.18)", fg: "#1f3f86" },
  { id: "sky", label: "Sky", bg: "rgba(102,204,255,.26)", fg: "#0b6aa0" },
  { id: "cyan", label: "Chili blue", bg: "rgba(38,190,230,.22)", fg: "#0b6e8f" },
  { id: "teal", label: "Aquamarine", bg: "rgba(78,204,200,.24)", fg: "#0f7a6a" },
  { id: "steel", label: "Steel", bg: "rgba(74,120,160,.2)", fg: "#2f5676" },
  // Row 2 — greens / yellows
  { id: "green", label: "Done green", bg: "rgba(0,200,117,.2)", fg: "#0f7a3f" },
  { id: "grass", label: "Grass", bg: "rgba(3,127,76,.2)", fg: "#0a6a3f" },
  { id: "mint", label: "Bright green", bg: "rgba(156,217,74,.3)", fg: "#4a7a0f" },
  { id: "lime", label: "Saladish", bg: "rgba(202,220,60,.34)", fg: "#5a6e12" },
  { id: "yellow", label: "Egg yolk", bg: "rgba(255,203,0,.3)", fg: "#8a6200" },
  { id: "amber", label: "Working orange", bg: "rgba(253,171,61,.28)", fg: "#8a5a00" },
  // Row 3 — oranges / reds / pinks
  { id: "orange", label: "Dark orange", bg: "rgba(255,100,43,.22)", fg: "#9a3f10" },
  { id: "peach", label: "Peach", bg: "rgba(255,173,173,.34)", fg: "#a0433a" },
  { id: "red", label: "Stuck red", bg: "rgba(226,68,92,.2)", fg: "#a32a2a" },
  { id: "crimson", label: "Dark red", bg: "rgba(189,52,56,.22)", fg: "#8a1f23" },
  { id: "pink", label: "Lipstick", bg: "rgba(255,90,145,.22)", fg: "#a0246a" },
  { id: "magenta", label: "Sofia pink", bg: "rgba(255,21,142,.18)", fg: "#9a0f5e" },
  // Row 4 — purples / neutrals
  { id: "purple", label: "Purple", bg: "rgba(162,93,220,.22)", fg: "#5e2d9a" },
  { id: "violet", label: "Dark purple", bg: "rgba(120,75,209,.22)", fg: "#4a2d8f" },
  { id: "indigo", label: "Indigo", bg: "rgba(87,98,220,.22)", fg: "#3f47b8" },
  { id: "lavender", label: "Lavender", bg: "rgba(168,152,235,.3)", fg: "#5a4aa0" },
  { id: "brown", label: "Coffee", bg: "rgba(173,120,80,.24)", fg: "#6e4a2a" },
  { id: "slate", label: "Slate", bg: "#e6eaf1", fg: "#4a5b74" },
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

/** Neutral defaults for chips whose catalog entry has no color (or isn't cataloged). */
export const PRODUCT_CHIP_DEFAULT: ChipColor = {
  id: "",
  label: "",
  bg: "var(--background)",
  fg: "var(--primary)",
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
