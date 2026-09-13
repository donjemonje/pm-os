import { db } from "../db";
import { nextChipColor } from "./colors";

/**
 * Catalog rows created before colors existed (or by paths that don't pick
 * one) get the next least-used palette color, once — so every product line
 * and customer always renders in its own tint without anyone configuring it.
 */
export async function ensureCatalogColors(workspaceId: string): Promise<void> {
  const [lines, customers] = await Promise.all([
    db.productLine.findMany({
      where: { workspaceId },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, color: true },
    }),
    db.customer.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { id: true, color: true },
    }),
  ]);
  const lineColors = lines.map((l) => l.color);
  for (const l of lines) {
    if (l.color) continue;
    const color = nextChipColor(lineColors);
    lineColors.push(color);
    await db.productLine.update({ where: { id: l.id }, data: { color } });
  }
  const customerColors = customers.map((c) => c.color);
  for (const c of customers) {
    if (c.color) continue;
    const color = nextChipColor(customerColors);
    customerColors.push(color);
    await db.customer.update({ where: { id: c.id }, data: { color } });
  }
}
