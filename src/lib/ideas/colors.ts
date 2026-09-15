import type { CSSProperties } from "react";

/**
 * The curated chip palette for catalog entries (product lines, customers):
 * twelve tints that stay legible on white and next to each other, so every
 * organization's chips read as one system. Catalog rows store the palette
 * id, never a hex — "consistent across orgs" is the whole point.
 */
export interface ChipColor {
  id: string;
  label: string;
  bg: string;
  fg: string;
}

export const CHIP_PALETTE: readonly ChipColor[] = [
  { id: "blue", label: "Blue", bg: "rgba(122,167,255,.18)", fg: "#2f5fc4" },
  { id: "teal", label: "Teal", bg: "rgba(47,160,143,.16)", fg: "#0f7a6a" },
  { id: "green", label: "Green", bg: "rgba(88,176,96,.18)", fg: "#2a7a34" },
  { id: "lime", label: "Lime", bg: "rgba(160,190,60,.22)", fg: "#5a6e12" },
  { id: "amber", label: "Amber", bg: "rgba(240,180,60,.22)", fg: "#8a5a00" },
  { id: "orange", label: "Orange", bg: "rgba(245,140,70,.2)", fg: "#9a4a10" },
  { id: "red", label: "Red", bg: "rgba(230,90,90,.16)", fg: "#a32a2a" },
  { id: "pink", label: "Pink", bg: "rgba(230,110,170,.18)", fg: "#a0246a" },
  { id: "indigo", label: "Indigo", bg: "rgba(110,120,230,.18)", fg: "#3f47b8" },
  { id: "cyan", label: "Cyan", bg: "rgba(60,180,220,.18)", fg: "#0b6e8f" },
  { id: "brown", label: "Brown", bg: "rgba(170,120,80,.18)", fg: "#6e4a2a" },
  { id: "slate", label: "Slate", bg: "#eef1f6", fg: "#4a5b74" },
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
export const CUSTOMER_CHIP_DEFAULT: ChipColor = CHIP_PALETTE[1];

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
